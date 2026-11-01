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

const BACKEND_CLOUD = (process.env.PAN_BACKEND || 'https://pan-search-5160265-1520428323.ap-shanghai.run.tcloudbase.com').replace(/\/+$/, '');
const BACKEND_LOCAL = (process.env.PAN_BACKEND_LOCAL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const WS_URL = process.env.QQBOT_WS_URL || 'ws://127.0.0.1:3001';
const GROUP_COOLDOWN_MS = 10 * 1000;                       // 同一个群两次搜索的最小间隔
const POLL_INTERVAL_MS = Number(process.env.QQBOT_POLL_MS || 5000);            // 转存轮询间隔
const POLL_TIMEOUT_MS = Number(process.env.QQBOT_POLL_TIMEOUT_MS || 120000);   // 转存最长等待
const SEARCH_TIMEOUT_MS = 90000;                           // 搜索接口偶尔较慢，给足时间
const EMPTY_RETRY_MAX = 2;                                 // 搜索返回空结果时，最多再重试几次
const EMPTY_RETRY_GAP_MS = Number(process.env.QQBOT_EMPTY_RETRY_MS || 6000); // 空结果重试的间隔
const MAX_CANDIDATE_TRIES = 3;                             // 候选源失效/无链接时，最多顺延试几个候选
const MAX_FLOW_RESTARTS = 1;                               // 本地后端中途断开时，整轮换后端重搜的最多次数
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
 *
 * v7（2026-11-01）修 pid 回收陷阱：v4 只用 kill(pid,0) 判持有者死活。真机实锤：
 * 一个 bot 实例在 NapCat 的 3001 还没起来时启动、随后死掉，它的 pid 被 chroot 里
 * 一个长命无关进程回收占用——锁里记着这个 pid，kill(pid,0) 永远说"活着"，
 * 看门狗每 5 秒拉起的新实例全部误判「已有实例在运行」退出，机器人死了几小时
 * 无人接管。现在判持有者要验身份，两条都过才认：
 *   1) /proc/<pid>/cmdline：argv[0] 含 node，且某个参数与本进程 bot.js 的
 *      路径完全相等（与脚本侧清扫的精确令牌匹配同一套语义）；
 *   2) 锁里记了持有者的启动节拍（/proc/<pid>/stat 第 22 字段）时，必须与
 *      当前读数一致——pid 就算被回收给另一个进程也对不上节拍。
 * 身份对不上（已死 / 不是 bot.js / 节拍不符）一律当失效锁接管并记一行；
 * 只有"活着但 /proc 读不到、验不了"（含非 Linux 平台）才保守按已有实例退出，
 * 防真双开的底线不变。锁内容为 JSON {pid, start}；v6 及更早写下的纯 pid
 * 锁文件也能读（没有 start 就只验 cmdline）。 */
const LOCK_PATH = process.env.QQBOT_LOCK_PATH || path.join(__dirname, 'bot.lock');
const SELF_PATH = __filename; // 本进程 bot.js 的绝对路径，验持有者身份的令牌
let lockFd = null; // 非 null 表示本进程是锁持有者

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); } // EPERM = 进程在，只是无权发信号
}

// /proc/<pid>/stat 第 22 字段：进程启动节拍（相对开机的 clock ticks）；读不到返回 null
function procStarttime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19] || null; // rest[0] 是字段 3(state)，字段 22 落在下标 19
  } catch { return null; }
}

// 读锁文件：成功返回 {pid, start|null}；文件读不到或内容无法解析返回 null
function readLockPayload() {
  let raw;
  try { raw = fs.readFileSync(LOCK_PATH, 'utf8').trim(); } catch { return null; }
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (j && Number.isInteger(j.pid) && j.pid > 0) {
      return { pid: j.pid, start: j.start != null ? String(j.start) : null };
    }
  } catch { /* 不是 JSON：按旧版纯 pid 格式继续解析 */ }
  const pid = parseInt(raw, 10);
  return (Number.isInteger(pid) && pid > 0) ? { pid, start: null } : null;
}

// 判定锁里记的持有者：'bot' = 确是 bot.js 实例；'stale' = 可接管的失效锁；
// 'unknown' = 活着但验不了身份（/proc 读不到等），保守处理
function lockOwnerVerdict(pid, recordedStart) {
  if (!pidAlive(pid)) return 'stale'; // kill(pid,0) 明确说进程不存在
  if (process.platform !== 'linux') return 'unknown'; // 没有 /proc 可验，回到只判死活
  let cmdline;
  try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); }
  catch (e) { return e && e.code === 'ENOENT' ? 'stale' : 'unknown'; } // ENOENT = 刚消失
  const tokens = cmdline.split('\0').filter(Boolean);
  const looksLikeBot = tokens.length > 0 && tokens[0].includes('node') && tokens.includes(SELF_PATH);
  if (!looksLikeBot) return 'stale'; // 活着，但根本不是 bot.js：pid 被回收了
  if (recordedStart != null) {
    const actual = procStarttime(pid);
    if (actual == null) return pidAlive(pid) ? 'unknown' : 'stale';
    if (String(actual) !== String(recordedStart)) return 'stale'; // 节拍对不上：pid 已易主
  }
  return 'bot';
}

function acquireInstanceLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(LOCK_PATH, 'wx'); // O_EXCL 原子创建，已存在直接抛 EEXIST
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        const lock = readLockPayload();
        const verdict = lock ? lockOwnerVerdict(lock.pid, lock.start) : 'stale';
        if (verdict !== 'stale') {
          // 'bot'：真有实例在跑；'unknown'：活着但验不了，保守按真实例处理
          log(`已有实例在运行 (pid ${lock.pid})，本实例退出`);
          process.exit(0);
        }
        // 失效锁（持有者已死、pid 被无关进程回收、或内容不可解析）：删掉接管
        if (lock) log(`锁残留（pid ${lock.pid} 非机器人进程），接管`);
        try { fs.unlinkSync(LOCK_PATH); } catch { /* 别人先删了也无妨 */ }
        continue;
      }
      // 其他错误（如目录不可写）：别把机器人挡在门外，记一笔继续无锁启动
      log('单实例锁创建失败（继续无锁启动）:', e && e.message);
      return;
    }
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, start: procStarttime(process.pid) }));
    } catch { /* 写不进不影响占锁本身 */ }
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

/* ---------------- 后端调用（v8：本地优先、云端兜底） ----------------
 * 2026-11-01 后端搬进手机：同一个 chroot 里跑着一份本地后端
 * （127.0.0.1:8787），云端 CloudBase 只作兜底。路由规则（设计 §5）：
 * - 每条「搜」流程开始先探本地 /api/health（2 秒）：通 → 整条流程都用
 *   本地；不通 → 整条流程用云端，并熔断 60 秒（期间不再探测、直走云端）。
 * - 会话亲和：ref 令牌是后端实例私有的，本地搜出的 ref 只能提交给本地。
 *   所以一条流程定下 base 后 search/submit/poll 全程不换：本地在中途网络
 *   断开时，搜索这一步可以当场改走云端（还没产生 ref），但提交/轮询带着
 *   本地 ref 绝不跨后端提交（必 400）——该候选判 'netfail'，整轮作废、
 *   重新定 base 重搜（新后端发新 ref）。
 * - HTTP 业务错误（如 400 ref 无效）不是网络故障，永不触发切换；搜索
 *   本身慢也不触发（沿用 SEARCH_TIMEOUT，慢不等于后端死了）。
 * chroot 是 env -i，环境变量基本传不进来：默认值写死，env 只作调试覆盖。 */
const LOCAL_BREAKER_MS = 60 * 1000;  // 本地后端熔断时长，期内直走云端
const PROBE_TIMEOUT_MS = 2000;       // 本地健康探测超时
let localDownUntil = 0;              // 熔断截止时间戳，在此之前不探测本地
let localWasDown = false;            // 正处于「本地不可用」期，恢复时打一行日志

// fetch 抛出的错误里，哪些算「网络级故障」（连不上/断开/超时），哪些不算。
// HTTP 状态码错误不会走到这里（fetchJson 对任何状态码都解析 body、不抛错），
// 所以业务错误天然不触发切换，这里只判传输层。
function isNetworkError(e) {
  if (!e) return false;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true; // 本地探测/请求超时掐断
  const code = (e.cause && e.cause.code) || e.code || '';
  if (code && ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
    'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  ].includes(code)) return true;
  return e instanceof TypeError; // undici 的网络失败是 TypeError("fetch failed")，具体 code 在 cause 里，兜底认它
}

function markLocalDown() {
  if (Date.now() >= localDownUntil) log('本地后端不可用，本次走云端');
  localDownUntil = Date.now() + LOCAL_BREAKER_MS;
  localWasDown = true;
}

async function probeLocal() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${BACKEND_LOCAL}/api/health`, { signal: ctrl.signal });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return !!(data && data.ok === true);
  } catch { return false; }
  finally { clearTimeout(timer); }
}

// 给一条流程定 base：熔断期内直走云端；否则探本地，通→本地，不通→云端+熔断。
async function pickBase() {
  if (Date.now() < localDownUntil) return BACKEND_CLOUD;
  if (await probeLocal()) {
    if (localWasDown) { localWasDown = false; log('本地后端已恢复，恢复本地优先'); }
    return BACKEND_LOCAL;
  }
  markLocalDown();
  return BACKEND_CLOUD;
}

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

/* 在 base 上搜。返回 { items, base }：base 一般就是传入的 base，但本地在
 * 搜索这一步网络断开时，会当场改走云端重试（搜索不带 ref 绑定，可以换），
 * 这时返回的 base 已是云端，调用方必须用返回的 base 继续提交/轮询，
 * 否则 ref 会串台。三次都失败才抛错（与 v7 同语义）。 */
async function searchItems(base, keyword) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await fetchJson(`${base}/api/search?q=${encodeURIComponent(keyword)}`, {}, SEARCH_TIMEOUT_MS);
      const items = Array.isArray(data) ? data : (data.items || data.results || []);
      return { items, base };
    } catch (e) {
      lastErr = e;
      const cause = (e && e.cause && (e.cause.code || e.cause.message)) || '';
      log(`搜索第 ${attempt} 次尝试失败:`, e.message, cause);
      if (base === BACKEND_LOCAL && isNetworkError(e)) {
        markLocalDown();
        base = BACKEND_CLOUD; // 后续尝试改走云端，结果里的 ref 也随之是云端的
      }
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 4000));
    }
  }
  throw lastErr;
}

async function submitTask(base, ref) {
  return fetchJson(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref, requester: 'qq-bot' }),
  }, 30000);
}

async function getTask(base, id) {
  const data = await fetchJson(`${base}/api/tasks/${encodeURIComponent(id)}`, {}, 15000);
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

/* 单个候选的「提交 + 轮询」全流程，供 handleSearch 的候选顺延循环调用。
 * 拿到链接时自己把链接发到群里并返回 'ok'；源已被取消（dead_source）、
 * 转存失败、转完没生成链接、或轮询超时，一律返回 'fail'，由调用方静默
 * 换下一个候选——群里不发任何消息，免得像 2026-11-01 00:50 那次一样，
 * 第一个候选的源被原主取消（夸克 41012）就误报「已转存好但没生成新链接」。
 * 返回 'filtered' 表示内容被过滤（对这个关键词整体的判定，调用方收尾）。
 * 返回 'netfail' 表示本地后端在提交/轮询中途网络断开：候选的 ref 是本地
 * 发的，绝不能拿去云端提交，整轮作废，由调用方重新定 base 重搜。 */
async function tryCandidate(groupId, base, cand, keyword) {
  const title = itemTitle(cand, keyword);
  let created;
  try {
    created = await submitTask(base, cand.ref);
  } catch (e) {
    if (base === BACKEND_LOCAL && isNetworkError(e)) {
      log('提交时本地后端断开（整轮作罢，换后端重搜）:', title);
      return 'netfail';
    }
    log('提交转存出错（该候选作罢）:', e.message);
    return 'fail';
  }
  if (created && created.filtered) return 'filtered';
  const task = (created && created.task) || created || {};
  if (!task.id) {
    log('提交转存没返回任务 id（该候选作罢）:', title);
    return 'fail';
  }
  if (task.status === 'done' && task.share_url) {
    sendGroupMsg(groupId, `《${title}》\n${task.share_url}`);
    return 'ok';
  }
  if (['dead_source', 'failed', 'error', 'blocked', 'cancelled'].includes(task.status)) {
    log(`候选提交即处于 ${task.status} 状态（该候选作罢）:`, title);
    return 'fail';
  }
  // 轮询等转存完成
  let sawDoneNoLink = false;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    let t;
    try { t = await getTask(base, task.id); } catch (e) {
      if (base === BACKEND_LOCAL && isNetworkError(e)) {
        log('轮询时本地后端断开（整轮作罢，换后端重搜）:', title);
        return 'netfail';
      }
      continue;
    }
    if (t.status === 'done' && t.share_url) {
      sendGroupMsg(groupId, `《${title}》转存好了\n${t.share_url}`);
      return 'ok';
    }
    if (t.status === 'done' || t.status === 'done_pending_share') {
      // 转存已完成但分享链接还没生成（后端要晚几秒），继续等，别抢跑下结论
      sawDoneNoLink = true;
    }
    if (['dead_source', 'failed', 'error', 'blocked', 'cancelled'].includes(t.status)) {
      log(`候选任务状态 ${t.status}（该候选作罢）:`, title);
      return 'fail';
    }
  }
  // 轮询超时收场：转完却一直没链接（sawDoneNoLink）或一直没转完，
  // 都算这个候选不行，换下一个（不再单独回「没生成新链接/还在转存中」）。
  log(sawDoneNoLink ? '候选转存完成但始终没生成链接（该候选作罢）:' : '候选转存超时（该候选作罢）:', title);
  return 'fail';
}

async function handleSearch(groupId, keyword) {
  sendGroupMsg(groupId, `正在找《${keyword}》，找到后会自动转存，好了就把链接发到群里。`);
  // 一轮 = 定 base → 搜索 → 挑候选 → 挨个试（searchRound）。轮内的普通失败
  // （源失效、没链接等）不重搜，与 v7 一致；只有本地后端在一轮中途网络
  // 断开（'netfail'）才整轮作废、重新定 base 重搜，最多重搜
  // MAX_FLOW_RESTARTS 轮，防止后端反复横跳时无限重搜。
  for (let restart = 0; ; restart++) {
    const needRestart = await searchRound(groupId, keyword);
    if (!needRestart) return;
    if (restart >= MAX_FLOW_RESTARTS) {
      sendGroupMsg(groupId, `《${keyword}》找到的几个源都不行，有的链接已经失效了，换个名字或者晚点再试试。`);
      return;
    }
  }
}

/* 一轮完整的搜索流程：定下 base 后全程不换（会话亲和，见后端调用节的
 * v8 说明）。返回 true 只表示「本地后端中途断开、整轮作废」，由
 * handleSearch 重新定 base 重搜；其余一切结局（出链接、没找到、来源
 * 都不行、被过滤、搜索接口彻底出错）都在本轮内回完消息并返回 false。 */
async function searchRound(groupId, keyword) {
  let base = await pickBase();
  let items;
  try {
    const r = await searchItems(base, keyword);
    items = r.items; base = r.base; // 搜索途中可能已改走云端（base 随之更新）
  } catch (e) {
    log('搜索接口出错:', e.message);
    sendGroupMsg(groupId, '服务暂时开小差了，过一会儿再发一次试试。');
    return false;
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
        const r = await searchItems(base, keyword);
        items = r.items; base = r.base;
        log(`空结果重试第 ${retry} 次:`, items.length, '条');
      } catch (e) {
        log(`空结果重试第 ${retry} 次出错:`, e.message);
        items = [];
      }
    }
  }
  if (!items.length) {
    sendGroupMsg(groupId, `没找到《${keyword}》，换个名字或者加上年份再试试。`);
    return false;
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
    return false;
  }

  if (!fresh.item) {
    // 没有可转存的候选：只剩已转存过的小说版时，把现成链接给出来（库里已有，不算新转）
    const anyReady = items.find(i => itemShare(i));
    if (anyReady) {
      sendGroupMsg(groupId, `《${itemTitle(anyReady, keyword)}》\n${itemShare(anyReady)}`);
      return false;
    }
    sendGroupMsg(groupId, `没找到《${keyword}》可用的资源，换个名字再试试。`);
    return false;
  }
  // 候选清一色是小说版：小说以后再搞，这次不转，群里说明白
  if (pool.every(i => isNovelItem(i))) {
    sendGroupMsg(groupId, `《${keyword}》只找到小说版，影视版暂时没有，小说以后再说。`);
    return false;
  }
  // 候选排名：分数从高到低，同分保持后端顺序（后端已按时间倒序，新资源
  // 在前）；按 ref 去重。小说版永不进候选——清一色小说时 ranked 为空，
  // 但上面的 pool.every(小说) 分支已经回过话了，走不到这个循环。
  const ranked = pool
    .filter(i => !isNovelItem(i))
    .map((item, idx) => ({ item, idx, score: scoreItem(item, keyword) }))
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    .filter((e, i, arr) => arr.findIndex(x => x.item.ref === e.item.ref) === i)
    .map(e => e.item);

  // 挨个候选试，最多试 MAX_CANDIDATE_TRIES 个：某个源被取消、转存失败
  // 或转完没链接，都静默顺延到下一个候选。群里全程只有开头那一条
  // 「正在找」，不再出现「转存好了但没链接」这种误导话术。
  for (const cand of ranked.slice(0, MAX_CANDIDATE_TRIES)) {
    const r = await tryCandidate(groupId, base, cand, keyword);
    if (r === 'ok') return false;
    if (r === 'filtered') {
      sendGroupMsg(groupId, `《${keyword}》这类内容被过滤了，换一部试试。`);
      return false;
    }
    if (r === 'netfail') {
      // 本地后端中途断开：候选的 ref 是本地发的，不能拿去云端提交，
      // 整轮作废，回去重新定 base 重搜（熔断已记，下一轮通常落到云端）。
      markLocalDown();
      return true;
    }
    // 'fail'：这个候选不行，静默换下一个
  }
  sendGroupMsg(groupId, `《${keyword}》找到的几个源都不行，有的链接已经失效了，换个名字或者晚点再试试。`);
  return false;
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

/* ---------------- 日志回传（主人专用） ----------------
 * 群里主人发「日志」/「后端日志」：把 bot.log / backend.log 的最后 40 行
 * 直接发回群里，省得排障时靠截图传日志。权限与「更新」一致：只有主人，
 * 其他人静默忽略。两个日志都在 bot.js 同目录（手机上是 /root/qqbot/，
 * backend.log 由本地后端的看门狗写）。每条消息 ≤1500 字符、最多 2 条：
 * 内容超长时从最旧的行开始截断（保最新），并在开头注明已截断。含
 * cookie 字样的行整行跳过（日志里本不该出现 cookie 值，防万一）。 */
const LOG_TAIL_LINES = 40;
const LOG_MSG_MAX_CHARS = 1500;
const LOG_MAX_MSGS = 2;
const BOT_LOG_PATH = path.join(__dirname, 'bot.log');
const BACKEND_LOG_PATH = path.join(__dirname, 'backend.log');

// 读日志文件的最后若干行：只读尾部一截字节，不整文件读进来；文件不存在返回 null
function readLogTail(file, lines) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    const maxBytes = 128 * 1024; // 只回最后 40 行，尾部一截足够
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) { const nl = text.indexOf('\n'); text = nl >= 0 ? text.slice(nl + 1) : ''; } // 丢掉被截断的半行
    const all = text.split('\n');
    if (all.length && all[all.length - 1] === '') all.pop(); // 文件末尾的换行不算一行
    return all.slice(-lines);
  } catch { return null; }
  finally { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
}

// 把日志行拼成最多 LOG_MAX_MSGS 条、每条 ≤LOG_MSG_MAX_CHARS 的消息（保最新）
function packLogMessages(lines) {
  const NOTE = '（日志太长，前面已截断，只显示最近的部分）';
  const budget = LOG_MSG_MAX_CHARS * LOG_MAX_MSGS;
  let kept = lines.slice();
  let text = kept.join('\n');
  let truncated = false;
  while (kept.length > 1 && text.length > budget) { kept.shift(); text = kept.join('\n'); truncated = true; }
  if (truncated) {
    while (kept.length > 1 && text.length > budget - NOTE.length - 1) { kept.shift(); text = kept.join('\n'); }
    text = NOTE + '\n' + text;
    if (text.length > budget) text = NOTE + '\n' + text.slice(-(budget - NOTE.length - 1)); // 单行超长的兜底硬截
  }
  if (text.length <= LOG_MSG_MAX_CHARS) return [text];
  // 拆两条：第二条装最新的一截（从某行行首开始、≤1500），第一条装剩下的
  let cut = text.length - LOG_MSG_MAX_CHARS;
  const nl = text.indexOf('\n', cut);
  if (nl >= 0 && nl + 1 < text.length) cut = nl + 1;
  let first = text.slice(0, cut).replace(/\n$/, '');
  if (first.length > LOG_MSG_MAX_CHARS) first = first.slice(0, LOG_MSG_MAX_CHARS);
  return [first, text.slice(cut)];
}

function handleLogRequest(groupId, kind) {
  const isBackend = kind === 'backend';
  const lines = readLogTail(isBackend ? BACKEND_LOG_PATH : BOT_LOG_PATH, LOG_TAIL_LINES);
  if (lines == null) {
    sendGroupMsg(groupId, isBackend ? '后端日志不存在（本地后端没在这一栈跑）' : '机器人日志不存在（bot.log 没找到）');
    return;
  }
  const safe = lines.filter(l => !l.toLowerCase().includes('cookie')); // 含 cookie 字样的行整行不回
  if (!safe.length) { sendGroupMsg(groupId, isBackend ? '后端日志是空的。' : '机器人日志是空的。'); return; }
  for (const msg of packLogMessages(safe)) sendGroupMsg(groupId, msg);
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
  if (text === '日志' || text === '后端日志') {
    if (String(ev.user_id) !== OWNER_ID) return; // 只有主人能看日志，别人静默忽略
    handleLogRequest(groupId, text === '后端日志' ? 'backend' : 'bot');
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

log(`机器人启动，后端：本地优先 ${BACKEND_LOCAL}，云端兜底 ${BACKEND_CLOUD}`);
connect();
startDigestPoster();
