#!/usr/bin/env node
// 跨平台环境闸门：判定本轮会话跑在「顾问本机桌面」还是「云端 / 容器沙箱」。
// 判定结果决定能不能走本地真浏览器 + CDP 路线，必须在启动任何浏览器之前运行。
// 技能自带的 env_check.sh 只覆盖 macOS / Linux；Windows（以及任何没有 sh 的环境）一律优先跑本脚本。
//
// 用法：node scripts/env_check.mjs
// 退出码：0 = LOCAL_DESKTOP / LOCAL_DESKTOP_WIN / LOCAL_DESKTOP_WSL；3 = CLOUD_SANDBOX；4 = UNKNOWN

import { homedir, userInfo } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const platform = process.platform;
const user = userInfo().username;
const home = homedir();
const env = process.env;

function wsl() {
  if (platform !== 'linux') return false;
  try { return /microsoft|WSL/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

function realBrowserWin(env) {
  const c = [
    ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap(k =>
      env[k] ? [join(env[k], 'Google/Chrome/Application/chrome.exe')] : []),
    ...['PROGRAMFILES', 'PROGRAMFILES(X86)'].flatMap(k =>
      env[k] ? [join(env[k], 'Microsoft/Edge/Application/msedge.exe')] : []),
  ];
  return c.find(existsSync) || '';
}

function emit(verdict, action, extra = {}) {
  const lines = { OS: platform + (wsl() ? ' (WSL)' : ''), USER: user, HOME: home,
    DISPLAY: env.DISPLAY || '<empty>', CWD: process.cwd(), ...extra, VERDICT: verdict, ACTION: action };
  for (const [k, v] of Object.entries(lines)) console.log(`${k}=${v}`);
  const code = verdict.startsWith('LOCAL_DESKTOP') ? 0 : verdict === 'CLOUD_SANDBOX' ? 3 : 4;
  process.exit(code);
}

if (platform === 'darwin') {
  emit('LOCAL_DESKTOP',
    '走本地路线：真 Chrome + --remote-debugging-port=9222 + --user-data-dir 独立目录（推荐 $HOME/.agent-browser/profile-real，可持久化登录态），再用 scripts/cdp_tools.mjs 接管。浏览器窗口在顾问自己屏幕上，登录由顾问手动完成。');
}

if (platform === 'win32') {
  const exe = realBrowserWin(env);
  // 无人值守服务会话 / SYSTEM 账户运行 = 不是顾问桌面
  const serviceSession = env.SESSIONNAME === 'Services' || /^(SYSTEM|.*\\SYSTEM)$/.test(user);
  if (serviceSession)
    emit('CLOUD_SANDBOX',
      '当前在 Windows 服务会话（SESSIONNAME=Services 或 SYSTEM 账户）里运行，不是顾问的交互桌面。停止，不得启动浏览器；请顾问在本地工作区会话重跑。');
  emit('LOCAL_DESKTOP_WIN',
    '走本地 Windows 路线：用真 Chrome / Edge（不要用 agent-browser 的 Chrome for Testing，dev 版可能不出现在任务栏，顾问看不见窗口）。'
    + (exe ? `本机浏览器：${exe}。` : '未在常规路径找到 Chrome / Edge，先向顾问确认安装路径，不要自行下载浏览器。')
    + ' 启动必须走平台的「后台常驻任务」机制（如 run_in_background）：本类环境每条命令的进程树会在命令结束时被回收，spawn detached/unref 挡不住，普通后台启动的浏览器活不过一轮对话（2026-09-30 Windows 会话实例：试 3 个端口才靠后台任务稳住）。'
    + ' profile 固定用 %USERPROFILE%\\.51job-talent-inviter\\browser-profile；若报「配置文件正被另一个 Chrome 进程使用」，先 taskkill 清僵尸进程后复用原目录，禁止新建全新 profile 目录绕过（会静默丢失登录态）。'
    + ' 启动后必须请顾问确认能在自己屏幕上看到窗口，看不到即视为不可见环境，停止。',
    { REAL_BROWSER: exe || '<not-found>' });
}

if (platform === 'linux') {
  if (wsl())
    emit('LOCAL_DESKTOP_WSL',
      '这是 Windows 上的 WSL，不是独立 Linux。浏览器必须在 Windows 侧启动（真 chrome.exe / msedge.exe，可用 wsl.exe 或让顾问在 PowerShell 里起），profile 放 Windows 用户目录；不要在 WSL 里装 Chromium。登录由顾问在 Windows 桌面上完成，启动后请顾问确认窗口可见。');
  emit('CLOUD_SANDBOX',
    '停止。不得 apt-get/yum 安装 xvfb、x11vnc、novnc、websockify，不得新建虚拟显示，不得在本环境后台起 Chromium。请如实向顾问说明：本轮命令跑在云端沙箱，不是他电脑上的窗口，登录态也只在沙箱里；请他在本地工作区新建会话重跑本技能。');
}

emit('UNKNOWN', '无法判定环境。按失败处理，向顾问说明缺项，不要猜、不要起浏览器。');
