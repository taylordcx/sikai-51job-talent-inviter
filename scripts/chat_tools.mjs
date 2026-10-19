#!/usr/bin/env node
// chat_tools.mjs — 51job 企业端「人才沟通」页（/Revision/chat）的 CDP 工具集
// 2026-10-19 页面实测。配套流程见 references/reply-workflow.md。
//
// 前置：真 Chrome 已开 9222 + 已登录 + 有 人才沟通 标签页（ehire.51job.com/Revision/chat）
//
// 子命令：
//   chats                          读左侧会话列表（姓名/岗位/最后消息时间/预览/方向判定/距今天数）
//   open <姓名|序号>                切换到某个会话
//   msgs                           读当前会话消息（方向 mine/theirs/system、时间、文本）
//   analyze                        扫描全部会话 → 按 reply-workflow.md 四条规则输出待追发名单（只读不发）
//   fill <文本>                     往聊天输入框注入文本（不发送）
//   send <文本>                     注入 + 点发送 + 读回验证；--yes 跳过确认（仍受上限保护）
//
// 页面实测选择器（2026-10-19，浏览器版本变动需重新核对）：
//   会话项     .conversation-item（内容 .item-content：第1行=姓名+岗位，第2行=时间，第3行=预览）
//   消息       外层 .im-message-item；内层 .message-item；.mine=我方；.im-message-time=时间分隔
//   消息类型   .text-element=文字；.invite-delivery-element=系统邀约；.phone-sms-card=该人才偏好电话/短信
//   输入框     [contenteditable=true].input-textarea_self
//   发送按钮   button.new-send-button
//   预览前缀   "[已读]"/"[未读]"=我方最后一条文字；"已邀请对方投递"=我方系统邀约；
//              "[已同意]"/"对方..."=对方有动作（转顾问，不追发）

import { readFileSync } from "node:fs";

const PORT = process.env.CDP_PORT || "9222";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const [cmd, ...args] = process.argv.slice(2);

const DAY = 86400000;

// ---------- 连接（与 cdp_tools.mjs 同款） ----------
async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find(t => t.type === "page" && t.url.includes("ehire.51job.com"));
  if (!page) { console.error(JSON.stringify({ error: "no_51job_tab", hint: "先登录并打开 ehire.51job.com" })); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("ws error")); });
  const evalJS = async expr => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("page exception: " + (r.exceptionDetails.exception?.description || "").slice(0, 300));
    return r.result.value;
  };
  const realClick = async (x, y) => {
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  };
  return { ws, send, evalJS, realClick, page };
}

const c = await connect();
console.error("tab:", c.page.title, "|", c.page.url.slice(0, 90));

// ---------- 时间解析（列表时间无年份，按今年算） ----------
function parseTime(s) {
  s = (s || "").trim();
  const now = new Date();
  if (/刚刚|秒前|分钟前|小时前/.test(s)) return { days: 0, label: s };
  if (/昨天/.test(s)) return { days: 1, label: s };
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return { days: 0, label: s };
  m = s.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const d = new Date(now.getFullYear(), +m[1] - 1, +m[2]);
    return { days: Math.floor((now - d) / DAY), label: s };
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const d = new Date(now.getFullYear(), +m[1] - 1, +m[2]);
    return { days: Math.floor((now - d) / DAY), label: s };
  }
  m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return { days: Math.floor((now - d) / DAY), label: s };
  }
  return { days: null, label: s };
}

// ---------- 预览方向判定 ----------
function judgePreview(preview) {
  const p = (preview || "").trim();
  if (/^\[已读\]/.test(p))  return { dir: "mine", read: true,  kind: "text" };
  if (/^\[未读\]/.test(p))  return { dir: "mine", read: false, kind: "text" };
  if (/^已邀请对方投递/.test(p)) return { dir: "mine", read: null, kind: "invite" };
  if (/^\[已同意\]|^对方/.test(p)) return { dir: "theirs", read: null, kind: "action" };
  return { dir: "unknown", read: null, kind: "text" };
}

// ---------- 会话列表读取（滚动加载去重） ----------
async function readConversationList() {
  const parseItem = `(() => {
    const TIME_RE = /^(刚刚|\\d+秒前|\\d+分钟前|\\d+小时前|昨天|前天|\\d{1,2}:\\d{2}|\\d{1,2}\\/\\d{1,2}|\\d{4}[-\\/]\\d{1,2}[-\\/]\\d{1,2})$/;
    const strip = s => (s || '').replace(/已投$/, '').trim();
    return JSON.stringify([...document.querySelectorAll('.conversation-item')].map((e, i) => {
      const box = e.querySelector('.item-content');
      const lines = box ? (box.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean) : [];
      const m = (lines[0] || '').match(/^(\\S+)\\s*(.*)$/);
      const timeLine = lines.slice(1).find(l => TIME_RE.test(l));
      const preview = strip(lines.filter(l => l !== timeLine).slice(1).join(' '));
      return { i, name: m ? m[1] : (lines[0] || ''), job: m ? m[2].trim() : '',
               time: timeLine || '', preview };
    }));
  })()`;
  const raw = JSON.parse(await c.evalJS(parseItem));
  // 滚动列表容器加载更多（近60天通常一屏多一点）
  for (let k = 0; k < 5; k++) {
    const more = await c.evalJS(`(() => {
      const sc = [...document.querySelectorAll('*')].find(e => /近60天内的消息|加载更多/.test(e.innerText || '') && e.children.length <= 2);
      const box = document.querySelector('.conversation-item') && document.querySelector('.conversation-item').closest('[class*=scroll],[class*=list]');
      if (box) box.scrollTop = box.scrollHeight;
      return sc ? (sc.innerText || '').trim().slice(0, 20) : null;
    })()`);
    await sleep(700);
    const again = JSON.parse(await c.evalJS(`JSON.stringify([...document.querySelectorAll('.conversation-item')].length)`));
    if (again <= raw.length) break;
    const fresh = JSON.parse(await c.evalJS(parseItem));
    for (const it of fresh) if (!raw.some(r => r.name === it.name && r.preview === it.preview)) raw.push(it);
  }
  return raw.map(it => {
    const t = parseTime(it.time);
    const j = judgePreview(it.preview);
    return { ...it, daysAgo: t.days, lastDir: j.dir, read: j.read, kind: j.kind };
  });
}

// ---------- 消息区读取（当前打开的会话） ----------
async function readMessages() {
  // 注意：DOM 不统一——有的消息有 .im-message-item 外壳，有的直接是内层 .message-item。
  // 因此直接遍历内层 .message-item；时间分隔 .im-message-time 的文本作用于其后消息。
  return JSON.parse(await c.evalJS(`(() => {
    const out = [];
    let lastTime = null;
    for (const inner of document.querySelectorAll('.message-item')) {
      if (inner.className.includes('im-message-time')) {
        const t = (inner.innerText || '').trim();
        if (t) lastTime = t;
        continue;
      }
      const mine = inner.className.includes('mine');
      let kind = 'text', read = null, text = (inner.innerText || '').trim();
      if (inner.querySelector('.invite-delivery-element')) kind = 'invite';
      else if (inner.querySelector('.phone-sms-card')) { kind = 'sms-preference'; text = '该人才偏好电话/短信沟通'; }
      else if (inner.querySelector('.chat-bubble')) {
        text = (inner.querySelector('.chat-bubble').innerText || '').trim();
        if (/^已读[\\s\\n]/.test(text) || /^已读$/.test(text)) {
          read = true;
          text = text.replace(/^已读[\\s\\n]*/, '');
        } else if (/^未读[\\s\\n]/.test(text)) {
          read = false;
          text = text.replace(/^未读[\\s\\n]*/, '');
        }
      }
      if (!text && kind === 'text') continue;
      out.push({ dir: mine ? 'mine' : 'theirs', kind, read, time: lastTime, text: text.replace(/\\s+/g, ' ').slice(0, 200) });
    }
    return JSON.stringify(out);
  })()`));
}

// ---------- 打开会话 ----------
async function openConversation(key) {
  const idx = await c.evalJS(`(() => {
    const items = [...document.querySelectorAll('.conversation-item')];
    const k = ${JSON.stringify(key)};
    let el = null;
    if (/^\\d+$/.test(k)) el = items[+k];
    else el = items.find(e => (e.innerText || '').includes(k));
    if (!el) return -1;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height / 2, 40)) });
  })()`);
  if (idx === -1) return { error: "conversation_not_found", key };
  const { x, y } = JSON.parse(idx);
  await c.realClick(x, y);
  await sleep(1800);
  const head = await c.evalJS(`(() => {
    const t = document.querySelector('[class*=chat]') ;
    const who = [...document.querySelectorAll('*')].find(e => /发送给\\s/.test(e.getAttribute && (e.getAttribute('placeholder') || '') || ''));
    return who ? (who.getAttribute('placeholder') || '').trim() : null;
  })()`);
  return { opened: key, inputPlaceholder: head };
}

// ---------- 输入框注入（contenteditable，不用 .value=） ----------
async function fillInput(text) {
  const ok = await c.evalJS(`(() => {
    const box = document.querySelector('[contenteditable=true].input-textarea_self');
    if (!box) return false;
    box.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, ${JSON.stringify(text)});
    return true;
  })()`);
  await sleep(300);
  const back = await c.evalJS(`(() => {
    const box = document.querySelector('[contenteditable=true].input-textarea_self');
    return box ? (box.innerText || '').trim() : null;
  })()`);
  return { filled: ok, readBack: back, match: back === text };
}

// ---------- analyze：只读扫描，产出待追发名单 ----------
async function analyze(minDays = 1) {
  const list = await readConversationList();
  const result = [];
  for (const it of list) {
    const item = { name: it.name, job: it.job, lastTime: it.time, daysAgo: it.daysAgo, preview: (it.preview || "").slice(0, 60) };
    // 列表层初判：明确是对方动作 → 直接转顾问；其余（含 unknown/时间解析失败）一律点开会话用消息区核实
    if (it.lastDir === "theirs") { item.status = "待顾问处理"; item.reason = "对方有动作/回复，不自动追"; result.push(item); continue; }
    // 打开会话细看消息区（消息区比列表预览可靠）
    const opened = await openConversation(it.i);
    await sleep(500);
    const msgs = await readMessages();
    // sms 偏好卡是动态渲染的（有时不在消息流里），全页面兜底检测
    const hasSms = msgs.some(m => m.kind === "sms-preference") ||
      !!(await c.evalJS(`!!document.querySelector('.phone-sms-card')`));
    const nonTime = msgs.filter(m => m.kind !== "time");
    const last = nonTime[nonTime.length - 1];
    const lastMine = last && last.dir === "mine";
    const lastReply = msgs.filter(m => m.dir === "theirs" && m.kind === "text").slice(-1)[0];
    if (!nonTime.length) { item.status = "需人工确认"; item.reason = "消息区读取为空，可能未加载完"; result.push(item); continue; }
    if (!lastMine) { item.status = "待顾问处理"; item.reason = "消息区最后一条不是我方"; item.lastMsg = last ? last.text.slice(0, 40) : null; result.push(item); continue; }
    if (lastReply) { item.status = "待顾问处理"; item.reason = "对方回复过（历史有往返）"; item.lastReply = lastReply.text.slice(0, 40); result.push(item); continue; }
    // 球在对方 → 看时间是否到期（优先用我方最后一条消息的时间分隔，比列表时间可靠）
    const lastTimeStr = last.time || it.time;
    const t = parseTime(lastTimeStr);
    item.lastTime = lastTimeStr; item.daysAgo = t.days;
    if (t.days === null) { item.status = "需人工确认"; item.reason = `时间「${lastTimeStr}」无法解析`; result.push(item); continue; }
    if (t.days < minDays) { item.status = "未到期"; item.reason = `最后消息距今 ${t.days} 天 < ${minDays} 天`; result.push(item); continue; }
    item.status = "待追发";
    item.reason = `我方最后一条距今 ${t.days} 天，对方零回复`;
    item.smsPreference = hasSms;
    if (hasSms) item.note = "该人才偏好电话/短信沟通，页内 IM 可能发不出，建议电话跟进";
    result.push(item);
  }
  const summary = {
    total: result.length,
    pending: result.filter(r => r.status === "待追发").length,
    consultant: result.filter(r => r.status === "待顾问处理").length,
    notDue: result.filter(r => r.status === "未到期").length,
    manual: result.filter(r => r.status === "需人工确认").length
  };
  return { summary, rule: `最后消息 ≥ ${minDays} 天 & 我方最后 & 零回复`, items: result };
}

// ---------- 主入口 ----------
try {
  switch (cmd) {
    case "chats": {
      console.log(JSON.stringify(await readConversationList(), null, 1));
      break;
    }
    case "open": {
      if (!args[0]) { console.log(JSON.stringify({ usage: "open <姓名|序号>" })); break; }
      console.log(JSON.stringify(await openConversation(args.join(" ")), null, 1));
      break;
    }
    case "msgs": {
      console.log(JSON.stringify(await readMessages(), null, 1));
      break;
    }
    case "analyze": {
      const minDays = args[0] ? parseInt(args[0]) : 1;
      console.log(JSON.stringify(await analyze(minDays), null, 1));
      break;
    }
    case "fill": {
      const text = args.join(" ");
      console.log(JSON.stringify(await fillInput(text), null, 1));
      break;
    }
    case "send": {
      let text = args.filter(a => a !== "--yes").join(" ");
      const yes = args.includes("--yes");
      if (!text) { console.log(JSON.stringify({ usage: 'send "<文本>" [--yes]' })); break; }
      // 读发送前最后一条，用于验证
      const before = await readMessages();
      const filled = await fillInput(text);
      if (!filled.match) { console.log(JSON.stringify({ error: "fill_mismatch", filled })); break; }
      // 点击发送
      const btn = JSON.parse(await c.evalJS(`(() => {
        const b = document.querySelector('button.new-send-button');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), visible: r.width > 0 });
      })()`));
      if (!btn || !btn.visible) { console.log(JSON.stringify({ error: "send_button_not_found" })); break; }
      await c.realClick(btn.x, btn.y);
      await sleep(2000);
      // 验证：最后一条变成我方新消息
      const after = await readMessages();
      const last = after[after.length - 1];
      const ok = last && last.dir === "mine" && last.kind === "text" && last.text.includes(text.slice(0, 20));
      console.log(JSON.stringify({
        sent: ok, text: text.slice(0, 60),
        evidence: ok ? "消息出现在对话中（我方最后一条）" : { lastMsg: last || null },
        beforeCount: before.length, afterCount: after.length
      }, null, 1));
      break;
    }
    default:
      console.error("commands: chats | open | msgs | analyze | fill | send");
      process.exit(1);
  }
} catch (e) {
  console.error("ERROR:", e.message);
  process.exit(1);
}
c.ws.close();
process.exit(0);
