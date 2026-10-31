#!/system/bin/sh
# 停止 QQ 机器人: 依次停 二维码/日志同步守护、机器人看门狗、NapCat，最后卸载容器挂载。
# pid 文件整组杀之后再做一轮按 argv 的进程清扫，杀掉不在任何 pid 文件里的
# 看门狗/bot 孤儿进程，保证停机后零 bot 进程（见下方 qqbot-sweep 段落）。
#
# 调用方式（v5 起）:
#   stop_qqbot.sh           —— 立即返回，真正的停止转入后台执行（日志写
#                              /data/qqbot/logs/stop.log）。WebUI 的按钮是
#                              同步等返回的固定指令: 旧版同步停机在真机要
#                              跑好几秒甚至更久，页面桥接被一直占着，状态/
#                              二维码轮询全堵在后面，页面直接假死，要反复
#                              清后台两三次才能重开——走这条路才不会堵。
#                              「重启/清除登录态」后续的启动与本轮清扫的
#                              交叠由清扫的启动节拍护栏兜底（见下）。
#   stop_qqbot.sh --inline  —— 同步执行完整停止，返回时保证已停干净。
#                              需要"停完再继续"的内部调用方走这条路
#                              （uninstall.sh 卸载模块前调用）。
# 可手动执行: sh /data/adb/modules/qqbot-magisk/files/stop_qqbot.sh
DATA=/data/qqbot
ROOTFS=$DATA/rootfs

if [ "$1" != "--inline" ]; then
  echo "正在后台停止 QQ 机器人…（进度见 /data/qqbot/logs/stop.log）"
  mkdir -p "$DATA/logs" 2>/dev/null
  setsid /system/bin/sh "$0" --inline </dev/null >>"$DATA/logs/stop.log" 2>&1 &
  exit 0
fi

kill_pidfile() {
  f=$1
  [ -f "$f" ] || return 0
  pid=$(cat "$f" 2>/dev/null)
  rm -f "$f"
  [ -n "$pid" ] || return 0
  PIDS="$PIDS $pid"
  # 进程是用 setsid 起的独立进程组，整组杀掉（连看门狗循环一起）
  kill -TERM -"$pid" 2>/dev/null
  kill -TERM "$pid" 2>/dev/null
}

# ===== 进程清扫（qqbot-sweep: stop_qqbot.sh 与 updater.sh 各一份，内容必须一致） =====
# pid 文件/进程组只能杀掉"记录在案"的那棵进程树。真机出过事故: 更新重启与
# 看门狗抢拉撞车，多出一个不在任何 pid 文件里的 bot 孤儿进程——它不是看门狗
# 的子进程、整组杀杀不到，又是旧版不认 bot v4 的单实例锁，于是和新版一起
# 各回一条消息。清扫不靠 pid 文件，按 /proc 逐个进程核对命令行精确令牌:
#   bot 本体: 某个参数正好是 /root/qqbot/bot.js 且 argv[0] 含 node
#   看门狗:   某个参数正好是 /root/qqbot/start-bot.sh 且 argv[0] 含 sh
# 令牌按整行精确相等匹配（与更新器 find_bot_pid 同款，已在真机验证）:
# 命令行里只是"提到"该路径的排查 shell/grep 等，argv[0] 与令牌
# 都对不上，不会误杀；脚本自身的 argv 是脚本路径，同样对不上。
# v5 提速: 一轮枚举同时分出 bot 与看门狗（旧版两个函数各扫一遍 /proc、
# 每进程 fork 两三条管道，真机一轮要好几秒）；匹配改在 shell 内做字符串
# 比较，只有命中令牌的少数进程才多取一次 argv[0]。最多两轮，每轮先 TERM
# 全部目标、等 1 秒再 KILL 残留（防看门狗在窗口里又拉起一个 bot，下一轮
# 或本轮 KILL 段收尾）。结束时把仍残留的 bot pid 打到 stdout（正常应
# 为空），调用方据此记日志/告警。
# QQBOT_SWEEP_GUARD（可选，进程启动节拍）: 晚于该节拍启动的进程跳过。
# stop_qqbot.sh 在 --inline 时把它设为自身启动节拍——WebUI「重启」是
# 先停后起，新拉起的看门狗/bot 不能被还在跑的上一轮清扫误杀；
# 更新器不设此变量，行为与旧版一致（见到的目标全杀）。
_QQBOT_NL='
'
_qqbot_starttime() { # <pid>: 输出进程启动节拍（stat 第 22 字段），读不到输出 0
  _s=$(cat "/proc/$1/stat" 2>/dev/null) || { echo 0; return; }
  _s=${_s##*')'}
  set -- $_s
  if [ $# -ge 20 ]; then echo "${20}"; else echo 0; fi
}
qqbot_pids_all() {
  # 一轮 /proc 枚举，逐行输出命中的 "b:<pid>"（bot）/ "w:<pid>"（看门狗）
  for _d in /proc/[0-9]*; do
    [ -r "$_d/cmdline" ] || continue
    _cmd=$(tr '\0' '\n' < "$_d/cmdline" 2>/dev/null)
    [ -n "$_cmd" ] || continue
    _tagged="$_QQBOT_NL$_cmd$_QQBOT_NL"
    _hit=""
    case "$_tagged" in *"$_QQBOT_NL/root/qqbot/bot.js$_QQBOT_NL"*) _hit=b ;; esac
    case "$_tagged" in *"$_QQBOT_NL/root/qqbot/start-bot.sh$_QQBOT_NL"*) _hit="${_hit}w" ;; esac
    [ -n "$_hit" ] || continue
    _pid=${_d#/proc/}
    if [ -n "$QQBOT_SWEEP_GUARD" ] && [ "$QQBOT_SWEEP_GUARD" != "0" ]; then
      _st=$(_qqbot_starttime "$_pid")
      [ "$_st" -gt "$QQBOT_SWEEP_GUARD" ] && continue
    fi
    _a0=$(printf '%s' "$_cmd" | head -n 1)
    case "$_hit" in
      *b*) case "$_a0" in *node*) echo "b:$_pid" ;; esac ;;
    esac
    case "$_hit" in
      *w*) case "$_a0" in *sh*) echo "w:$_pid" ;; esac ;;
    esac
  done
}
_qqbot_scan() { # 把一轮枚举结果收进 _SCAN_B / _SCAN_W（空格分隔的 pid 串）
  _SCAN_B=""; _SCAN_W=""
  for _t in $(qqbot_pids_all); do
    case "$_t" in
      b:*) _SCAN_B="$_SCAN_B ${_t#b:}" ;;
      w:*) _SCAN_W="$_SCAN_W ${_t#w:}" ;;
    esac
  done
  _SCAN_B=${_SCAN_B# }
  _SCAN_W=${_SCAN_W# }
}
sweep_bot_processes() {
  _round=1
  while [ "$_round" -le 2 ]; do
    _qqbot_scan
    if [ -z "$_SCAN_B" ] && [ -z "$_SCAN_W" ]; then
      echo ""
      return 0
    fi
    # 先 TERM 重生者（看门狗）再 TERM 全部 bot，等 1 秒后 KILL 残留
    [ -n "$_SCAN_W" ] && kill $_SCAN_W 2>/dev/null
    [ -n "$_SCAN_B" ] && kill $_SCAN_B 2>/dev/null
    sleep 1
    _qqbot_scan
    [ -n "$_SCAN_W" ] && kill -KILL $_SCAN_W 2>/dev/null
    [ -n "$_SCAN_B" ] && kill -KILL $_SCAN_B 2>/dev/null
    _round=$((_round + 1))
  done
  _qqbot_scan
  echo "$_SCAN_B"
}
# ===== 进程清扫结束 =====

PIDS=""
kill_pidfile "$DATA/run/updater.pid"
kill_pidfile "$DATA/run/watcher.pid"
kill_pidfile "$DATA/run/bot.pid"
kill_pidfile "$DATA/run/napcat.pid"
sleep 2
# 兜底: 还没退的整组 KILL
for pid in $PIDS; do
  kill -KILL -"$pid" 2>/dev/null
done

# 启动节拍护栏: 本进程启动之后才出生的进程不是要停的旧进程，跳过——
# 防 WebUI 重启/清除登录态流程里新拉起的看门狗/bot 被本轮清扫误杀。
QQBOT_SWEEP_GUARD=$(_qqbot_starttime $$)

# 兜底清扫: pid 文件没记录到的看门狗/bot 孤儿进程（不在被杀的进程组里，
# 整组杀够不着），按 argv 逐个点名，保证停机后零 bot 进程
LEFT=$(sweep_bot_processes)
[ -n "$LEFT" ] && echo "警告: 仍有 bot 进程未停掉: $LEFT"

# 卸载 bind 挂载（只用懒卸载: 忙挂载也不会把停止流程卡住）
for m in dev/pts dev/shm dev sys proc shared sdcard; do
  umount -l "$ROOTFS/$m" 2>/dev/null
done

echo "QQ机器人已停止"
exit 0
