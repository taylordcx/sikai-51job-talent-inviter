# 顾问条件与页面状态

期望工作地默认义乌＋杭州；顾问明确指定地点、要求清除或保留现有地点时覆盖默认值。当前居住地另按[默认范围](default-residence.md)由浏览器工具设置；工作年限由顾问每次选择。其他业务值由顾问本次提供，不从截图或历史岗位补齐。岗位列表来自当次真实页面，不使用演示列表执行真实操作。

## 命令

在技能目录运行：

```sh
python3 -B scripts/consultant_search.py template
python3 -B scripts/consultant_search.py plan --request request.json --state before.json
python3 -B scripts/consultant_search.py verify --plan plan.json --state after.json
```

上述三个离线命令输出JSON到标准输出，不连接账号，不发送消息。`plan` 输出由执行者保存为 `plan.json`；`verify` 成功只表示条件匹配，不表示已搜索。不要将输出伪装成真实网页执行记录。

## 顾问输入

请求模板如下。计划生成时，如未指定、清除或保留地点，会自动加入义乌和杭州；未选择岗位时明确停止：

```json
{"job_key": null, "filters": {}, "clear": [], "keep": []}
```

字段含义：

| 字段 | 内容 |
|---|---|
| job_key | 读取的岗位唯一标识；不能用名字子串代替 |
| filters.keywords | 顾问指定的完整关键词文本，不自动扩词 |
| filters.desired_locations | 顾问指定的期望工作地点列表，与现居住地分开 |
| filters.current_locations | 顾问指定的现居住地列表 |
| filters.experience | 顾问选择且页面实际支持的工作年限文案 |
| filters.education | 顾问选择且页面实际支持的学历文案 |
| filters.active_within | 顾问选择且页面实际支持的活跃时间文案 |
| clear | 明确要求清除的已有条件字段名列表 |
| keep | 明确要求保留的已有条件字段名列表 |

同一字段不能同时填写、清除和保留。空字符串不表示清除；使用 `clear`。未指定且页面没有的条件保持不限；未指定但页面已有的条件必须先解决，工具不会默默继承。

## 页面状态契约

`jobs` 从真实页面返回以下结构；生产调用禁止手工编造页面状态：

```json
{
  "page": "talent-search",
  "blocked": false,
  "jobs_complete": false,
  "jobs": [],
  "selected_job": null,
  "filters": {}
}
```

`jobs` 每项包含 `key`、`name` 和实际读到的 `location` 等岗位信息。`jobs_complete` 只在已验证读取全部在招岗位后为真。`filters` 必须包含所有已生效条件；无法映射的条件以 `unmapped:原文标签` 记录，使计划停止，而不是丢弃。

网页适配器接口为 `read()`、`select_job(key)`、`set_filter(field, value)`、`search()`。`set_filter` 的 `None` 表示清除；接口不得包含联系、下载简历或关闭浏览器等附带动作。每一步返回前须等待页面更新，读取的是实际生效值而非上一帧或刚提交的内存值。

执行前核对计划与当前状态一致。选择岗位后若平台自动追加条件，读回检查必须发现差异；提交后再检查一次。任何未核实动作都不能汇报成功。


## 实际网页入口

默认先按[浏览器操作](browser-workflow.md)发现并调用平台浏览器工具打开招聘页面，不要求先运行脚本。仅当平台工具不可用且命令运行于顾问本地桌面电脑时，执行 `python3 -B scripts/consultant_search.py start-browser` 作为备用；浏览器已连接则复用。若显示登录页，顾问登录后再读取岗位。启动入口不提交搜索、不联系候选人。

```sh
python3 -B scripts/consultant_search.py jobs
python3 -B scripts/consultant_search.py prepare-browser --request request.json
python3 -B scripts/consultant_search.py search-browser --request request.json
```

通过已启动的本机浏览器调试端口操作当前企业端页，不用Apple事件开关。支持 `--port`（默认9222）及 `--target`。`jobs`会同时列出 `available` 中实际可选的年限、学历文案，顾问输入须映射到真实选项；“不限”使用 `clear`，不能作为已选值。期望工作地最多10项，按集合核对，不要求选择顺序相同。

目前网页可写字段只有 `keywords`、`desired_locations`、`experience`、`education`。`current_locations`和`active_within`可作为未来条件契约，但生产入口会在填写前明确拒绝，不能假装已支持。当前页面需要明确关键词，否则搜索按钮不启用；不使用提示文字填补关键词。

`job_key` 为完整页面选项组合生成的本次UI标识，不是跨会话稳定的平台岗位ID，也不能用作候选人标识。完全重复的选项不能可靠区分时停止；岗位清单变化后需重新读取。

`prepare-browser`读回当前页面后生成计划并填写；`search-browser`同样核对并填写，然后点击搜索，不调用旧联系程序，不保存联系计数。提交结果为 `search_submitted`，仅能报告已提交、当前条件已核对，不能报告真实候选人处理完成。

## 当前默认入口调整

用户要求仅从下拉选择招聘岗位，使用平台带出的搜索词，不手动重填关键词。上面的脚本命令是显式关键词搜索的可选入口，不是默认流程；不得为了满足脚本必填字段而覆盖平台搜索词。默认通过同一浏览器页面选岗位、设置顾问年限和默认居住地，最后核对期望工作地义乌＋杭州。

## 邀约预算确认（每次邀约前必做）

邀约前先读当前 Hi 聊点数，再用 AskUserQuestion 让顾问明确"这次最多邀约几人"，组合成预算：

```sh
node scripts/cdp_tools.mjs points
# 返回形如：
# { "points": 3, "canHireNonFeatured": 3, "canHireFeatured": 1, ... }

# 让顾问选 邀约人数 K（默认 N）
# 本轮预算 B = min(points, K)
# 若精选项可能多，提醒「若全是精选，只够 floor(points/2) 位」
```

然后串行邀约：

```sh
# --cards "0,3,5,7"    4 张指定卡号
# --cards "0..3"       4 张连续（0,1,2,3）
# --budget N           本次剩余邀约次数（≤0 时 hi 子命令自动拒发）
# --dry                只读不点
node scripts/invite_batch.mjs --cards "0,3,5" --budget $B
```

每次 `cdp_tools.mjs hi <idx> --budget N` 的返回结构里会有：

| 字段 | 含义 |
|---|---|
| `skipped: 'budget_exceeded'` | 预算 ≤ 0，子命令拒发 |
| `skipped: 'budget_insufficient_for_featured'` | 卡带精选但预算 < 2，跳过本卡 |
| `featured: true` | 该候选人本次会扣 2 点 |
| `pointsConsumed` | 本次实际扣点（1 或 2） |
| `budgetRemaining` | 邀约后剩余预算 |
| `budgetExhausted: true` | 本次预算用完，邀约档不下发剩余卡片 |
| `verdict: '已发起Hi'` / `'结果待确认（…）'` | 三重证据 ≥ 2 算成功 |

**不要**为了「凑数」对预算不足的精选项强行点击——这会从下次点数里透支；也**不要**把"默认整轮最多查看 500 位"当成要翻满 500 张卡的指标。默认窗口是 500 张封顶、3 次成功即停。
