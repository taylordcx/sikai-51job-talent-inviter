# sikai-51job-talent-inviter

51job（前程无忧）企业端人才邀约自动化技能（Skill），供 AI 智能体（WorkBuddy / CodeBuddy 等）调用。顾问确认招聘岗位与邀约目标后，技能自动完成条件筛选、候选人搜索、卡片分析与「Hi」邀约，全程在顾问可见的真实浏览器窗口中执行。

## 功能

- **环境闸门**：启动前自动判定本地桌面 / 云端沙箱，只在合适环境走浏览器路线
- **岗位选择**：读取企业端已关联招聘岗位，由顾问下拉确认
- **邀约目标确认**：选岗后立即读取 Hi 聊余额并询问本轮邀约目标人数，预算 = min(余额, 目标)
- **条件筛选**：工作年限、年龄区间、现居地、期望工作地等，通过真实点击设置
- **候选人搜索与卡片分析**：抓取结果卡片，输出结构化候选人信息
- **批量 Hi 邀约**：`invite_batch.mjs` 串行邀约，预算耗尽 / 精选点数不足 / 已沟通即停，三重证据法（按钮变「继续聊」+ toast「消息发送成功」+ 点数下降）判定成功
- **邀约档案**：每轮输出 JSON / Markdown 邀约记录，便于回溯与去重

## 目录结构

```
SKILL.md                      # 技能入口：流程总纲与硬性规则
references/
  startup-selection.md        # 启动与选岗（含 1b 邀约目标确认）
  consultant-input.md         # 顾问输入约定
  search-workflow.md          # 搜索条件设置流程
  card-analysis.md            # 候选人卡片解析
  browser-workflow.md         # 浏览器路线与已验证工具链、踩坑记录
  default-residence.md        # 默认现居地省份清单
  demonstration-checks.md     # 演示核对清单
scripts/
  cdp_tools.mjs               # CDP 直连工具箱（connect/points/hi/type 等 12 个子命令）
  invite_batch.mjs            # 批量邀约（预算闸门 + 精选预判）
  start_browser.mjs           # 拉起带调试端口的真实 Chrome
  search_browser.mjs          # 页面元素侦察
  search_dom.mjs              # DOM 读取
  search_flow.py              # 搜索流程辅助
  consultant_search.py        # 顾问输入辅助
  browser_adapter.py          # 浏览器适配
  env_check.sh                # 环境闸门检测
```

## 使用前提

- macOS 本地桌面（需可见浏览器窗口）
- Node.js 22+（自带 WebSocket，无需额外依赖）
- 已登录 51job 企业端（ehire.51job.com）的 Chrome

## 快速上手

1. 将本目录放入技能目录（如 `~/.workbuddy/skills/`）
2. 在支持技能的 AI 助手中加载本技能
3. 按提示确认招聘岗位 → 确认本轮邀约目标 → 技能自动完成筛选、搜索与邀约

## 声明

本技能仅在企业账号正常权限内进行操作，不伪装指纹、不轮换 IP/账号、不绕过验证码、不导出 Cookie。请遵守 51job 平台规则使用。
