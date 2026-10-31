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
const EMPTY_RETRY_MAX = 2;                                 // 搜索返回空结果时，最多再重试几次
const EMPTY_RETRY_GAP_MS = Number(process.env.QQBOT_EMPTY_RETRY_MS || 6000); // 空结果重试的间隔
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

/* ---------------- 单实例锁 ----------------
 * 2026-10-31 真机事故：云更新重启 bot 时和看门狗的重启撞在一起，两个 bot.js
 * 进程同时活了下来（bot.log 里两条「机器人启动」只差 1 秒），群消息被各回一遍。
 * v3 的 message_id 去重是进程级的，管不了两个进程，所以在启动最前面加文件锁：
 * 同一台机器只允许一个 bot.js 持有锁，第二个实例直接退出。
 * 锁文件默认在 bot.js 同目录（手机上即 /root/qqbot/bot.lock，与 bot.log 同目录；
 * Windows 一键包里就是 bot.js 旁边），可用环境变量 QQBOT_LOCK_PATH 覆盖。
 * 注意（pid 回收的极小概率）：失效锁里记的旧 pid 可能被系统分给无关进程，
 * 那时后来者会误判「已有实例在运行」而退出——看门狗 5 秒后会再拉起重试，
 * 最坏只是晚一轮接管，绝不会出现双实例。 */
const LOCK_PATH = process.env.QQBOT_LOCK_PATH || path.join(__dirname, 'bot.lock');
let lockFd = null; // 非 null 表示本进程是锁持有者

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); } // EPERM = 进程在，只是无权发信号
}

function acquireInstanceLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(LOCK_PATH, 'wx'); // O_EXCL 原子创建，已存在直接抛 EEXIST
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        let holder = NaN;
        try { holder = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10); } catch { /* 读不到按失效锁处理 */ }
        if (pidAlive(holder)) {
          log(`已有实例在运行 (pid ${holder})，本实例退出`);
          process.exit(0);
        }
        // 失效锁（持有者已死或内容不可解析）：删掉重试一次，接管过来
        try { fs.unlinkSync(LOCK_PATH); } catch { /* 别人先删了也无妨 */ }
        continue;
      }
      // 其他错误（如目录不可写）：别把机器人挡在门外，记一笔继续无锁启动
      log('单实例锁创建失败（继续无锁启动）:', e && e.message);
      return;
    }
    try { fs.writeSync(fd, String(process.pid)); } catch { /* 写不进不影响占锁本身 */ }
    lockFd = fd;
    return;
  }
  // 两次都没抢到：刚被另一实例接管，按「已有实例」处理
  log('单实例锁已被其他实例接管，本实例退出');
  process.exit(0);
}

function releaseInstanceLock() {
  if (lockFd == null) return; // 不是持有者时绝不能动锁文件（那是别人的锁）
  try { fs.closeSync(lockFd); } catch { /* 忽略 */ }
  lockFd = null;
  try { fs.unlinkSync(LOCK_PATH); } catch { /* 忽略 */ }
}
// SIGKILL 无法清理，锁文件会残留——但里面记的 pid 已死，下一个实例会走失效接管，自愈。
process.on('exit', releaseInstanceLock);
process.on('SIGTERM', () => { releaseInstanceLock(); process.exit(0); });
process.on('SIGINT', () => { releaseInstanceLock(); process.exit(0); });

acquireInstanceLock();

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

/* 选片打分：群友搜的基本是影视剧，但结果里常混同名小说/电子书，按顺序拿
 * 第一条会转错（实例：搜《老九门》转成了小说番外合集）。带集数/清晰度/
 * 影视标记的加分，带小说/电子书标记的重扣分，片名完整包含查询词也加分；
 * 同分保持后端给的顺序（后端已按时间倒序，新的在前）。 */
function isNovelName(name) {
  return /小说|电子书|精校|全本|有声/.test(name) || /txt/i.test(name) || /作者\s*[:：]/.test(name);
}

function isNovelItem(item) {
  return isNovelName(itemTitle(item, ''));
}

function scoreItem(item, keyword) {
  const name = itemTitle(item, '');
  if (!name) return 0;
  let s = 0;
  if (keyword && name.includes(keyword)) s += 3;                    // 片名完整包含查询词
  if (/更新至|全\s*\d+\s*集|第\s*\d+\s*集/.test(name)) s += 3;       // 集数标记（影视剧典型）
  if (/S\d{1,2}E\d{1,3}/i.test(name)) s += 3;                       // S01E01 这类标记
  if (/4K|2160|1080/.test(name)) s += 2;                            // 清晰度标记
  if (/电视剧|电影|剧集/.test(name)) s += 2;
  if (name.includes('集')) s += 1;                                  // 弱信号（“合集”也会命中，只给 1 分）
  if (isNovelName(name)) s -= 6;                                    // 小说/电子书/有声书标记，重扣
  return s;
}

// 在候选池里挑分数最高的；同分保持原顺序（严格大于才替换）
function pickBest(pool, keyword) {
  let best = null, bestScore = -Infinity;
  for (const it of pool) {
    const sc = scoreItem(it, keyword);
    if (sc > bestScore) { best = it; bestScore = sc; }
  }
  return { item: best, score: bestScore };
}

/* ---------------- OneBot 连接 ---------------- */

let ws = null;
let echoSeq = 0;
let connGen = 0;            // 连接代数：每次 connect 自增，旧连接的迟到事件一律作废
let reconnectTimer = null;  // 保证同一时刻最多挂着一个重连定时器
const lastSearchAt = new Map(); // group_id -> timestamp

/* 消息去重：OneBot/NapCat 偶尔会把同一条消息事件重复投递（断线重连补发、
 * 新旧双连接各推一份等）。按 message_id 记住最近处理过的消息，重复投递
 * 直接丢弃，保证一条群消息最多触发一次流程、「正在找」最多发一次。
 * （原有的 10 秒群冷却只能挡住紧挨着的重复，挡不住隔一会儿的重投递，
 * 也管不到「帮助」「更新」这两条没有冷却的分支。） */
const SEEN_MSG_MAX = 200;                  // 最多记住最近 200 条 message_id
const SEEN_MSG_TTL_MS = 10 * 60 * 1000;    // 超过 10 分钟的记录视为过期，可再处理
const seenMsgAt = new Map();               // message_id(String) -> 首次处理时间戳

function seenMessage(id) {
  if (id == null || id === '') return false;
  const key = String(id);
  const now = Date.now();
  const prev = seenMsgAt.get(key);
  if (prev != null && now - prev < SEEN_MSG_TTL_MS) return true;
  seenMsgAt.set(key, now);
  while (seenMsgAt.size > SEEN_MSG_MAX) {
    seenMsgAt.delete(seenMsgAt.keys().next().value); // Map 按插入顺序迭代，先丢最旧的
  }
  return false;
}

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
    // 后端在网关抖动/半挂时可能直接返回空结果而不是报错（搜索内部有多源
    // 降级，最坏路径就是空数组）。2026-10-31 23:24 实测：后端短暂塌方期间
    // 搜《老九门》被误报「没找到」，其实资源一直都在。所以空结果先别下
    // 结论：隔几秒把搜索重跑两次，都空了才回「没找到」。重试只重跑搜索
    // 本身，群里不会多发任何消息。
    for (let retry = 1; retry <= EMPTY_RETRY_MAX && !items.length; retry++) {
      await new Promise(r => setTimeout(r, EMPTY_RETRY_GAP_MS));
      try {
        items = await searchItems(keyword);
        log(`空结果重试第 ${retry} 次:`, items.length, '条');
      } catch (e) {
        log(`空结果重试第 ${retry} 次出错:`, e.message);
        items = [];
      }
    }
  }
  if (!items.length) {
    sendGroupMsg(groupId, `没找到《${keyword}》，换个名字或者加上年份再试试。`);
    return;
  }
  // 可提交转存的候选：优先夸克（后端目前只有夸克能真正转存成功）
  const withRef = items.filter(i => i && i.ref);
  const quarkPool = withRef.filter(i => i.drive === 'quark');
  const pool = quarkPool.length ? quarkPool : withRef;
  const fresh = pickBest(pool, keyword);

  // 已经转存过的：有现成链接、不是小说版、且分数不输最佳新候选 → 直接回现成链接
  const ready = pickBest(items.filter(i => itemShare(i) && !isNovelItem(i)), keyword);
  if (ready.item && (!fresh.item || ready.score >= fresh.score)) {
    sendGroupMsg(groupId, `《${itemTitle(ready.item, keyword)}》\n${itemShare(ready.item)}`);
    return;
  }

  if (!fresh.item) {
    // 没有可转存的候选：只剩已转存过的小说版时，把现成链接给出来（库里已有，不算新转）
    const anyReady = items.find(i => itemShare(i));
    if (anyReady) {
      sendGroupMsg(groupId, `《${itemTitle(anyReady, keyword)}》\n${itemShare(anyReady)}`);
      return;
    }
    sendGroupMsg(groupId, `没找到《${keyword}》可用的资源，换个名字再试试。`);
    return;
  }
  // 候选清一色是小说版：小说以后再搞，这次不转，群里说明白
  if (pool.every(i => isNovelItem(i))) {
    sendGroupMsg(groupId, `《${keyword}》只找到小说版，影视版暂时没有，小说以后再说。`);
    return;
  }
  const cand = fresh.item;
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

/* ---------------- 每日更新日报（21 点自动发群） ----------------
 * VM 侧每天 21:00 前把当天日报写进发布仓库 digest/digest-YYYY-MM-DD.txt
 * （内容就是要发的群消息原文：标题行 + 《剧名》更新至X集，不带链接）。
 * 这里在上海时间 21:00–23:59 之间每 3 分钟去镜像拉一次「今天」的文件，
 * 拉到就原样发到群里，并落一个 digest-posted-YYYY-MM-DD 标记文件
 * （在 bot.js 同目录，重启不丢），保证同一天只发一次。拉不到就安静等
 * 下一轮；昨天的、更旧的文件永远不发。时间一律按上海时间算：手机
 * chroot 里时区可能是 UTC，所以固定 +8 小时偏移，不依赖进程 TZ。 */
const DIGEST_GROUP_ID = 873487569;                         // 日报目标群（摸摸）
const DIGEST_MIRRORS = process.env.QQBOT_DIGEST_BASES
  ? process.env.QQBOT_DIGEST_BASES.split(',').map(s => s.trim()).filter(Boolean)
  : [
      'https://raw.githubusercontent.com/huige1998/qqbot-release/main',
      'https://cdn.jsdelivr.net/gh/huige1998/qqbot-release@main',
      'https://ghproxy.net/https://raw.githubusercontent.com/huige1998/qqbot-release/main',
    ]; // 与 updater.sh 同一套镜像顺序：raw 最新最快，jsdelivr 有缓存，ghproxy 兜底
const DIGEST_POLL_MS = Number(process.env.QQBOT_DIGEST_POLL_MS || 3 * 60 * 1000);
const DIGEST_FAKE_NOW_MS = Number(process.env.QQBOT_DIGEST_FAKE_NOW_MS || 0); // 仅测试用：冻结日报时钟

function shanghaiNow() {
  const ms = (DIGEST_FAKE_NOW_MS > 0 ? DIGEST_FAKE_NOW_MS : Date.now()) + 8 * 3600 * 1000;
  const t = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return {
    dateStr: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`,
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
  };
}

function digestMarkerPath(dateStr) { return path.join(__dirname, `digest-posted-${dateStr}`); }
function digestPosted(dateStr) {
  try { return fs.existsSync(digestMarkerPath(dateStr)); } catch { return false; }
}
function markDigestPosted(dateStr) {
  try { fs.writeFileSync(digestMarkerPath(dateStr), new Date().toISOString()); }
  catch (e) { log('写日报发送标记失败:', e.message); }
}

async function fetchTextFromMirrors(relPath, timeoutMs = 20000) {
  for (const base of DIGEST_MIRRORS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/${relPath}`, { signal: ctrl.signal });
      if (res.ok) return await res.text();
    } catch { /* 这个镜像不行，换下一个 */ } finally { clearTimeout(timer); }
  }
  return null;
}

let digestBusy = false;
async function digestTick() {
  if (digestBusy) return;
  const { dateStr, minutes } = shanghaiNow();
  if (minutes < 21 * 60) return;               // 21:00 之前不看；过 0 点日期已翻篇，旧文件自然不会被选中
  if (digestPosted(dateStr)) return;           // 今天已经发过
  digestBusy = true;
  try {
    const text = await fetchTextFromMirrors(`digest/digest-${dateStr}.txt`);
    if (!text || !text.trim()) return;         // 文件还没出（或空的），安静等下一轮
    if (digestPosted(dateStr)) return;         // 发送前再查一次标记，防并发/重启交错导致重复发
    if (!ws || ws.readyState !== 1) return;    // WS 没连上先别发：标记不落，下轮再试，不会丢
    sendGroupMsg(DIGEST_GROUP_ID, text);
    markDigestPosted(dateStr);
    log(`日报已发送（${dateStr}，${text.length} 字）`);
  } catch (e) {
    log('日报轮询出错（忽略，下轮再试）:', e && e.message);
  } finally {
    digestBusy = false;
  }
}

function startDigestPoster() {
  setInterval(() => { digestTick().catch(() => {}); }, DIGEST_POLL_MS);
  digestTick().catch(() => {}); // 启动先跑一次：21 点后重启的机器人能立刻补发，不用等 3 分钟
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
  if (seenMessage(ev.message_id)) { log('忽略重复投递的消息事件，message_id =', ev.message_id); return; }
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
  const gen = ++connGen;
  // 先关掉上一条连接再建新的：旧连接可能还半开着，新旧两条同时在线时
  // NapCat 会给每条连接各推一份事件，同一条消息就会被处理两遍。
  if (ws) {
    try { ws.close(); } catch { /* 忽略 */ }
    ws = null;
  }
  log('正在连接 NapCat:', WS_URL);
  const sock = new WebSocket(WS_URL);
  ws = sock;
  sock.addEventListener('open', () => {
    if (gen !== connGen) { try { sock.close(); } catch { /* 忽略 */ } return; }
    log('已连上 NapCat，机器人上线。等群里发「搜 片名」即可。');
  });
  sock.addEventListener('message', (e) => {
    if (gen !== connGen || ws !== sock) return; // 只认当前这条连接，旧连接的事件不算数
    try { onEvent(JSON.parse(typeof e.data === 'string' ? e.data : '')); } catch { /* 非 JSON 数据忽略 */ }
  });
  sock.addEventListener('close', () => {
    if (gen !== connGen) return; // 旧连接的关闭不触发重连，新连接已经接管
    if (ws === sock) ws = null;
    if (reconnectTimer == null) { // 最多只挂一个重连定时器，避免攒出多条连接
      log('连接断开，5 秒后重连…');
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
    }
  });
  // 出错时关自己这条连接（旧代码关的是全局 ws，重连后会误关新连接、留着旧连接继续收事件）
  sock.addEventListener('error', () => { try { sock.close(); } catch { /* 忽略 */ } });
}

log('机器人启动，后端地址:', BACKEND);
connect();
startDigestPoster();
