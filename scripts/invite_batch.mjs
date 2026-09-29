#!/usr/bin/env node
// invite_batch.mjs — 按预算串行邀约，自动停（2026-09-29 完善）
//
// 用法：
//   node invite_batch.mjs --cards "0,1,3,5" --budget 3
//   node invite_batch.mjs --cards "0..4" --budget 5           # 连续范围
//   node invite_batch.mjs --cards "0,1" --budget 5 --dry     # 只读不点
//
// 设计：
//   - 调用 cdp_tools.mjs hi，每次传入当前剩余预算 --budget N
//   - 遇 budget_exceeded / budget_insufficient_for_featured / 失败 / 已沟通 自动停
//   - 输出 JSON 含本轮预算扣点、剩余、每个候选人结果
//   - 推荐搭档：先跑 `node cdp_tools.mjs points` 读点数 → AskUserQuestion 让顾问指定
//     "邀约人数 K" → 实际预算 = min(点数, K)；精选项多的话会被告知只够 math.floor(points/2)
//
// 依赖：与 cdp_tools.mjs 同目录

import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
const dryRun = argv.includes("--dry") || argv.includes("--dry-run");
const cardsSpec = arg("--cards", "");
const budget = parseInt(arg("--budget", "0"));

if (!cardsSpec) {
  console.error("usage: node invite_batch.mjs --cards '0,1,3,5' [--budget N] [--dry]");
  process.exit(1);
}

// 解析 cards：支持 "0,1,3" 与 "0..4"
const cards = [];
for (const part of cardsSpec.split(",")) {
  const t = part.trim();
  if (!t) continue;
  if (t.includes("..")) {
    const [a, b] = t.split("..").map(Number);
    for (let i = a; i <= b; i++) cards.push(i);
  } else {
    cards.push(parseInt(t));
  }
}
if (!cards.length) { console.error("cards list is empty"); process.exit(1); }

// 1. 读点数
const pt = spawnSync(process.execPath, ["scripts/cdp_tools.mjs", "points"], { encoding: "utf8" });
let points = null;
try { points = JSON.parse(pt.stdout).points; } catch (e) { console.error("points read failed:", pt.stdout, pt.stderr); process.exit(1); }
const initialBudget = budget > 0 ? Math.min(budget, points ?? budget) : points ?? 0;

// 2. 串行邀约
let remaining = initialBudget;
const log = [];
let stoppedReason = null;

console.error(`# 初始点数: ${points}  本次预算: ${initialBudget}  候选: [${cards.join(", ")}]  dry=${dryRun}`);

for (const idx of cards) {
  if (remaining <= 0) { stoppedReason = `budget_exhausted_before_${idx}`; break; }
  if (dryRun) {
    console.error(`[dry] would hi #${idx} (budget=${remaining})`);
    log.push({ cardIndex: idx, dry: true, budgetAtCall: remaining });
    continue;
  }
  const r = spawnSync(process.execPath, ["scripts/cdp_tools.mjs", "hi", String(idx), "--budget", String(remaining)], { encoding: "utf8" });
  let result = {};
  try { result = JSON.parse(r.stdout); } catch (e) {
    log.push({ cardIndex: idx, parseError: true, raw: r.stdout, stderr: r.stderr });
    stoppedReason = `parse_error_at_${idx}`;
    break;
  }
  log.push(result);
  if (result.skipped === "budget_exceeded" || result.skipped === "budget_insufficient_for_featured") {
    stoppedReason = `${result.skipped}_at_${idx}`;
    break;
  }
  if (result.verdict && result.verdict.startsWith("结果待确认")) {
    stoppedReason = `uncertain_at_${idx}`;
    break;
  }
  if (result.budgetExhausted) { stoppedReason = `budget_exhausted_at_${idx}`; break; }
  if (typeof result.budgetRemaining === "number") remaining = result.budgetRemaining;
}

// 3. 汇总
const summary = {
  initialPoints: points,
  initialBudget,
  finalBudgetRemaining: remaining,
  processed: log.length,
  succeeded: log.filter(x => x.verdict === "已发起Hi").length,
  featuredSent: log.filter(x => x.verdict === "已发起Hi" && x.featured).length,
  skipped: log.filter(x => x.skipped || x.skip).length,
  stoppedReason,
  log
};

console.log(JSON.stringify(summary, null, 1));
if (stoppedReason && !dryRun && summary.succeeded === 0) process.exit(2);