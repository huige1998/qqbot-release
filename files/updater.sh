#!/system/bin/sh
# =====================================================================
# 云更新器（宿主机侧，root 身份，在 chroot 外运行）
#   updater.sh check
#       执行一次检查/更新（updloop 在开机、每 6 小时、收到
#       /data/qqbot/shared/update.request 时调用）。
#   updater.sh monitor <备份目录> <旧bot版本> <新bot版本>
#       bot.js 换版后的看护（由 check 在内部拉起）: 80 秒内数 bot 进程
#       重启次数，>=3 次判定新版崩溃循环，自动回滚并把坏版本记入
#       bad_versions.txt，之后同一版本不会再被装上（更高版本仍可）。
#
# 发布渠道（按顺序试，sha256 不符就换下一条）:
#   1. raw.githubusercontent.com（最新最快，所以排第一）
#   2. cdn.jsdelivr.net（有缓存，可能滞后，靠 sha 校验兜底）
#   3. ghproxy.net 代理 raw
#
# 安全规则: 只升不降；每个文件先验 sha256 再换；shell 脚本先 sh -n；
#   换文件一律同目录 tmp + mv 原子替换；换前备份到 backup/<时间戳>/；
#   manifest 要求模块 versionCode 高于当前时整体跳过（等 Magisk 更新）。
#
# 自我保护: 任何模式一进来先把自己复制到 run/updater.exec.<pid>.sh
#   再 exec 副本运行——这样 bin/updater.sh 本体在更新中被替换、或父进程
#   退出清理时，都不会影响正在执行的这份代码。
# =====================================================================
DATA=/data/qqbot
BIN=$DATA/bin
ROOTFS=$DATA/rootfs
SHARED=$DATA/shared
DL=$DATA/dl/ota
LOGS=$DATA/logs
RUN=$DATA/run
SDLOGS=/sdcard/qqbot/logs
REPO_RAW="https://raw.githubusercontent.com/huige1998/qqbot-release/main"
REPO_CDN="https://cdn.jsdelivr.net/gh/huige1998/qqbot-release@main"
REPO_GHP="https://ghproxy.net/https://raw.githubusercontent.com/huige1998/qqbot-release/main"
BOT_IN_ROOTFS="$ROOTFS/root/qqbot/bot.js"

mkdir -p "$DL" "$LOGS" "$RUN" "$SHARED" "$DATA/backup" 2>/dev/null

BB=""
[ -x /data/adb/magisk/busybox ] && BB=/data/adb/magisk/busybox

# ---- 自我复制重入 -------------------------------------------------------
LAUNCHED_MONITOR=""
HELD_LOCK=""
case "$0" in
  */updater.exec.*.sh) : ;;  # 已经在私有副本上跑
  *)
    _priv="$RUN/updater.exec.$$.sh"
    if cp "$0" "$_priv" 2>/dev/null; then
      exec /system/bin/sh "$_priv" "$@"
    fi
    ;;
esac

cleanup() {
  [ -n "$HELD_LOCK" ] && rm -rf "$RUN/updater.lock" 2>/dev/null
  # 若本次 check 拉起了看护进程，它还在执行这份副本文件，不能删
  if [ -z "$LAUNCHED_MONITOR" ]; then
    case "$0" in */updater.exec.*.sh) rm -f "$0" 2>/dev/null ;; esac
  fi
}
trap cleanup EXIT

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOGS/update.log"; }
mirror_log() { mkdir -p "$SDLOGS" 2>/dev/null; cp "$LOGS/update.log" "$SDLOGS/update.log" 2>/dev/null; }

# ---- 版本状态 -----------------------------------------------------------
getv() { v=$(grep "^$1=" "$DATA/versions.txt" 2>/dev/null | tail -n 1 | cut -d= -f2 | tr -d ' \r'); echo "${v:-0}"; }
setv() {
  _tmp="$DATA/.versions.tmp"
  grep -v "^$1=" "$DATA/versions.txt" 2>/dev/null > "$_tmp"
  echo "$1=$2" >> "$_tmp"
  mv "$_tmp" "$DATA/versions.txt"
}
module_vc() {
  v=$(grep '^versionCode=' /data/adb/modules/qqbot-magisk/module.prop 2>/dev/null | cut -d= -f2 | tr -d ' \r')
  echo "${v:-2}"
}

# ---- 状态文件（bot.js 在群里播报用） -------------------------------------
write_status() { # <result> <from_bot> <to_bot> <from_scripts> <to_scripts> <detail>
  _tmp="$SHARED/.status.tmp"
  printf '{"time":"%s","result":"%s","from_bot":%s,"to_bot":%s,"from_scripts":%s,"to_scripts":%s,"detail":"%s"}\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "$2" "$3" "$4" "$5" "$6" > "$_tmp" 2>/dev/null
  mv "$_tmp" "$SHARED/update.status" 2>/dev/null
}

# ---- 下载 ---------------------------------------------------------------
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" 2>/dev/null | awk '{print $1}'
  elif [ -n "$BB" ]; then "$BB" sha256sum "$1" 2>/dev/null | awk '{print $1}'
  else echo ""; fi
}
dl_one() { # <url> <out> <maxtime>
  if command -v curl >/dev/null 2>&1; then
    curl -fL -C - --connect-timeout 10 --max-time "$3" -o "$2" "$1" 2>>"$LOGS/update.log"
  elif [ -n "$BB" ]; then
    "$BB" wget -c -O "$2" "$1" 2>>"$LOGS/update.log"
  elif command -v wget >/dev/null 2>&1; then
    wget -c -O "$2" "$1" 2>>"$LOGS/update.log"
  else
    return 1
  fi
}
# 按镜像顺序拉文件，每条线路最多重试 5 次，sha256 验过才算成功
fetch_verified() { # <仓库相对路径> <期望sha256> <目标文件>
  _rel=$1; _want=$2; _out=$3
  for _base in "$REPO_RAW" "$REPO_CDN" "$REPO_GHP"; do
    _attempt=1
    while [ $_attempt -le 5 ]; do
      if dl_one "$_base/$_rel" "$_out" 120 && [ "$(sha256_of "$_out")" = "$_want" ]; then
        return 0
      fi
      _attempt=$((_attempt + 1))
      sleep 3
    done
    rm -f "$_out"
    log "线路 $_base 的 $_rel 拉取/校验失败，换下一条"
  done
  return 1
}
MANIFEST=""
fetch_manifest() {
  MANIFEST="$DL/manifest.json"
  _tmp="$DL/.manifest.tmp"
  for _base in "$REPO_RAW" "$REPO_CDN" "$REPO_GHP"; do
    rm -f "$_tmp"
    if dl_one "$_base/manifest.json?_=$(date +%s)" "$_tmp" 30 || dl_one "$_base/manifest.json" "$_tmp" 30; then
      if grep -q '"bot"' "$_tmp" && grep -q '"min_module_versionCode"' "$_tmp"; then
        mv "$_tmp" "$MANIFEST"
        return 0
      fi
      log "线路 $_base 的 manifest 内容不像更新清单"
    fi
  done
  return 1
}
# manifest 是"一条目一行"的固定格式，这里按行抠字段:
# mget <行的grep模式> <key> —— key 的值可以是数字或带引号字符串
mget() {
  _line=$(grep "$1" "$MANIFEST" 2>/dev/null | head -n 1)
  echo "$_line" | sed -n "s/.*\"$2\": *\"\([^\"]*\)\".*/\1/p; s/.*\"$2\": *\([0-9][0-9]*\).*/\1/p" | head -n 1
}

# ---- bot 进程 -----------------------------------------------------------
# 精确匹配: 某个参数正好是 /root/qqbot/bot.js 且 argv[0] 是 node。
# 不能用子串匹配——任何"提到这个路径"的 shell/脚本（比如手动排查命令）
# 都会被误杀。容器里真正的 bot 是 node /root/qqbot/bot.js，参数是精确的。
find_bot_pid() {
  for _d in /proc/[0-9]*; do
    [ -r "$_d/cmdline" ] || continue
    if tr '\0' '\n' < "$_d/cmdline" 2>/dev/null | grep -qx '/root/qqbot/bot.js'; then
      _exe=$(tr '\0' '\n' < "$_d/cmdline" 2>/dev/null | head -n 1)
      case "$_exe" in
        *node*) echo "${_d#/proc/}"; return 0 ;;
      esac
    fi
  done
  return 1
}
kill_bot() {
  _p=$(find_bot_pid)
  if [ -n "$_p" ]; then
    kill "$_p" 2>/dev/null
    log "已终止旧 bot 进程 pid=$_p（容器内看门狗会拉起新版）"
    return 0
  fi
  return 1
}

# ---- 脚本包更新 -----------------------------------------------------------
# 返回 0 成功 / 1 失败（失败时一个文件都不动，不会出现半新半旧）
apply_scripts() { # <新版本号>
  _ver=$1
  _names="run.sh start_qqbot.sh stop_qqbot.sh chroot_run.sh updater.sh"
  _stage="$DL/stage"
  rm -rf "$_stage"; mkdir -p "$_stage"
  for _name in $_names; do
    _sha=$(mget "\"$_name\":" sha256); _p=$(mget "\"$_name\":" path)
    if [ -z "$_sha" ] || [ -z "$_p" ]; then log "manifest 里缺 $_name 的条目，放弃脚本包"; return 1; fi
    if ! fetch_verified "$_p" "$_sha" "$_stage/$_name"; then log "$_name 下载/校验失败，放弃脚本包"; return 1; fi
    if ! sh -n "$_stage/$_name" 2>/dev/null; then log "$_name 语法检查不过，放弃脚本包"; return 1; fi
  done
  _ts=$(date '+%Y%m%d%H%M%S')
  _bk="$DATA/backup/$_ts"; mkdir -p "$_bk"
  for _name in $_names; do [ -f "$BIN/$_name" ] && cp "$BIN/$_name" "$_bk/$_name"; done
  cp "$DATA/versions.txt" "$_bk/versions.txt" 2>/dev/null
  for _name in $_names; do
    cp "$_stage/$_name" "$BIN/.$_name.tmp" && chmod 755 "$BIN/.$_name.tmp" && mv "$BIN/.$_name.tmp" "$BIN/$_name"
  done
  setv scripts "$_ver"
  log "脚本包已更新到 v$_ver（旧版备份在 $_bk）"
  return 0
}

# ---- bot.js 更新 ----------------------------------------------------------
# 返回 0 = 已换版且在运行、看护已拉起 / 2 = 已换版但 bot 没在跑（下次启动生效） / 1 = 失败
apply_bot() { # <新版本号> <sha256> <仓库相对路径>
  _ver=$1; _sha=$2; _p=$3
  if [ -z "$_sha" ] || [ -z "$_p" ]; then log "manifest 里 bot 条目不全"; return 1; fi
  _tmp="$DL/bot.js.new"
  rm -f "$_tmp"
  if ! fetch_verified "$_p" "$_sha" "$_tmp"; then log "bot.js 下载/校验失败"; return 1; fi
  _ts=$(date '+%Y%m%d%H%M%S')
  _bk="$DATA/backup/$_ts"; mkdir -p "$_bk"
  cp "$BOT_IN_ROOTFS" "$_bk/bot.js" 2>/dev/null
  cp "$DATA/versions.txt" "$_bk/versions.txt" 2>/dev/null
  if ! { cp "$_tmp" "$ROOTFS/root/qqbot/.bot.js.tmp" && mv "$ROOTFS/root/qqbot/.bot.js.tmp" "$BOT_IN_ROOTFS"; }; then
    log "替换 bot.js 失败"
    return 1
  fi
  _old=$(getv bot)
  setv bot "$_ver"
  log "bot.js 已更新 v$_old -> v$_ver（旧版备份在 $_bk）"
  if find_bot_pid >/dev/null; then
    kill_bot
    LAUNCHED_MONITOR=1
    setsid /system/bin/sh "$0" monitor "$_bk" "$_old" "$_ver" </dev/null >/dev/null 2>&1 &
    log "已拉起更新看护进程"
    return 0
  fi
  log "bot 当前没在跑，新版下次启动生效"
  return 2
}

# ---- 检查主流程 -----------------------------------------------------------
do_check() {
  LOCK="$RUN/updater.lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    _old=$(cat "$LOCK/started" 2>/dev/null || echo 0)
    _now=$(date +%s)
    if [ $((_now - _old)) -gt 1800 ]; then
      rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || return 0
    else
      log "已有一次检查在进行，跳过"
      return 0
    fi
  fi
  HELD_LOCK=1
  echo "$(date +%s)" > "$LOCK/started"

  [ -f "$DATA/.installed" ] || { log "环境还没装好，跳过检查"; return 0; }

  if [ -f "$SHARED/update.request" ]; then
    rm -f "$SHARED/update.request"
    log "本次检查由群里「更新」命令触发"
  fi

  cur_bot=$(getv bot); cur_scripts=$(getv scripts)
  mvc=$(module_vc)
  write_status checking "$cur_bot" "$cur_bot" "$cur_scripts" "$cur_scripts" "正在检查"
  log "开始检查: 当前 bot=$cur_bot scripts=$cur_scripts 模块versionCode=$mvc"

  if ! fetch_manifest; then
    log "manifest 三条线路都拉不到"
    write_status failed "$cur_bot" "$cur_bot" "$cur_scripts" "$cur_scripts" "拉不到更新清单（网络问题）"
    mirror_log
    return 0
  fi

  min_vc=$(mget 'min_module_versionCode' min_module_versionCode)
  [ -n "$min_vc" ] || min_vc=0
  if [ "$min_vc" -gt "$mvc" ]; then
    log "manifest 要求模块 versionCode >= $min_vc，当前 $mvc，整体跳过（等 Magisk 更新模块）"
    write_status needs_module_update "$cur_bot" "$cur_bot" "$cur_scripts" "$cur_scripts" "需要先在 Magisk 里更新模块"
    mirror_log
    return 0
  fi

  changed=""
  new_bot=$cur_bot; new_scripts=$cur_scripts
  bot_state="none"

  # 脚本包先行（失败不影响后面的 bot 判断，旧脚本保持不动）
  sver=$(mget '"scripts":' version)
  if [ -n "$sver" ] && [ "$sver" -gt "$cur_scripts" ]; then
    if apply_scripts "$sver"; then
      new_scripts=$sver; changed="scripts"
    else
      log "脚本包更新失败，已放弃（旧脚本继续用）"
    fi
  fi

  # bot.js
  bver=$(mget '"bot":' version); bsha=$(mget '"bot":' sha256); bpath=$(mget '"bot":' path)
  if [ -n "$bver" ] && [ "$bver" -gt "$cur_bot" ]; then
    if grep -qx "bot $bver" "$DATA/bad_versions.txt" 2>/dev/null; then
      log "bot v$bver 在坏版本名单里，跳过（等更高版本）"
      bot_state="skipped_bad"
    else
      apply_bot "$bver" "$bsha" "$bpath"
      _rc=$?
      if [ $_rc -eq 0 ]; then
        new_bot=$bver; changed="$changed bot"; bot_state="pending"
      elif [ $_rc -eq 2 ]; then
        new_bot=$bver; changed="$changed bot"; bot_state="done"
      else
        write_status failed "$cur_bot" "$cur_bot" "$cur_scripts" "$new_scripts" "bot 下载或校验失败"
        mirror_log
        return 0
      fi
    fi
  fi

  if [ "$bot_state" = "pending" ]; then
    write_status updated_restarting "$cur_bot" "$new_bot" "$cur_scripts" "$new_scripts" "bot 已换版，看护确认中"
  elif [ -n "$changed" ]; then
    write_status updated "$cur_bot" "$new_bot" "$cur_scripts" "$new_scripts" "已更新: $changed"
    log "更新完成: $changed"
  else
    write_status latest "$cur_bot" "$cur_bot" "$cur_scripts" "$cur_scripts" "已是最新"
    log "已是最新版（bot=$cur_bot scripts=$cur_scripts）"
  fi
  mirror_log
  return 0
}

# ---- 看护（回滚判定） -------------------------------------------------------
# 判定材料有两路，互相兜底:
#  1) 容器内看门狗每次 bot 退出都会往 bot.log 追加一行"[watchdog] bot.js 退出"，
#     数这行的增量最可靠——采样间隔再长也不会漏掉崩溃循环；
#  2) /proc 里 bot 进程的 pid 变化（进程活着才采得到，快速崩溃时经常采空）。
# 80 秒内退出增量 >=3 或 pid 重启 >=3 次 -> 判新版不行，回滚；
# 整个窗口一次都没见到活着的 bot 进程，也判失败（说明根本没跑起来）。
BOTLOG="/data/qqbot/rootfs/root/qqbot/bot.log"
exit_count() {
  _c=$(grep -c 'bot.js 退出' "$BOTLOG" 2>/dev/null)
  echo "${_c:-0}"
}
do_monitor() { # <备份目录> <旧bot版本> <新bot版本>
  _bk=$1; _old=$2; _new=$3
  MLOCK="$RUN/monitor.lock"
  if ! mkdir "$MLOCK" 2>/dev/null; then
    log "已有看护在跑，本次看护退出"
    return 0
  fi
  # 看护干完活后清掉锁和自己脚下的副本文件（父 check 早已退出）
  trap 'rm -rf "$MLOCK" 2>/dev/null; case "$0" in */updater.exec.*.sh) rm -f "$0" 2>/dev/null ;; esac' EXIT

  log "看护开始: 观察 bot v$_new 的启动情况（80 秒）"
  sleep 3  # 等被杀的旧 bot 那行退出日志落盘，基线才准
  _base_exits=$(exit_count)
  _deadline=$(( $(date +%s) + 80 ))
  _last_pid=""; _restarts=0; _seen=0
  while [ "$(date +%s)" -lt "$_deadline" ]; do
    _p=$(find_bot_pid)
    if [ -n "$_p" ]; then
      _seen=1
      if [ -z "$_last_pid" ]; then
        _last_pid=$_p
      elif [ "$_p" != "$_last_pid" ]; then
        _restarts=$((_restarts + 1)); _last_pid=$_p
        log "看护: bot 进程更换（第 $_restarts 次重启）pid=$_p"
      fi
    fi
    _delta=$(( $(exit_count) - _base_exits ))
    [ "$_delta" -ge 3 ] && break
    [ "$_restarts" -ge 3 ] && break
    sleep 4
  done
  _delta=$(( $(exit_count) - _base_exits ))

  _cs=$(getv scripts)
  if [ "$_delta" -ge 3 ] || [ "$_restarts" -ge 3 ] || [ "$_seen" != "1" ]; then
    log "看护判定失败（退出增量=$_delta，pid重启=$_restarts，见到活进程=$_seen），回滚 bot 到 v$_old"
    if [ -f "$_bk/bot.js" ]; then
      cp "$_bk/bot.js" "$ROOTFS/root/qqbot/.bot.js.tmp" && mv "$ROOTFS/root/qqbot/.bot.js.tmp" "$BOT_IN_ROOTFS"
    fi
    kill_bot
    echo "bot $_new" >> "$DATA/bad_versions.txt"
    setv bot "$_old"
    write_status rolled_back "$_old" "$_old" "$_cs" "$_cs" "bot v$_new 启动异常，已回滚到 v$_old"
  else
    log "看护通过: bot v$_new 运行稳定"
    write_status updated "$_old" "$_new" "$_cs" "$_cs" "bot 更新完成"
  fi
  mirror_log
  return 0
}

case "$1" in
  check) do_check ;;
  monitor) do_monitor "$2" "$3" "$4" ;;
  *) echo "用法: updater.sh check | monitor <备份目录> <旧版本> <新版本>"; exit 1 ;;
esac
exit 0
