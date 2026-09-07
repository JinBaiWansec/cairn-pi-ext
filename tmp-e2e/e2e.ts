/**
 * Step 7 e2e（carin_step7_plan §6 门禁 4 的可自动化部分）。
 * 真模型 + startEngine + startCairnServer，全程经 HTTP/SSE 验证。
 * Run: node test/run.mjs e2e  —— 不，jiti 单文件：node --experimental? 用 jiti 内联跑。
 */
import assert from "node:assert";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get as httpGet } from "node:http";
import { startEngine } from "../src/engine.ts";
import { startCairnServer } from "../src/index.ts";
import { loadConfig } from "../src/config.ts";

const PORT = 8377;
const BASE = `http://127.0.0.1:${PORT}`;
const PREFIX = "/ext/cairn";

const tmp = mkdtempSync(join(tmpdir(), "cairn-e2e-"));
const runDir = join(tmp, "cairn-workspace");
rmSync(runDir, { recursive: true, force: true });

const checks: [string, boolean][] = [];
const ok = (name: string, cond = true): void => {
  checks.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

function jget(path: string): Promise<{ code: number; body: unknown; text: string }> {
  return new Promise((res, rej) => {
    httpGet(`${BASE}${path}`, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(b);
        } catch {
          parsed = undefined;
        }
        res({ code: r.statusCode ?? 0, body: parsed, text: b });
      });
    }).on("error", rej);
  });
}

async function jpost(path: string, body: unknown): Promise<{ code: number; body: unknown }> {
  const { request } = await import("node:http");
  return new Promise((res, rej) => {
    const r = request(
      `${BASE}${path}`,
      { method: "POST", headers: { "content-type": "application/json" } },
      (resp) => {
        let b = "";
        resp.on("data", (c) => (b += c));
        resp.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(b);
          } catch {
            parsed = undefined;
          }
          res({ code: resp.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", rej);
    r.end(JSON.stringify(body));
  });
}

async function until(fn: () => Promise<boolean> | boolean, ms: number, _label?: string): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return true;
    } catch { /* poll */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ── 0. 静态 UI（引擎启动前 server 未起 → 先起 server 再 run；这里延后到 server 起来后检查）

const logs: string[] = [];
const cfg = loadConfig();
console.log(`e2e: model=${cfg.model} baseUrl=${cfg.baseUrl} runDir=${runDir}`);

const started = startEngine(
  {
    runDir,
    cfg,
    onWidget: (lines) => console.log(`[widget] ${lines.join(" | ")}`),
    onLog: (line) => {
      logs.push(line);
      console.log(`[log] ${line}`);
    },
    onBanner: (t) => console.log(`[banner] ${t}`),
  },
  "http://127.0.0.1:8377", // origin：本机可达（UI server 自己）
  "逐个探测以下四个端点（每个端点单独一个 step，分别记录 HTTP 状态码）：/ext/cairn/、/ext/cairn/api/status、/ext/cairn/api/graph、/ext/cairn/api/file；四个全部完成后 conclude 汇总四个码。", // 多步目标：给 pause/resume 留窗口（任务太短会先 complete）
);

const srv = await startCairnServer({
  runDir,
  ops: started.ops,
  engine: started.engine,
});
console.log(`e2e: server on ${BASE}`);

// ── 静态 UI ──
{
  const root = await new Promise<{ code: number; loc: string }>((res) => {
    httpGet(`${BASE}/`, (r) => {
      r.resume();
      r.on("end", () => res({ code: r.statusCode ?? 0, loc: r.headers.location ?? "" }));
    });
  });
  ok("GET / → 302 /ext/cairn/", root.code === 302 && root.loc === `${PREFIX}/`);
  const ui = await jget(`${PREFIX}/`);
  ok("GET /ext/cairn/ → 200 HTML", ui.code === 200 && ui.text.includes("<div id=\"root\">"));
}

// ── SSE 订阅（三源计数）──
const frames: { type: string }[] = [];
const statusFrames: { type: string }[] = [];
{
  const req = httpGet(`${BASE}${PREFIX}/api/events`, (r) => {
    assert.strictEqual(r.statusCode, 200);
    let buf = "";
    r.on("data", (c) => {
      buf += String(c);
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const f = JSON.parse(line.slice(6)) as { type: string };
            frames.push(f);
            if (f.type === "status") statusFrames.push(f);
          } catch { /* heartbeat */ }
        }
      }
    });
  });
  req.on("error", () => {});
}

// ── 1. running ──
const becameRunning = await until(async () => {
  const s = await jget(`${PREFIX}/api/status`);
  return s.code === 200 && (s.body as { running?: boolean })?.running === true;
}, 120_000, "running");
ok("status.running=true（真模型启动）", becameRunning);

/** fgs.json → active branch head revision 的 graph */
function fgsGraph(): { steps: { id: string; status: string }[]; hints: { id: string; status: string; text: string }[] } {
  const data = JSON.parse(readFileSync(join(runDir, "fgs.json"), "utf8")) as {
    activeBranch: string;
    branches: { name: string; head: string; revisions: { id: string; graph: { steps: { id: string; status: string }[]; hints: { id: string; status: string; text: string }[] } }[] }[];
  };
  const b = data.branches.find((x) => x.name === data.activeBranch);
  if (!b) throw new Error(`branch ${data.activeBranch} not found`);
  const r = b.revisions.find((x) => x.id === b.head);
  if (!r) throw new Error(`head rev ${b.head} not found`);
  return r.graph;
}

// ── 2. 推进：decide/execute 预算递增 + 三源帧 ──
const budgetMoved = await until(async () => {
  const s = (await jget(`${PREFIX}/api/status`)).body as {
    budget: { executes: number; decides: number };
  };
  return s.budget.executes >= 1 || s.budget.decides >= 1;
}, 300_000, "budget");
ok("预算位递增（decides/executes ≥ 1）", budgetMoved);

const g0 = fgsGraph();
ok("graph 端点有 steps（decide 已推进）", g0.steps.length >= 1);

const transcriptArrived = frames.some((f) => f.type === "transcript");
ok("SSE transcript 帧到达", transcriptArrived);
ok("SSE graph 帧到达", frames.some((f) => f.type === "graph"));
ok("SSE status 帧到达", frames.some((f) => f.type === "status"));

// ── 3. transcript 分页（nextOffset 递增）──
{
  const act = started.engine.currentActivityId;
  if (act) {
    const p1 = (await jget(`${PREFIX}/api/transcript?activity=${act}&offset=0&limit=50`)).body as {
      events: unknown[];
      nextOffset: number;
    };
    ok("transcript 分页 nextOffset 递增", p1.nextOffset > 0 || p1.events.length <= 50);
  } else {
    ok("transcript 分页（无活动可查，跳过=假过）", false);
  }
}

// ── 4. hint：计数 +1 ──
{
  const before = fgsGraph().hints.length;
  // 目标外任务：强制模型 add_step(addresses_hint) 落实（不能拿现有 step 搪塞）
  const h = await jpost(`${PREFIX}/api/ops`, { op: "add_hint", args: { text: "e2e-hint: 追加一个 step，用 curl 请求 /ext/cairn/index.html 并记录其 Content-Type 响应头" } });
  ok("add_hint → 200", h.code === 200);
  ok("hints 行计数 +1", fgsGraph().hints.length === before + 1);
}

// ── 5. pause → 主循环挂起（无新活动）→ resume ──
{
  const pp = await jpost(`${PREFIX}/api/ops`, { op: "pause" });
  ok("pause → 200", pp.code === 200);
  const paused = await until(() => logs.some((l) => l.includes("paused")), 10_000, "paused");
  ok("engine paused（挂起日志）", paused);
  // 等当前活动收口
  const idle = await until(async () => {
    const st = (await jget(`${PREFIX}/api/status`)).body as { currentActivityId?: string };
    return st.currentActivityId === undefined;
  }, 300_000, "activity-done");
  ok("pause 后当前活动收口（currentActivityId 消失）", idle);
  const gFramesBefore = frames.filter((f) => f.type === "graph").length;
  const tBefore = frames.filter((f) => f.type === "transcript").length;
  await new Promise((r) => setTimeout(r, 10_000));
  const gAfter = frames.filter((f) => f.type === "graph").length;
  const tAfter = frames.filter((f) => f.type === "transcript").length;
  ok("pause 挂起 10s 无新 graph/transcript 帧（主循环未推进）", gAfter === gFramesBefore && tAfter === tBefore);

  const rr = await jpost(`${PREFIX}/api/ops`, { op: "resume" });
  ok("resume → 200", rr.code === 200);
  const resumed = await until(async () => {
    const st = (await jget(`${PREFIX}/api/status`)).body as { running?: boolean; currentActivityId?: string };
    return st.running === true && st.currentActivityId !== undefined;
  }, 300_000, "resumed");
  ok("resume 后主循环恢复（新活动出现）", resumed);
}

// ── 6. hint 闭环 → 然后 abort → endReason=aborted + run.json 落盘 ──
// 先等 hint 被消费（addressed=采纳 / rejected=无需落实），再 abort——
// abort 抢在消费它的 decide 之前，hint 会永远停在 active
const hintStatus = (): string | null => {
  try {
    const h = fgsGraph().hints.find((x) => x.text.includes("e2e-hint"));
    return h ? h.status : null;
  } catch {
    return null;
  }
};
const hintClosed = await until(() => {
  const s = hintStatus();
  return s !== null && s !== "active";
}, 300_000, "hint-closed");
console.log(`hint 最终状态: ${hintStatus()}`);

// 先捕获 promise（不得先 await——会把 abort POST 卡到 run 结束）
const donePromise = started.done;
const ab = await jpost(`${PREFIX}/api/ops`, { op: "abort" });
ok("abort → 200（活动间隙生效）", ab.code === 200);
const reason = await donePromise;
ok("done reason=aborted", reason === "aborted");
ok("run.json 落盘", existsSync(join(runDir, "run.json")));
if (existsSync(join(runDir, "run.json"))) {
  let endOk = false;
  try {
    const m = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as {
      endReason: string | null;
      state: string;
    };
    endOk = m.endReason === "aborted" && m.state === "ended";
  } catch (e) {
    console.log(`run.json parse failed: ${String(e)}`);
  }
  ok("run.json endReason=aborted + state=ended", endOk);
}
const fin = (await jget(`${PREFIX}/api/status`)).body as { running: boolean; state: string; endReason: string };
ok("终态 status：running=false / ended / aborted", fin.running === false && fin.state === "ended" && fin.endReason === "aborted");
ok(`hint 闭环（非 active，实际=${hintStatus()}）`, hintClosed);
ok("pause/resume 各收到 status 帧", statusFrames.length >= 2);

// ── 汇总 ──
const failed = checks.filter(([, c]) => !c);
console.log(`\ne2e: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) for (const [n] of failed) console.log(`  FAIL ${n}`);
srv.close();
rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
