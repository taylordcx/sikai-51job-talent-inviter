#!/usr/bin/env node
// nav_log.mjs — 记录顾问在 51job 企业端手动操作的页面路径
//
// 用法：node nav_log.mjs [输出文件]
// 前置：真 Chrome 已开 9222 调试端口，且有一个 51job 标签页
//
// 原理：轮询 location.href（能捕获 Vue SPA 的路由跳转，Page.frameNavigated 抓不到 hash 路由），
// URL 变化即追加一行 TSV：时间戳 \t 标题 \t URL。

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const PORT = process.env.CDP_PORT || "9222";
const OUT = process.argv[2] || "/tmp/51job-nav.tsv";
const INTERVAL = 1500;

if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });

async function pickTab() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const tabs = list.filter(t => t.type === "page" && /51job\.com/.test(t.url || ""));
  // 优先 ehire 企业端
  return tabs.find(t => t.url.includes("ehire.51job.com")) || tabs[0] || null;
}

const tab = await pickTab();
if (!tab) {
  console.error(JSON.stringify({ error: "no_51job_tab", hint: "先打开 https://ehire.51job.com/" }));
  process.exit(1);
}

const ws = new WebSocket(tab.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
};

await new Promise((r, j) => { ws.onopen = r; ws.onerror = e => j(new Error("ws error")); });

if (!existsSync(OUT)) writeFileSync(OUT, "时间\t页面标题\tURL\n");

let last = "";
let count = 0;

async function poll() {
  try {
    const res = await send("Runtime.evaluate", {
      expression: "JSON.stringify({u: location.href, t: document.title})",
      returnByValue: true
    });
    const { u, t } = JSON.parse(res.result.value || "{}");
    if (u && u !== last) {
      last = u;
      appendFileSync(OUT, `${new Date().toISOString()}\t${t || ""}\t${u}\n`);
      count++;
      console.log(`[${count}] ${t || "(无标题)"} | ${u}`);
    }
  } catch (e) {
    // 页面跳转中偶发 evaluate 失败，忽略
  }
}

await poll();
setInterval(poll, INTERVAL);
console.log(`recording -> ${OUT}`);
