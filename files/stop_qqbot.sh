#!/system/bin/sh
# 停止 QQ 机器人: 依次停 二维码/日志同步守护、机器人看门狗、NapCat，最后卸载容器挂载。
# pid 文件整组杀之后再做一轮按 argv 的进程清扫，杀掉不在任何 pid 文件里的
# 看门狗/bot 孤儿进程，保证停机后零 bot 进程（见下方 qqbot-sweep 段落）。
# 可手动执行: sh /data/adb/modules/qqbot-magisk/files/stop_qqbot.sh
DATA=/data/qqbot
ROOTFS=$DATA/rootfs

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
# 令牌按整行精确相等匹配（grep -qx，与更新器 find_bot_pid 同款，已在真机
# 验证）: 命令行里只是"提到"该路径的排查 shell/grep 等，argv[0] 与令牌
# 都对不上，不会误杀；脚本自身的 argv 是脚本路径，同样对不上。
bot_pids_all() {
  for _d in /proc/[0-9]*; do
    [ -r "$_d/cmdline" ] || continue
    if tr '\0' '\n' < "$_d/cmdline" 2>/dev/null | grep -qx '/root/qqbot/bot.js'; then
      _exe=$(tr '\0' '\n' < "$_d/cmdline" 2>/dev/null | head -n 1)
      case "$_exe" in *node*) echo "${_d#/proc/}" ;; esac
    fi
  done
}
watchdog_pids_all() {
  for _d in /proc/[0-9]*; do
    [ -r "$_d/cmdline" ] || continue
    if tr '\0' '\n' < "$_d/cmdline" 2>/dev/null | grep -qx '/root/qqbot/start-bot.sh'; then
      _exe=$(tr '\0' '\n' < "$_d/cmdline" 2>/dev/null | head -n 1)
      case "$_exe" in *sh*) echo "${_d#/proc/}" ;; esac
    fi
  done
}
# 先 TERM 重生者（看门狗）再 TERM 全部 bot，等 2 秒后 KILL 残留，之后再
# 复查一轮（防看门狗在被 KILL 前的窗口里又拉起一个 bot）。结束时把仍
# 残留的 bot pid 打到 stdout（正常应为空），调用方据此记日志/告警。
sweep_bot_processes() {
  _w=$(watchdog_pids_all); [ -n "$_w" ] && kill $_w 2>/dev/null
  _b=$(bot_pids_all);      [ -n "$_b" ] && kill $_b 2>/dev/null
  sleep 2
  _w=$(watchdog_pids_all); [ -n "$_w" ] && kill -KILL $_w 2>/dev/null
  _b=$(bot_pids_all);      [ -n "$_b" ] && kill -KILL $_b 2>/dev/null
  sleep 1
  _b=$(bot_pids_all)
  if [ -n "$_b" ]; then
    _w=$(watchdog_pids_all); [ -n "$_w" ] && kill -KILL $_w 2>/dev/null
    kill -KILL $_b 2>/dev/null
    sleep 1
    _b=$(bot_pids_all)
  fi
  echo "$_b"
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

# 兜底清扫: pid 文件没记录到的看门狗/bot 孤儿进程（不在被杀的进程组里，
# 整组杀够不着），按 argv 逐个点名，保证停机后零 bot 进程
LEFT=$(sweep_bot_processes)
[ -n "$LEFT" ] && echo "警告: 仍有 bot 进程未停掉: $LEFT"

# 卸载 bind 挂载（懒卸载兜底）
for m in dev/pts dev/shm dev sys proc shared sdcard; do
  umount "$ROOTFS/$m" 2>/dev/null || umount -l "$ROOTFS/$m" 2>/dev/null
done

echo "QQ机器人已停止"
exit 0
