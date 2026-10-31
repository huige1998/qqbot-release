'use strict';
const fs = require('fs');
const path = require('path');
/*
 * QQ 群自动回复机器人（配合 NapCatQQ / OneBot v11 使用）
 * 功能：群里发「搜 片名」或「找 片名」，机器人自动去云端后端搜索，
 *       已转存过的直接回分享链接，没转存过的自动提交转存、完成后把链接发回群里。
 * 依赖：无第三方包，只用 Node.js 22 自带的 WebSocket 和 fetch。
 *       （NapCat 一键包里自带的 node.exe 就是 22 版，直接用它运行本文件。）
 */

const BACKEND = (process.env.PAN_BACKEND || 'https://pan-search-5160265-1520428323.ap-shanghai.run.tcloudbase.com').replace(/\/+$/, '');
const WS_URL = process.env.QQBOT_WS_URL || 'ws://127.0.0.1:3001';
const GROUP_COOLDOWN_MS = 10 * 1000;                       // 同一个群两次搜索的最小间隔
const POLL_INTERVAL_MS = Number(process.env.QQBOT_POLL_MS || 5000);            // 转存轮询间隔
const POLL_TIMEOUT_MS = Number(process.env.QQBOT_POLL_TIMEOUT_MS || 120000);   // 转存最长等待
const SEARCH_TIMEOUT_MS = 90000;                           // 搜索接口偶尔较慢，给足时间
const MAX_KEYWORD_LEN = 60;
const OWNER_ID = '731121979';                              // 主人主号 QQ，只有他能触发云更新
// 云更新共享目录：手机模块里容器内是 /shared（宿主机 /data/qqbot/shared 的 bind 挂载）；
// 其他环境可用环境变量 QQBOT_SHARED 指定。访问全部 try/catch，目录不存在时更新命令会明确回复用不了。
const SHARED_DIRS = [process.env.QQBOT_SHARED || '/shared', '/data/qqbot/shared'];

function log(...args) {
  console.log(new Date().toLocaleString('zh-CN', { hour12: false }), ...args);
}

if (typeof WebSocket === 'undefined') {
  console.error('当前 Node 版本没有内置 WebSocket，请使用一键包自带的 node.exe（22 版）运行。');
  process.exit(1);
}

/* ---------------- 云端后端调用 ---------------- */

async function fetchJson(url, options = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return {}; }
  } finally {
    clearTimeout(timer);
  }
}

async function searchItems(keyword) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await fetchJson(`${BACKEND}/api/search?q=${encodeURIComponent(keyword)}`, {}, SEARCH_TIMEOUT_MS);
      if (Array.isArray(data)) return data;
      return data.items || data.results || [];
    } catch (e) {
      lastErr = e;
      const cause = (e && e.cause && (e.cause.code || e.cause.message)) || '';
      log(`搜索第 ${attempt} 次尝试失败:`, e.message, cause);
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 4000));
    }
  }
  throw lastErr;
}

async function submitTask(ref) {
  return fetchJson(`${BACKEND}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref, requester: 'qq-bot' }),
  }, 30000);
}

async function getTask(id) {
  const data = await fetchJson(`${BACKEND}/api/tasks/${encodeURIComponent(id)}`, {}, 15000);
  return (data && data.task) || data || {};
}

const itemTitle = (item, fallback) => (item && (item.title || item.name)) || fallback;
const itemShare = (item) => item && (item.my_share || item.share_url || '');

/* ---------------- OneBot 连接 ---------------- */

let ws = null;
let echoSeq = 0;
const lastSearchAt = new Map(); // group_id -> timestamp

function sendGroupMsg(groupId, text) {
  if (!ws || ws.readyState !== 1) { log('WS 未连接，丢弃一条待发消息:', text); return; }
  ws.send(JSON.stringify({
    action: 'send_group_msg',
    params: { group_id: groupId, message: text },
    echo: 'bot' + (++echoSeq),
  }));
}

function messageText(ev) {
  if (Array.isArray(ev.message)) {
    return ev.message.filter(s => s && s.type === 'text').map(s => (s.data && s.data.text) || '').join('').trim();
  }
  const raw = typeof ev.raw_message === 'string' ? ev.raw_message
    : (typeof ev.message === 'string' ? ev.message : '');
  return raw.replace(/\[CQ:[^\]]*\]/g, '').trim();
}

/* ---------------- 业务流程 ---------------- */

async function handleSearch(groupId, keyword) {
  sendGroupMsg(groupId, `正在找《${keyword}》，找到后会自动转存，好了就把链接发到群里。`);
  let items;
  try {
    items = await searchItems(keyword);
  } catch (e) {
    log('搜索接口出错:', e.message);
    sendGroupMsg(groupId, '服务暂时开小差了，过一会儿再发一次试试。');
    return;
  }
  if (!items.length) {
    sendGroupMsg(groupId, `没找到《${keyword}》，换个名字或者加上年份再试试。`);
    return;
  }
  // 已经转存过的：直接回现成链接
  const ready = items.find(i => itemShare(i));
  if (ready) {
    sendGroupMsg(groupId, `《${itemTitle(ready, keyword)}》\n${itemShare(ready)}`);
    return;
  }
  // 提交转存：优先夸克（后端目前只有夸克能真正转存成功），否则用第一条
  const cand = items.find(i => i && i.ref && i.drive === 'quark') || items.find(i => i && i.ref) || items[0];
  if (!cand || !cand.ref) {
    sendGroupMsg(groupId, `没找到《${keyword}》可用的资源，换个名字再试试。`);
    return;
  }
  const title = itemTitle(cand, keyword);
  let created;
  try {
    created = await submitTask(cand.ref);
  } catch (e) {
    log('提交转存出错:', e.message);
    sendGroupMsg(groupId, '服务暂时开小差了，过一会儿再发一次试试。');
    return;
  }
  if (created && created.filtered) {
    sendGroupMsg(groupId, `《${keyword}》这类内容被过滤了，换一部试试。`);
    return;
  }
  const task = (created && created.task) || created || {};
  if (!task.id) {
    sendGroupMsg(groupId, `《${title}》提交转存失败了，稍后再试试。`);
    return;
  }
  if (task.status === 'done' && task.share_url) {
    sendGroupMsg(groupId, `《${title}》\n${task.share_url}`);
    return;
  }
  // 轮询等转存完成
  let sawDoneNoLink = false;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    let t;
    try { t = await getTask(task.id); } catch { continue; }
    if (t.status === 'done' && t.share_url) {
      sendGroupMsg(groupId, `《${title}》转存好了\n${t.share_url}`);
      return;
    }
    if (t.status === 'done' || t.status === 'done_pending_share') {
      // 转存已完成但分享链接还没生成（后端要晚几秒），继续等，别抢跑下结论
      sawDoneNoLink = true;
    }
    if (['failed', 'error', 'blocked', 'cancelled'].includes(t.status)) {
      sendGroupMsg(groupId, `《${title}》转存失败了，换一部或者稍后再试。`);
      return;
    }
  }
  if (sawDoneNoLink) {
    sendGroupMsg(groupId, `《${title}》已经转存好了，但这次没生成新链接，去网页版看看：\n${BACKEND}`);
    return;
  }
  sendGroupMsg(groupId, `《${title}》还在转存中，稍后打开网页版就能看到链接：\n${BACKEND}`);
}

/* ---------------- 云更新（手机模块专用，宿主机 updater.sh 配合） ----------------
 * 群里主人发「更新」/「检查更新」：往共享目录写 update.request，
 * 宿主机的更新守护进程看到后去云端拉 manifest 检查；结果写回 update.status，
 * 这里轮询状态文件再把结果发回群里。其他人发这个命令一律静默忽略。 */

function sharedFile(name) {
  for (const dir of SHARED_DIRS) {
    try {
      if (fs.existsSync(dir)) return path.join(dir, name);
    } catch { /* 换下一个候选目录 */ }
  }
  return path.join(SHARED_DIRS[0], name);
}

function readShared(name) {
  try { return fs.readFileSync(sharedFile(name), 'utf8'); } catch { return ''; }
}

function formatUpdateResult(st) {
  const bv = st.to_bot || st.from_bot || '?';
  switch (st.result) {
    case 'latest':
      return `已经是最新版了（机器人 v${bv}），不用更新。`;
    case 'updated':
      if (st.to_bot != null && st.from_bot != null && st.to_bot !== st.from_bot) {
        return `已更新到机器人 v${st.to_bot}，重启完成，新版生效了。`;
      }
      return '云更新完成，新版已生效。' + (st.detail ? `（${st.detail}）` : '');
    case 'updated_restarting':
      return `已更新到机器人 v${bv}，正在重启，马上就好。`;
    case 'rolled_back':
      return '新版机器人启动不太对劲，已经自动回滚到旧版了，照常能用。详情在手机 qqbot/logs/update.log 里。';
    case 'needs_module_update':
      return '这次更新动到模块本体了：先去 Magisk 里给「QQ机器人」模块点更新，再重启一次手机。';
    case 'failed':
      return '更新没成功，旧版照常运行。详情在手机 qqbot/logs/update.log 里。';
    default:
      return '检查更新完成：' + (st.detail || st.result || '未知结果');
  }
}

async function handleUpdate(groupId) {
  const reqPath = sharedFile('update.request');
  const before = readShared('update.status');
  try {
    fs.writeFileSync(reqPath, String(Date.now()));
  } catch (e) {
    log('写 update.request 失败:', e.message);
    sendGroupMsg(groupId, '云更新还没就绪（共享目录不可用），可能模块还没装好，先这样用着吧。');
    return;
  }
  sendGroupMsg(groupId, '正在检查更新，稍等…');
  const deadline = Date.now() + 100000;
  let baseline = before;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000));
    const now = readShared('update.status');
    if (!now || now === baseline) continue;
    let st;
    try { st = JSON.parse(now); } catch { baseline = now; continue; }
    if (st.result === 'checking') { baseline = now; continue; }  // 还在检查，继续等最终结果
    sendGroupMsg(groupId, formatUpdateResult(st));
    return;
  }
  sendGroupMsg(groupId, '检查更新超时了，可能是网络不好，稍后再发一次「更新」试试。');
}

function onEvent(ev) {
  if (!ev || ev.post_type !== 'message' || ev.message_type !== 'group') return;
  if (ev.user_id != null && ev.self_id != null && String(ev.user_id) === String(ev.self_id)) return; // 忽略自己发的
  const groupId = ev.group_id;
  const text = messageText(ev);
  if (!text) return;

  if (text === '帮助') {
    sendGroupMsg(groupId, '发「搜 片名」我就帮你找资源，例如：搜 甄嬛传\n找到后会自动转存，并把分享链接发回群里。');
    return;
  }
  if (text === '更新' || text === '检查更新') {
    if (String(ev.user_id) !== OWNER_ID) return; // 只有主人能触发，别人静默忽略
    handleUpdate(groupId).catch(e => log('处理更新命令出错:', e && e.message));
    return;
  }
  const m = text.match(/^(?:搜|找)\s*(.+)$/s);
  if (!m) return;
  const keyword = m[1].trim();
  if (!keyword || keyword.length > MAX_KEYWORD_LEN) return;

  const now = Date.now();
  if (now - (lastSearchAt.get(groupId) || 0) < GROUP_COOLDOWN_MS) return; // 冷却中，静默忽略防刷屏
  lastSearchAt.set(groupId, now);

  handleSearch(groupId, keyword).catch(e => log('处理搜索出错:', e && e.message));
}

function connect() {
  log('正在连接 NapCat:', WS_URL);
  ws = new WebSocket(WS_URL);
  ws.addEventListener('open', () => log('已连上 NapCat，机器人上线。等群里发「搜 片名」即可。'));
  ws.addEventListener('message', (e) => {
    try { onEvent(JSON.parse(typeof e.data === 'string' ? e.data : '')); } catch { /* 非 JSON 数据忽略 */ }
  });
  ws.addEventListener('close', () => { log('连接断开，5 秒后重连…'); setTimeout(connect, 5000); });
  ws.addEventListener('error', () => { try { ws.close(); } catch { /* 忽略 */ } });
}

log('机器人启动，后端地址:', BACKEND);
connect();
