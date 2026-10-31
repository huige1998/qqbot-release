#!/system/bin/sh
# 停止 QQ 机器人: 依次停 二维码/日志同步守护、机器人看门狗、NapCat，最后卸载容器挂载。
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

# 卸载 bind 挂载（懒卸载兜底）
for m in dev/pts dev/shm dev sys proc shared sdcard; do
  umount "$ROOTFS/$m" 2>/dev/null || umount -l "$ROOTFS/$m" 2>/dev/null
done

echo "QQ机器人已停止"
exit 0
