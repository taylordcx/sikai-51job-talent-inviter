#!/usr/bin/env node
// cdp_tools.mjs — 51job 企业端「人才搜索」页的 CDP 直连工具集（2026-09-28/29 全流程实测验证）
//
// 前置条件：
//   1. 一份带 9222 远程调试端口的真 Chrome 已在跑（启动方式见 references/browser-workflow.md）
//   2. 已登录 51job 企业端，且存在一个 ehire.51job.com 的标签页
//   3. Node 22+（自带 WebSocket / fetch）
//
// 用法：
//   node cdp_tools.mjs eval "<短JS表达式>"        # 页内求值（短表达式；长表达式一律用 eval-file）
//   node cdp_tools.mjs eval-file <expr.js>        # 从文件读 JS 求值（推荐，避免 shell 引号坑）
//   node cdp_tools.mjs click <x> <y>              # 真实鼠标点击（mousePressed+mouseReleased）
//   node cdp_tools.mjs type <x> <y> <text>        # 点击坐标 → focus 该处 input/textarea → Cmd+A 全选 → 真实插入文本（Vue 表单必用；直接 .value= 会被 Vue 丢弃）
//   node cdp_tools.mjs fill <placeholder> <value> # 同上，按 placeholder 定位输入框
//   node cdp_tools.mjs shot <out.png>             # 截真标签的图（Page.captureScreenshot）
//   node cdp_tools.mjs esc                        # 给页面发 Escape 键
//   node cdp_tools.mjs cards [from] [to]          # 读结果卡片（.item.resume-card）文本行数组
//   node cdp_tools.mjs point <x> <y>              # 查询视口坐标处的元素（排查遮挡）
//   node cdp_tools.mjs points                     # 读 Hi 聊点数余额与扣点预算（结构化）
//   node cdp_tools.mjs provinces "省1,省2,..."    # 居住地弹窗内逐省选"全省"（三列级联）
//   node cdp_tools.mjs hi <cardIndex> [--budget N]# 对第 N 张卡片（0 起）点"立即Hi聊"并验证结果；可选 --budget N 控制本次剩余邀约次数（≤0 自动拒发）
//
// 设计要点（都是踩过的坑）：
//   - 只连"第一个 ehire.51job.com 的 page 标签"，即默认 context 里顾问登录着的那个；
//     不要用 agent-browser（它 connect 后建的是隔离 context 新标签，不共享登录 Cookie）。
//   - "立即Hi聊"按钮默认 display:none（悬停才显示），CDP 的 mouseMoved 触发不了 CSS 悬停；
//     hi 子命令先给按钮设内联样式强制显示，再真实点击。Vue 绑定的点击处理器不受影响。
//   - Hi 成功判据（至少两项）：卡片按钮变"继续聊"、toast"消息发送成功"、点数下降。
//   - 点数预算：基础 1 点 + 「精选」候选人额外扣 1-2 点（实测精选项扣 2 点）。points 子命令
//     返回 canHireNonFeatured/canHireFeatured 两个上限；hi 子命令用 --budget N 控制本次剩余
//     邀约次数，budget≤0 自动拒发；每次 hi 返回 budgetRemaining + pointsConsumed，让
//     invite_batch.mjs 这类串行脚本可按预算自动停。
//   - 截图必须用本工具的 shot（Page.captureScreenshot）；agent-browser screenshot 截的是
//     它自己隔离标签（拍出来是登录页），不能作数。

import { readFileSync, writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT || "9222";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const [cmd, ...args] = process.argv.slice(2);

// ---------- 连接 ----------
async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find(t => t.type === "page" && t.url.includes("ehire.51job.com"));
  if (!page) {
    console.error(`no ehire.51job.com page tab on port ${PORT}; tabs:`, list.map(t => t.type + ":" + t.url.slice(0, 60)).join(" | "));
    process.exit(1);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = e => j(new Error("ws error: " + (e.message || e))); });
  const evalJS = async expr => {
    const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error("page exception: " + JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails).slice(0, 400));
    return res.result.value;
  };
  const realClick = async (x, y) => {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
  };
  return { ws, send, evalJS, realClick, page };
}

// ---------- 子命令 ----------
const c = await connect();
console.error("tab:", c.page.title, "|", c.page.url.slice(-70));

try {
  switch (cmd) {
    case "eval": {
      const v = await c.evalJS(args[0]);
      console.log(typeof v === "string" ? v : JSON.stringify(v));
      break;
    }
    case "eval-file": {
      const expr = readFileSync(args[0], "utf8");
      const v = await c.evalJS(expr);
      console.log(typeof v === "string" ? v : JSON.stringify(v));
      break;
    }
    case "click": {
      const [x, y] = args.map(Number);
      await c.realClick(x, y);
      console.log(`clicked (${x}, ${y})`);
      break;
    }
    case "shot": {
      const res = await c.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(args[0] || "/tmp/cdp-shot.png", Buffer.from(res.data, "base64"));
      console.log("saved", args[0] || "/tmp/cdp-shot.png");
      break;
    }
    case "esc": {
      for (const key of ["rawKeyDown", "keyUp"]) {
        await c.send("Input.dispatchKeyEvent", { type: key, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      }
      console.log("escape sent");
      break;
    }
    case "focus": {
      // focus <x> <y>  —— 真实点击聚焦某坐标（用于 input 聚焦后再 type）
      const [x, y] = args.map(Number);
      await c.realClick(x, y);
      console.log(`focused (${x}, ${y})`);
      break;
    }
    case "type": {
      // type <x> <y> <text>  —— 真实点击聚焦 → focus() 强制接管焦点 → 全选清空 → insertText
      if (args.length < 3) { console.log("usage: type <x> <y> <text>"); break; }
      const cx = parseInt(args[0]), cy = parseInt(args[1]);
      const text = args.slice(2).join(" ");
      await c.realClick(cx, cy);
      await sleep(150);
      // 强制把焦点移到目标点上的 input/textarea（CDP click 不一定触发页面 focus）
      await c.evalJS(`(() => { const el = document.elementFromPoint(${cx}, ${cy}); const t = el && (el.closest ? el.closest('input,textarea') : null) || (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el : null); if (t) t.focus(); })()`);
      await sleep(100);
      // 全选清空（macOS Meta+A=4，Windows Ctrl+A=2，两个都发）
      for (const mod of [4, 2]) {
        await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: mod });
        await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: mod });
      }
      await c.send("Input.insertText", { text });
      await sleep(150);
      const back = await c.evalJS(`(() => { const el = document.elementFromPoint(${cx}, ${cy}); const t = el && (el.closest ? el.closest('input,textarea') : null) || (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el : null); return t ? t.value : null; })()`);
      console.log(JSON.stringify({ typed: text, readBack: back }));
      break;
    }
    case "fill": {
      // fill <placeholder> <value>  —— 组合：找元素 → 真实点击聚焦 → 全选清空 → insertText
      const ph = args[0];
      const val = args.slice(1).join(" ");
      const coord = await c.evalJS(`(() => { const el = [...document.querySelectorAll('input')].find(i => (i.placeholder||'') === ${JSON.stringify(ph)}); if (!el) return null; const r = el.getBoundingClientRect(); if (!r.width) return null; return Math.round(r.x + r.width/2) + ',' + Math.round(r.y + r.height/2); })()`);
      if (!coord) { console.log(JSON.stringify({ err: 'input_not_found', placeholder: ph })); break; }
      const [cx, cy] = coord.split(",").map(Number);
      await c.realClick(cx, cy);
      await sleep(200);
      // 全选清空（Ctrl/Cmd+A 在 macOS 用 Meta）
      for (const mod of [4, 2]) { // 4=Meta, 2=Ctrl —— 两个都发，兼容
        await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: mod });
        await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: mod });
      }
      await c.send("Input.insertText", { text: val });
      const back = await c.evalJS(`(() => { const el = [...document.querySelectorAll('input')].find(i => (i.placeholder||'') === ${JSON.stringify(ph)}); return el ? el.value : null; })()`);
      console.log(JSON.stringify({ placeholder: ph, typed: val, readBack: back }));
      break;
    }
    case "point": {
      const [x, y] = args.map(Number);
      const info = await c.evalJS(`(() => { const e = document.elementFromPoint(${x}, ${y}); if (!e) return null; let chain = []; let p = e; for (let i = 0; i < 4 && p; i++) { chain.push((p.tagName || '') + '.' + (p.className || '').toString().slice(0, 40)); p = p.parentElement; } return chain; })()`);
      console.log(JSON.stringify(info));
      break;
    }
    case "cards": {
      const from = args[0] ? parseInt(args[0]) : 0;
      const to = args[1] ? parseInt(args[1]) : from + 5;
      const v = await c.evalJS(`(() => { const cards = [...document.querySelectorAll('.item.resume-card')]; return JSON.stringify({ total: cards.length, cards: cards.slice(${from}, ${to}).map((c, i) => ({ i: i + ${from}, lines: c.innerText.split('\\n').filter(Boolean) })) }); })()`);
      console.log(v);
      break;
    }
    case "points": {
      const v = await c.evalJS(`(() => { const box = [...document.querySelectorAll('*')].find(e => /Hi聊点数/.test((e.innerText||'')) && e.children.length <= 3); if (!box) return null; const m = box.innerText.match(/Hi聊点数\\D*(\\d+)/); return m ? +m[1] : null; })()`);
      // 结构化返回：基础 1 点 / 精选项 2 点；预算用 canHireNonFeatured 与 canHireFeatured 两个上限
      const n = typeof v === 'number' ? v : null;
      console.log(JSON.stringify({
        points: n,
        canHireNonFeatured: n,
        canHireFeatured: n !== null ? Math.floor(n / 2) : null,
        rule: "基础扣 1 点；精选项额外 +1（共 2 点）；建议非精选项 ≤ points、精选项 ≤ floor(points/2)"
      }, null, 1));
      break;
    }
    case "provinces": {
      const provinces = (args[0] || "").split(/[,，]/).map(s => s.trim()).filter(Boolean);
      if (!provinces.length) { console.error('usage: cdp_tools.mjs provinces "湖北,湖南,..."'); process.exit(1); }
      const D = `(() => { const d = [...document.querySelectorAll('.el-dialog__wrapper')].find(e => e.className.includes('city_cascader_dialog') && e.getBoundingClientRect().width > 0); return d || null; })()`;
      const results = [];
      for (const prov of provinces) {
        if (!(await c.evalJS(`!!${D}`))) { results.push(`${prov}: dialog closed`); break; }
        // 列1：省份行（非 leaf），滚动到可见
        const coords = await c.evalJS(`(() => { const d = ${D}; if (!d) return null; const col1 = [...d.querySelectorAll('.cascader_panel_item')].filter(e => !e.className.includes('leaf') && ['${prov}', '${prov}省'].includes((e.innerText||'').trim())); if (!col1.length) return null; col1[0].scrollIntoView({block:'center'}); const r = col1[0].getBoundingClientRect(); return Math.round(r.x + r.width/2) + ',' + Math.round(r.y + r.height/2); })()`);
        if (!coords) { results.push(`${prov}: column-1 not found`); continue; }
        const [px, py] = coords.split(",").map(Number);
        await c.realClick(px, py); await sleep(600);
        // 列3：全省 leaf
        const leaf = await c.evalJS(`(() => { const d = ${D}; if (!d) return null; const ls = [...d.querySelectorAll('.cascader_panel_item.leaf')].filter(e => ['${prov}', '${prov}省'].includes((e.innerText||'').trim())); if (!ls.length) return null; const r = ls[ls.length-1].getBoundingClientRect(); return Math.round(r.x + r.width/2) + ',' + Math.round(r.y + r.height/2); })()`);
        if (!leaf) { results.push(`${prov}: leaf not found`); continue; }
        const [lx, ly] = leaf.split(",").map(Number);
        await c.realClick(lx, ly); await sleep(500);
        // 未选中则重试一次（首次点击有时只是激活）
        const ok = await c.evalJS(`(() => { const d = ${D}; if (!d) return false; const ls = [...d.querySelectorAll('.cascader_panel_item.leaf')].filter(e => ['${prov}', '${prov}省'].includes((e.innerText||'').trim())); if (!ls.length) return false; return ls[ls.length-1].className.includes('active'); })()`);
        if (!ok) { await c.realClick(lx, ly); await sleep(500); }
        const count = await c.evalJS(`(() => { const d = ${D}; if (!d) return 'closed'; return (d.innerText.match(/已选\\(\\s*(\\d+)\\s*\\/\\s*(\\d+)/) || [])[0] || 'count?'; })()`);
        results.push(`${prov}: ${ok ? 'selected' : 'retry-clicked'}, ${count}`);
      }
      console.log(results.join("\n"));
      break;
    }
    case "hi": {
      // args: hi <cardIndex> [--budget N]
      const idx = args[0] ? parseInt(args[0]) : 0;
      let budget = null;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--budget' && i + 1 < args.length) { budget = parseInt(args[i + 1]); break; }
      }
      // 0. 预算闸门：预算 ≤ 0 直接拒发
      if (budget !== null && budget <= 0) {
        console.log(JSON.stringify({ skipped: 'budget_exceeded', cardIndex: idx, budgetRemaining: budget, verdict: '拒发：本次剩余邀约预算 ≤ 0' }));
        break;
      }
      const pointsBefore = await c.evalJS(`(() => { const box = [...document.querySelectorAll('*')].find(e => /Hi聊点数/.test((e.innerText||'')) && e.children.length <= 3); return box ? (box.innerText.match(/Hi聊点数\\D*(\\d+)/) || [])[1] : null; })()`);
      // 1. 定位卡片与按钮，读点前身份（含精选标记）
      const before = JSON.parse(await c.evalJS(`(() => { const card = document.querySelectorAll('.item.resume-card')[${idx}]; if (!card) return JSON.stringify({err:'NO_CARD'}); const name = (card.innerText.match(/([\\u4e00-\\u9fa5]{1,2}(先生|女士))/) || [])[1]; const btn = [...card.querySelectorAll('button')].find(b => /立即Hi聊|继续聊/.test(b.innerText.trim())); const featured = /精选/.test(card.innerText); return JSON.stringify({ name, btnText: btn ? btn.innerText.trim() : null, featured }); })()`));
      if (before.err || !before.btnText) { console.log(JSON.stringify(before)); break; }
      if (before.btnText !== "立即Hi聊") { console.log(JSON.stringify({ skip: true, reason: `按钮已是「${before.btnText}」，可能已沟通过，不重复点击`, name: before.name, featured: before.featured })); break; }
      // 1.5 精选预算预判：当前 budget 若 < 精选项最低扣点(2) 直接拒发
      if (before.featured && budget !== null && budget < 2) {
        console.log(JSON.stringify({ skipped: 'budget_insufficient_for_featured', cardIndex: idx, name: before.name, featured: true, budgetRemaining: budget, verdict: '拒发：本卡带「精选」标记，预算 < 2 点，先跳过看下一张' }));
        break;
      }
      // 2. 滚动卡片到可见
      await c.evalJS(`document.querySelectorAll('.item.resume-card')[${idx}].scrollIntoView({block:'center'})`);
      await sleep(500);
      // 3. 强制显示按钮并取坐标
      const pos = JSON.parse(await c.evalJS(`(() => { const card = document.querySelectorAll('.item.resume-card')[${idx}]; const btn = [...card.querySelectorAll('button')].find(b => /立即Hi聊/.test(b.innerText.trim())); if (!btn) return JSON.stringify({err:'NO_BTN'}); btn.style.display='inline-flex'; btn.style.visibility='visible'; btn.style.opacity='1'; const r = btn.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), visible: r.width > 0 }); })()`));
      if (pos.err || !pos.visible) { console.log(JSON.stringify(pos)); break; }
      // 4. 真实点击（只点一次，绝不重试）
      await c.realClick(pos.x, pos.y);
      await sleep(2500);
      // 5. 验证：按钮变化 + toast + 点数
      const after = JSON.parse(await c.evalJS(`(() => { const card = document.querySelectorAll('.item.resume-card')[${idx}]; const name = (card.innerText.match(/([\\u4e00-\\u9fa5]{1,2}(先生|女士))/) || [])[1]; const btn = [...card.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean); const toasts = [...document.querySelectorAll('.el-message, [class*=message]')].map(t => (t.innerText||'').trim()).filter(t => /发送成功|成功/.test(t)); const box = [...document.querySelectorAll('*')].find(e => /Hi聊点数/.test((e.innerText||'')) && e.children.length <= 3); const pts = box ? (box.innerText.match(/Hi聊点数\\D*(\\d+)/) || [])[1] : null; return JSON.stringify({ name, btns: btn, toasts: toasts.slice(0,2), points: pts }); })()`));
      const evidence = [];
      if (after.btns && after.btns.some(t => /继续聊/.test(t))) evidence.push("按钮变「继续聊」");
      if (after.toasts && after.toasts.length) evidence.push("toast: " + after.toasts[0]);
      if (after.points && pointsBefore && +after.points < +pointsBefore) evidence.push(`点数 ${pointsBefore}→${after.points}`);
      // 6. 计算本次扣点与剩余预算
      let consumed = 1;
      if (pointsBefore && after.points) {
        const diff = +pointsBefore - +after.points;
        if (diff >= 1 && diff <= 3) consumed = diff;
      }
      const remaining = budget !== null ? budget - consumed : null;
      console.log(JSON.stringify({
        cardIndex: idx,
        candidate: before.name,
        featured: before.featured,
        clicked: true,
        evidence,
        evidenceCount: evidence.length,
        pointsBefore: pointsBefore ? +pointsBefore : null,
        pointsAfter: after.points ? +after.points : null,
        pointsConsumed: consumed,
        budgetRemaining: remaining,
        budgetExhausted: remaining !== null && remaining <= 0,
        verdict: evidence.length >= 2 ? "已发起Hi" : evidence.length === 1 ? "结果待确认（证据不足，不得补点）" : "结果待确认（无证据，不得补点）",
        detail: after
      }, null, 1));
      break;
    }
    default:
      console.error("unknown command:", cmd);
      console.error("commands: eval | eval-file | click | shot | esc | point | cards | points | provinces | hi");
      process.exit(1);
  }
} catch (e) {
  console.error("ERROR:", e.message);
  process.exit(1);
}
c.ws.close();
process.exit(0);
