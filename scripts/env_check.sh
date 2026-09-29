#!/bin/sh
# 判定本轮会话的命令行跑在「顾问本机桌面」还是「云端 / 容器沙箱」。
# 判定结果决定能不能走本地真 Chrome + CDP 路线，必须在启动任何浏览器之前运行。
#
# 退出码：
#   0 = LOCAL_DESKTOP（顾问本机，可用本地 Chrome + 9222）
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

if [ "$os" = "Linux" ]; then
  echo "VERDICT=CLOUD_SANDBOX"
  echo "ACTION=停止。不得 apt-get/yum 安装 xvfb、x11vnc、novnc、websockify，不得新建虚拟显示，不得在本环境后台起 Chromium。请如实向顾问说明：本轮命令跑在云端沙箱，不是他电脑上的窗口，登录态也只在沙箱里；请他在本地工作区新建会话重跑本技能。"
  exit 3
fi

echo "VERDICT=UNKNOWN"
echo "ACTION=无法判定环境。按失败处理，向顾问说明缺项，不要猜、不要起浏览器。"
exit 4
