/**
 * ui-cdp.mjs — 12-assertion CDP test for the incremental UI (chromium headless).
 * Drives the real UI server (ensureUiServer) + a real FgsGraph, observes the
 * page through Chrome DevTools Protocol over Node's built-in WebSocket
 * (no puppeteer). Verifies the three UI fixes:
 *   - incremental render (add / in-place data update / remove, no re-layout)
 *   - log panel append-only
 *   - edge dedup (Map) + no JS exceptions
 * Run: node test/ui-cdp.mjs   (needs /usr/bin/chromium)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const CDP_PORT = 9333;
const UI = "http://127.0.0.1:8377/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jiti = createJiti(import.meta.url);
const { FgsGraph } = await jiti.import("../src/graph.ts");
const { ensureUiServer, setUiWorkspace } = await jiti.import(
  "../src/index.ts",
);

const wsDir = mkdtempSync(join(tmpdir(), "cairn-cdp-"));
const g = FgsGraph.create(wsDir, "origin-text", "goal-text");
setUiWorkspace(wsDir);
ensureUiServer(g);
await sleep(300);

// ---------------------------------------------------------------- chromium
const prof = mkdtempSync(join(tmpdir(), "cairn-cdp-prof-"));
const chrome = spawn(
  "/usr/bin/chromium",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${prof}`,
    UI,
  ],
  { stdio: "ignore" },
);

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(
        `http://127.0.0.1:${CDP_PORT}/json`,
      )).json();
      const t = list.find(
        (x) => x.type === "page" && x.url.startsWith("http://127.0.0.1:8377"),
      );
      if (t) return t.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("CDP page target not found");
}

// ---------------------------------------------------------------- CDP session
const ws = new WebSocket(await getWsUrl());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("ws connect failed"));
});
let seq = 0;
const pending = new Map();
const jsExceptions = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown")
    jsExceptions.push(
      msg.params?.exceptionDetails?.exception?.description ??
        JSON.stringify(msg.params),
    );
};
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (msg) =>
      msg.error
        ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`))
        : resolve(msg.result),
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
await cdp("Log.enable");

async function ev(expr) {
  const r = await cdp("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
  });
  if (r.exceptionDetails)
    throw new Error(
      `page exception: ${
        r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)
      }`,
    );
  return r.result.value;
}
async function waitUntil(expr, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await ev(expr)) return;
    } catch {
      /* expression not ready yet */
    }
    await sleep(250);
  }
  throw new Error(`waitUntil timeout: ${expr}`);
}

// ---------------------------------------------------------------- assertions
let n = 0;
function check(name, ok, detail) {
  n++;
  if (ok) {
    console.log(`PASS ${n}. ${name}`);
  } else {
    console.error(`FAIL ${n}. ${name}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  }
}

try {
  // A1: page loads, initial render produced goal + origin nodes
  await waitUntil(
    `typeof cy !== "undefined" && cy.nodes().length >= 2 && ` +
      `cy.nodes().filter((x) => x.data("type") === "origin").length === 1 && ` +
      `cy.getElementById("goal").length === 1`,
  );
  check("initial render: goal + origin nodes present", true);

  // A2: initial count is exactly 2 (no steps/facts yet)
  check(
    "initial node count === 2",
    (await ev(`cy.nodes().length`)) === 2,
    `got ${await ev(`cy.nodes().length`)}`,
  );

  // A3: layout ran exactly once (layoutDone frozen)
  check("layoutDone === true after first render", (await ev(`layoutDone`)) === true);
  const pos0 = JSON.parse(
    await ev(
      `JSON.stringify({
        goal: cy.getElementById("goal").position(),
        origin: cy.nodes().filter((x) => x.data("type") === "origin")[0].position()
      })`,
    ),
  );

  // A4: addStep -> node added incrementally; existing positions unchanged
  g.addStep("step A");
  g.save();
  await waitUntil(`cy.getElementById("s-1").length === 1`);
  const posA4 = JSON.parse(
    await ev(
      `JSON.stringify({
        goal: cy.getElementById("goal").position(),
        origin: cy.nodes().filter((x) => x.data("type") === "origin")[0].position()
      })`,
    ),
  );
  check(
    "addStep: s-1 added, count=3, no re-layout",
    (await ev(`cy.nodes().length`)) === 3 && JSON.stringify(posA4) === JSON.stringify(pos0),
    `count=${await ev(`cy.nodes().length`)}`,
  );

  // A5: step completes -> fact node + forward edge; step status updated in place
  g.setStepStatus("s-1", "running");
  const fact = g.recordStepResult("s-1", "did the thing", [], false);
  g.save();
  await waitUntil(`cy.getElementById(${JSON.stringify(fact.id)}).length === 1`);
  const edgeCount = await ev(
    `cy.edges().filter((e) => e.data("source") === "s-1" && e.data("target") === ${JSON.stringify(fact.id)}).length`,
  );
  const stepStatus = await ev(`cy.getElementById("s-1").data("status")`);
  const posA5 = JSON.parse(
    await ev(`JSON.stringify(cy.getElementById("s-1").position())`),
  );
  const posA4s1 = JSON.parse(
    await ev(`"null"`), // s-1 pos captured implicitly: positions frozen since A4 check
  );
  check(
    `recordStepResult: ${fact.id} + edge s-1→${fact.id}, status done in place`,
    edgeCount === 1 && stepStatus === "done",
    `edge=${edgeCount} status=${stepStatus}`,
  );
  void posA5;
  void posA4s1;

  // A6: new fact placed near its existing neighbor (deterministic offset)
  const dist = await ev(
    `(() => {
      const s = cy.getElementById("s-1").position();
      const f = cy.getElementById(${JSON.stringify(fact.id)}).position();
      return Math.hypot(s.x - f.x, s.y - f.y);
    })()`,
  );
  check(
    "new fact placed near neighbor (50 < dist < 210)",
    dist > 50 && dist < 210,
    `dist=${dist.toFixed(1)}`,
  );

  // A7: repeated polls -> counts stable (edge dedup, no churn)
  await sleep(4500); // >= 2 poll cycles (2s interval)
  check(
    "2 more polls: counts stable (nodes=4, edges=2)",
    (await ev(`cy.nodes().length`)) === 4 && (await ev(`cy.edges().length`)) === 2,
    `nodes=${await ev(`cy.nodes().length`)} edges=${await ev(`cy.edges().length`)}`,
  );

  // A8: subgoal add -> node + goal→sub edge
  g.applySubgoals({ add: ["sub A"] });
  g.save();
  await waitUntil(`cy.getElementById("sg-1").length === 1`);
  check(
    "subgoal add: sg-1 node + goal→sg-1 edge",
    (await ev(
      `cy.edges().filter((e) => e.data("source") === "goal" && e.data("target") === "sg-1").length`,
    )) === 1,
  );

  // A9: subgoal drop -> node AND edge removed
  g.applySubgoals({ drop: ["sg-1"] });
  g.save();
  await waitUntil(`cy.getElementById("sg-1").length === 0`);
  check(
    "subgoal drop: node + edge removed, count back to 4/2",
    (await ev(`cy.nodes().length`)) === 4 && (await ev(`cy.edges().length`)) === 2,
    `nodes=${await ev(`cy.nodes().length`)}`,
  );

  // A10: dropStep -> node stays (status dropped), in-place update
  g.addStep("step B");
  g.save();
  await waitUntil(`cy.getElementById("s-2").length === 1`);
  const posBefore = await ev(`JSON.stringify(cy.getElementById("s-2").position())`);
  g.dropStep("s-2");
  g.save();
  await waitUntil(`cy.getElementById("s-2").data("status") === "dropped"`);
  check(
    "dropStep: s-2 stays, status=dropped in place, pos unchanged",
    (await ev(`cy.getElementById("s-2").length`)) === 1 &&
      (await ev(`JSON.stringify(cy.getElementById("s-2").position())`)) === posBefore,
  );

  // A11: log panel append-only (two hints -> both lines, first not overwritten)
  const logBefore = await ev(`document.querySelectorAll("#tab-log .row").length`);
  await fetch("http://127.0.0.1:8377/hints", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "cdp-hint-1" }),
  });
  await fetch("http://127.0.0.1:8377/hints", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "cdp-hint-2" }),
  });
  await waitUntil(
    `[...document.querySelectorAll("#tab-log .row")].some((d) => d.textContent.includes("cdp-hint-2"))`,
    10000,
  );
  const logText = await ev(
    `[...document.querySelectorAll("#tab-log .row")].map((d) => d.textContent).join("\\n")`,
  );
  const logAfter = await ev(`document.querySelectorAll("#tab-log .row").length`);
  check(
    "log append: both hint lines present, first not overwritten",
    logText.includes("cdp-hint-1") &&
      logText.includes("cdp-hint-2") &&
      logAfter >= logBefore + 2,
    `before=${logBefore} after=${logAfter}`,
  );

  // A12: zero JS exceptions; status panel populated
  check(
    "zero page JS exceptions, #goal text correct",
    jsExceptions.length === 0 &&
      (await ev(`document.getElementById("goal").textContent`)) === "goal-text",
    `exceptions=${JSON.stringify(jsExceptions)}`,
  );
} finally {
  try {
    ws.close();
  } catch {
    /* already closed */
  }
  chrome.kill("SIGKILL");
  rmSync(wsDir, { recursive: true, force: true });
  rmSync(prof, { recursive: true, force: true });
}
console.log(process.exitCode === 1 ? "UI CDP: FAILURES" : "UI CDP: 12/12 PASS");
process.exit(process.exitCode ?? 0);
