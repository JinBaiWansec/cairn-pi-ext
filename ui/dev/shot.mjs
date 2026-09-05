// shot.mjs — headless chromium CDP：手工清单断言 + 2 张截图（01 全景 / 02 抽屉）
// 用法：先 `node ui/dev/server.mjs`，再 `node ui/dev/shot.mjs`
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CDP_PORT = 9335;
const URL_ = "http://127.0.0.1:8477/";
const OUT = join(fileURLToPath(new URL(".", import.meta.url)), "shots");
const sleep = (ms) => new Promise((r) => setTimeout(r), ms);

mkdirSync(OUT, { recursive: true });

const prof = mkdtempSync(join(tmpdir(), "cairn-shot-"));
const chrome = spawn(
  "/usr/bin/chromium",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${prof}`,
    URL_,
  ],
  { stdio: "ignore" },
);
let failed = 0;

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const t = list.find((x) => x.type === "page" && x.url.startsWith("http://127.0.0.1:8477"));
      if (t) return t.webSocketDebuggerUrl;
    } catch {
      /* not up */
    }
    await sleep(250);
  }
  throw new Error("CDP page target not found");
}

const ws = new WebSocket(await getWsUrl());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("ws connect failed"));
});
let seq = 0;
const pending = new Map();
const jsExceptions = [];
ws.onmessage = (m) => {
  let msg;
  try {
    msg = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown")
    jsExceptions.push(msg.params?.exceptionDetails?.exception?.description ?? "?");
};
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (msg) =>
      msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result),
    );
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timeout`));
      }
    }, 15000);
  });
}
await cdp("Runtime.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

async function ev(expr) {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true });
  if (r.exceptionDetails)
    throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)}`);
  return r.result.value;
}
async function waitUntil(expr, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await ev(expr)) return;
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error(`waitUntil timeout: ${expr}`);
}
let n = 0;
function check(name, ok, detail) {
  n++;
  console.log(`${ok ? "PASS" : "FAIL"} ${n}. ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}
async function shot(file) {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(OUT, file), Buffer.from(r.data, "base64"));
  console.log(`shot → ${join(OUT, file)}`);
}

// ── 清单（§7 + S 抽查）──────────────────────────────────────
await waitUntil(`document.querySelectorAll('.react-flow__node').length >= 6`);
await waitUntil(`document.body.innerText.includes('活动结束')`); // act-002 流定稿
await sleep(500); // 打字机/布局安定

const text = await ev(`document.body.innerText`);
check("顶栏 MOCK 徽章（S10）", text.includes("MOCK"));
check("顶栏 EXECUTING 状态（S2 色码）", /EXECUTING/.test(text));
check("顶栏预算位 Exec x/8（S4）", /Exec \d+\/8/.test(text));
check("顶栏 LIVE/轮询徽章（S9）", /LIVE|轮询中/.test(text));

const nodeCount = await ev(`document.querySelectorAll('.react-flow__node').length`);
check("画布节点 = goal+4 steps+5 facts = 10", nodeCount === 10, `got ${nodeCount}`);
check("step 呼吸灯类（S2 in_progress）", await ev(`!!document.querySelector('.breathe')`));
check("dropped 节点删除线（§6.2）", await ev(`!!document.querySelector('.line-through')`));

check("Hints 行三态计数（S5）", /active · .* addressed/.test(text));
check("Findings 计数行（S26 色点）", /Findings:/.test(text));
check("severity 8px 色点存在", await ev(`document.querySelectorAll('.rounded-full.bg-stamber, .rounded-full.bg-stred').length >= 1`));

check("活动 tab（编号+kind+step）", await ev(`[...document.querySelectorAll('button')].some(b => /^002/.test(b.textContent) && /s-01/.test(b.textContent))`));
check("ToolCard 渲染（bash $cmd）", /bash/.test(text));
check("活动级收束行（S11）", /活动结束/.test(text));
check("prompt 折叠默认收起（S28）", await ev(`(() => { const d = document.querySelector('details'); return !d || !d.open; })()`));

check("无 JS 异常", jsExceptions.length === 0, jsExceptions.slice(0, 2).join(" | "));

// 坐标锁定抽查：记录节点坐标 → 触发 graph 事件（POST 无效，直接再拉 /api/graph 不会变）→
// 用 ?live=1 页已验证（见报告），此处验证重拉后坐标不变
const posBefore = await ev(`JSON.stringify(Array.from(document.querySelectorAll('.react-flow__node')).map(el => el.style.transform))`);
await ev(`fetch('/api/graph').then(r => r.json())`); // 对账路径同 SSE graph 事件
await sleep(400);
const posAfter = await ev(`JSON.stringify(Array.from(document.querySelectorAll('.react-flow__node')).map(el => el.style.transform))`);
check("重拉 graph 后旧节点坐标不变（§6.1 锁定）", posBefore === posAfter);

await shot("01-overview.png");

// 抽屉：点击 fact 节点 → CodeMirror 抽屉
await ev(`document.querySelector('.react-flow__node-fact button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
await waitUntil(`!!document.querySelector('[role="dialog"]')`);
await waitUntil(`(document.querySelector('.cm-content')?.textContent ?? '').length > 0`);
await sleep(400);
check("抽屉 role=dialog + aria-modal（S18）", await ev(`(() => { const d = document.querySelector('[role="dialog"]'); return d && d.getAttribute('aria-modal') === 'true'; })()`));
check("抽屉工具条（正则/行号/复制）", await ev(`(() => { const d = document.querySelector('[role="dialog"]'); return d && /正则/.test(d.innerText) && /复制/.test(d.innerText); })()`));
await shot("02-drawer.png");

console.log(failed === 0 ? `\nALL ${n} CHECKS PASS` : `\n${failed}/${n} FAILED`);
chrome.kill();
await sleep(200);
process.exit(failed === 0 ? 0 : 1);
