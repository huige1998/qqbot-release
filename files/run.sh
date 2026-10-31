#!/system/bin/sh
# =====================================================================
# /data/qqbot/bin/run.sh —— 运行时入口
# service.sh 只做两件事: 把运行时脚本从模块种到 /data/qqbot/bin/，然后拉起
# run.sh。run.sh 负责: 初始化版本状态 -> 拉起云更新守护 -> 未装环境则拉
# 安装器、已装则拉 start_qqbot.sh。本脚本属于 OTA 可更新脚本集合，
# 但它很短命（开机跑一次就结束），替换它不会影响正在运行的进程。
# 用法: run.sh [模块目录]（service.sh 会传；缺省用标准模块路径）
# =====================================================================
MODDIR=${1:-/data/adb/modules/qqbot-magisk}
DATA=/data/qqbot
BIN=$DATA/bin
LOGS=$DATA/logs

mkdir -p "$DATA" "$BIN" "$DATA/run" "$DATA/shared" "$LOGS" 2>/dev/null
exec >>"$LOGS/run.log" 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] run.sh 启动 (MODDIR=$MODDIR)"

pkgv() { # pkgv BOT_VER|SCRIPTS_VER —— 模块自带的出厂版本号
  v=$(grep "^$1=" "$MODDIR/files/pkg_versions.txt" 2>/dev/null | tail -n 1 | cut -d= -f2 | tr -d ' \r')
  echo "${v:-2}"
}

# ---- 版本状态初始化 ----------------------------------------------------
# 从 v1.0 升上来时: 环境已装好但 versions.txt 还不存在，rootfs 里的 bot.js
# 还是旧版（记为 1），等更新器把它 OTA 到最新；bin 脚本刚从新模块种下，
# 版本就是模块自带版本。全新安装时这里还没有 .installed，先不写，
# 由 install_env.sh 在装完时按出厂版本写。
if [ ! -f "$DATA/versions.txt" ] && [ -f "$DATA/.installed" ]; then
  printf 'bot=1\nscripts=%s\n' "$(pkgv SCRIPTS_VER)" > "$DATA/versions.txt"
  echo "初始化 versions.txt: bot=1 scripts=$(pkgv SCRIPTS_VER)（v1.0 升级路径）"
fi

# ---- 云更新守护（单实例） ----------------------------------------------
UPDPID=$DATA/run/updater.pid
upd_alive=0
if [ -f "$UPDPID" ]; then
  p=$(cat "$UPDPID" 2>/dev/null)
  # 只认"活着且命令行带 qqbot"的 pid，防 pid 复用误判（同 start_qqbot 的 alive）
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null && \
     tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q qqbot; then
    upd_alive=1
  fi
fi
if [ "$upd_alive" != "1" ] && [ -f "$BIN/updloop.sh" ]; then
  setsid /system/bin/sh "$BIN/updloop.sh" </dev/null >/dev/null 2>&1 &
  echo $! > "$UPDPID"
  echo "云更新守护已拉起 pid=$(cat "$UPDPID")"
fi

# ---- 分流: 未装 -> 安装器；已装 -> 启动机器人 ----------------------------
if [ ! -f "$DATA/.installed" ]; then
  echo "环境未安装，拉起 install_env.sh"
  nohup /system/bin/sh "$MODDIR/files/install_env.sh" >>"$LOGS/install-boot.log" 2>&1 &
  exit 0
fi

exec /system/bin/sh "$BIN/start_qqbot.sh"
