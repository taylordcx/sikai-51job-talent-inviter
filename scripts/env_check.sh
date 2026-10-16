#!/bin/sh
# 判定本轮会话的命令行跑在「顾问本机桌面」还是「云端 / 容器沙箱」。
# 判定结果决定能不能走本地真 Chrome + CDP 路线，必须在启动任何浏览器之前运行。
#
# 优先用跨平台版：node scripts/env_check.mjs（覆盖 macOS / Windows / Linux+WSL）。
# 本 sh 版只在有 sh 的环境使用；Windows 上的 Git Bash/MSYS 会落到下方 Windows 分支。
#
# 退出码：
#   0 = LOCAL_DESKTOP / LOCAL_DESKTOP_WIN / LOCAL_DESKTOP_WSL（顾问本机，可用本地浏览器 + 9222）
#   3 = CLOUD_SANDBOX（云端或容器，禁止在本环境内起浏览器；见下方说明）
#   4 = UNKNOWN（信息不足，按失败处理，不要猜）

os=$(uname -s 2>/dev/null || echo unknown)
user=$(whoami 2>/dev/null || echo unknown)
home=${HOME:-}

echo "OS=$os"
echo "USER=$user"
echo "HOME=$home"
echo "DISPLAY=${DISPLAY:-<empty>}"
echo "CWD=$(pwd)"

cloud_mark=""
command -v apt-get >/dev/null 2>&1 && cloud_mark="$cloud_mark apt-get"
command -v yum     >/dev/null 2>&1 && cloud_mark="$cloud_mark yum"
command -v apk     >/dev/null 2>&1 && cloud_mark="$cloud_mark apk"
[ "$home" = "/root" ] && cloud_mark="$cloud_mark home-is-root"
[ "$user" = "root" ] && cloud_mark="$cloud_mark user-is-root"

chrome_mac="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
chrome_ok="no"
[ -x "$chrome_mac" ] && chrome_ok="yes"

echo "LINUX_PKG_MGRS=${cloud_mark:-<none>}"
echo "MAC_CHROME=$chrome_ok"

if [ "$os" = "Darwin" ]; then
  echo "VERDICT=LOCAL_DESKTOP"
  echo "ACTION=走本地路线：真 Chrome + --remote-debugging-port=9222 + --user-data-dir 独立目录（推荐 /Users/\$USER/.agent-browser/profile-real，可持久化登录态），再用 scripts/cdp_tools.mjs 接管。浏览器窗口在顾问自己屏幕上，登录由顾问手动完成。"
  exit 0
fi

# Windows 上的 Git Bash / MSYS / Cygwin：uname -s 形如 MINGW64_NT-10.0-19045 / MSYS_NT-... / CYGWIN_NT-...
case "$os" in
  MINGW*|MSYS*|CYGWIN*)
    echo "VERDICT=LOCAL_DESKTOP_WIN"
    echo "ACTION=本地 Windows 路线：用真 Chrome/Edge（不要用 Chrome for Testing，dev 版可能不出现在任务栏）。启动必须走平台后台常驻任务：本类环境每条命令的进程树会在命令结束时被回收，spawn detached/unref 挡不住（2026-09-30 实例：试 3 个端口才靠后台任务稳住）。profile 固定 \$USERPROFILE/.51job-talent-inviter/browser-profile；报「配置文件正被另一个 Chrome 进程使用」时先 taskkill 清僵尸再复用原目录，禁止新建全新 profile 目录绕过（会静默丢登录态）。启动后必须请顾问确认屏幕上能看到窗口，看不到即停止。"
    exit 0
    ;;
esac

# WSL：uname -s 是 Linux，但 /proc/version 含 microsoft —— 不能按 CLOUD_SANDBOX 误判
if [ "$os" = "Linux" ] && [ -r /proc/version ] && grep -qiE 'microsoft|WSL' /proc/version 2>/dev/null; then
  echo "VERDICT=LOCAL_DESKTOP_WSL"
  echo "ACTION=这是 Windows 上的 WSL，不是独立 Linux。浏览器必须在 Windows 侧启动（真 chrome.exe/msedge.exe），profile 放 Windows 用户目录；不要在 WSL 里装 Chromium。登录由顾问在 Windows 桌面完成，启动后请顾问确认窗口可见。"
  exit 0
fi

if [ "$os" = "Linux" ]; then
  echo "VERDICT=CLOUD_SANDBOX"
  echo "ACTION=停止。不得 apt-get/yum 安装 xvfb、x11vnc、novnc、websockify，不得新建虚拟显示，不得在本环境后台起 Chromium。请如实向顾问说明：本轮命令跑在云端沙箱，不是他电脑上的窗口，登录态也只在沙箱里；请他在本地工作区新建会话重跑本技能。"
  exit 3
fi

echo "VERDICT=UNKNOWN"
echo "ACTION=无法判定环境。按失败处理，向顾问说明缺项，不要猜、不要起浏览器。"
exit 4
