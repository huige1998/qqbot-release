#!/system/bin/sh
# =====================================================================
# 启动 QQ 机器人: 挂载容器目录 -> chroot 里起 NapCat -> 等 WS 端口 3001
# -> 起机器人看门狗 -> 起一个后台小循环(同步二维码和日志到 /sdcard/qqbot)
# 幂等: 已经在跑就直接退出。所有输出进 /data/qqbot/logs/。
# =====================================================================
MODDIR=${0%/*}
# chroot_run.sh 就在自己旁边：从模块 files/ 跑或从 /data/qqbot/bin 跑都成立
CHROOT_RUN=$MODDIR/chroot_run.sh
[ -f "$CHROOT_RUN" ] || CHROOT_RUN=/data/qqbot/bin/chroot_run.sh

DATA=/data/qqbot
ROOTFS=$DATA/rootfs
RUN=$DATA/run
LOGS=$DATA/logs
SD=/sdcard/qqbot

mkdir -p "$RUN" "$LOGS" "$SD/logs" 2>/dev/null
exec >>"$LOGS/start.log" 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] start_qqbot 开始"

pid_ours() { # pid_ours <pid>: 活着且命令行带 qqbot 字样才算数（防 pid 被系统回收复用后误判"还在跑"）
  [ -n "$1" ] || return 1
  kill -0 "$1" 2>/dev/null || return 1
  tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -q qqbot
}
alive() { # alive <pidfile>
  [ -f "$1" ] || return 1
  pid_ours "$(cat "$1" 2>/dev/null)"
}

if alive "$RUN/napcat.pid"; then
  echo "已在运行，跳过"
  exit 0
fi
[ -f "$DATA/.installed" ] || { echo "环境未安装完成，等 install_env"; exit 0; }
[ -x "$ROOTFS/opt/QQ/qq" ] || { echo "rootfs 不完整，退出"; exit 1; }

# ---- 挂载（已挂的跳过） ----------------------------------------------
ismounted() { grep -q " $1 " /proc/mounts 2>/dev/null; }
domount() { # domount <类型/源> <目标> [bind]
  if ismounted "$2"; then return 0; fi
  mkdir -p "$2" 2>/dev/null
  if [ "$3" = "bind" ]; then mount -o bind "$1" "$2" 2>/dev/null
  else mount -t "$1" "$1" "$2" 2>/dev/null; fi
  ismounted "$2" || echo "警告: 挂载 $2 失败"
}
domount proc "$ROOTFS/proc"
domount sysfs "$ROOTFS/sys"
domount /dev "$ROOTFS/dev" bind
domount /dev/pts "$ROOTFS/dev/pts" bind
if ! ismounted "$ROOTFS/dev/shm"; then
  mkdir -p "$ROOTFS/dev/shm"
  mount -t tmpfs -o size=256m tmpfs "$ROOTFS/dev/shm" 2>/dev/null
fi
domount /data/media/0 "$ROOTFS/sdcard" bind
# 云更新共享目录: 宿主机 /data/qqbot/shared <-> 容器内 /shared
# （bot.js 在容器里往 /shared 写 update.request / 读 update.status）
mkdir -p "$DATA/shared" "$ROOTFS/shared" 2>/dev/null
domount "$DATA/shared" "$ROOTFS/shared" bind

# ---- 起 NapCat --------------------------------------------------------
setsid /system/bin/sh "$CHROOT_RUN" /root/qqbot/start-napcat.sh </dev/null >/dev/null 2>&1 &
echo $! > "$RUN/napcat.pid"
echo "NapCat 已拉起 pid=$(cat "$RUN/napcat.pid")，等端口 3001…"
echo "机器人启动中；首次登录请打开 内部存储/qqbot/qrcode.png 扫码" > "$SD/status.txt"

# ---- 等 WS 端口 3001 (0x0BB9) 进入 LISTEN，最多 180 秒 ----------------
i=0
while [ $i -lt 36 ]; do
  if cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '$2 ~ /:0BB9$/ && $4 == "0A" {f=1} END {exit !f}'; then
    echo "端口 3001 已监听"
    break
  fi
  sleep 5
  i=$((i + 1))
done
[ $i -ge 36 ] && echo "警告: 180 秒内 3001 没起来，看 napcat.log 排查（机器人仍会启动并自动重连）"

# ---- 起机器人看门狗 ----------------------------------------------------
setsid /system/bin/sh "$CHROOT_RUN" /root/qqbot/start-bot.sh </dev/null >/dev/null 2>&1 &
echo $! > "$RUN/bot.pid"
echo "机器人看门狗已拉起 pid=$(cat "$RUN/bot.pid")"

# ---- 后台小循环: 同步二维码 + 日志到 /sdcard ---------------------------
if ! alive "$RUN/watcher.pid"; then
  setsid /system/bin/sh -c '
    ROOTFS='"$ROOTFS"'; SD='"$SD"'; LOGS='"$LOGS"'; LAST=""
    while true; do
      # 找最近修改的二维码图片（NapCat 未登录时会在容器里生成 qrcode png，
      # 具体路径随版本不同，用 find 全容器范围匹配兜底）
      f=$(find "$ROOTFS/root" "$ROOTFS/tmp" "$ROOTFS/home" "$ROOTFS/opt" \
            -type f \( -iname "*qrcode*.png" -o -iname "*qr_code*.png" -o -iname "qr*.png" \) \
            -mmin -30 2>/dev/null | head -n 1)
      if [ -n "$f" ]; then
        sig=$(wc -c < "$f" 2>/dev/null)
        if [ "$sig" != "$LAST" ]; then
          cp "$f" "$SD/qrcode.png" 2>/dev/null && LAST=$sig
        fi
      fi
      # 镜像日志，用户不用 root 就能看
      cp "$ROOTFS/root/qqbot/napcat.log" "$SD/logs/napcat.log" 2>/dev/null
      cp "$ROOTFS/root/qqbot/bot.log" "$SD/logs/bot.log" 2>/dev/null
      cp "$LOGS/start.log" "$SD/logs/start.log" 2>/dev/null
      cp "$LOGS/update.log" "$SD/logs/update.log" 2>/dev/null
      sleep 10
    done
  ' </dev/null >/dev/null 2>&1 &
  echo $! > "$RUN/watcher.pid"
  echo "二维码/日志同步循环已拉起 pid=$(cat "$RUN/watcher.pid")"
fi

echo "机器人已上线；在群里发「搜 片名」测试" > "$SD/status.txt"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] start_qqbot 完成"
exit 0
