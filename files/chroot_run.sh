#!/system/bin/sh
# 在容器里执行一个脚本（被 start_qqbot.sh 用 setsid 拉起，保证进程组独立、pid 可跟踪）
# 用法: chroot_run.sh /root/qqbot/xxx.sh
ROOTFS=/data/qqbot/rootfs
exec chroot "$ROOTFS" /usr/bin/env -i HOME=/root TERM=xterm \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  /bin/bash --noprofile --norc "$1"
