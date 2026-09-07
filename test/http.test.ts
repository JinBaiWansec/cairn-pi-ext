/**
 * Step 7: startCairnServer 端点契约测试（carin_step7_plan §3 逐端点）。
 * Run: node test/run.mjs http
 */
import assert from "node:assert";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { get as httpGet } from "node:http";
import { GraphOps } from "../src/graphops.ts";
import { CairnEngine, type EngineOptions } from "../src/engine.ts";
import { startCairnServer } from "../src/index.ts";
import { Transcript } from "../src/transcript.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "ui", "dev", "fixtures");

const CFG: EngineOptions["cfg"] = {
  baseUrl: "http://mock.local",
  apiKey: "k",
  model: "m",
  decideModel: "m",
  contextWindow: 8192,
  oobIp: "",
  maxTurns: 3,
  activityTimeoutMs: 1000,
  turnTimeoutMs: 1000,
  bashTimeoutSec: 5,
  maxExecutes: 5,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await sleep(20);
  }
}

// ── fixture workspace ──────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "cairn-http-"));
try {
  cpSync(join(FIX, "graph.json"), join(dir, "fgs.json"));
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  cpSync(
    join(FIX, "act-001-decide.jsonl"),
    join(dir, "transcripts", "act-001-decide.jsonl"),
  );
  // act-003：1005 行 → 验证 1000 条上限 + 分页
  const long = Array.from({ length: 1005 }, (_, i) =>
    JSON.stringify({
      ts: Date.now(),
      activityId: "act-003",
      kind: "decide",
      type: "text_delta",
      delta: `d${i}`,
    }),
  ).join("\n") + "\n";
  writeFileSync(join(dir, "transcripts", "act-003-decide.jsonl"), long);
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({
      version: 1,
      origin: "o",
      goal: "g",
      config: {
        model: "m",
        decideModel: "m",
        contextWindow: 8192,
        maxTurns: 3,
        activityTimeoutMs: 1000,
        turnTimeoutMs: 1000,
        maxExecutes: 5,
      },
      budget: { executes: 2, decides: 1 },
      usage: { input: 10, output: 20, totalTokens: 30, costTotal: 0.5 },
      state: "running",
      endReason: null,
      startedAt: Date.now() - 60_000,
      endedAt: null,
    }),
  );
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "notes", "small.txt"), "hello notes");
  const BIG = 2 * 1024 * 1024;
  writeFileSync(join(dir, "notes", "big.txt"), Buffer.alloc(BIG, 0x61));

  const ops = GraphOps.load(dir);
  const engine = new CairnEngine({ runDir: dir, cfg: CFG }, ops);
  const srv = await startCairnServer({ runDir: dir, ops, engine, port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;

  const get = async (path: string, init?: RequestInit) => {
    const r = await fetch(base + path, init);
    const body = await r.text();
    return {
      status: r.status,
      headers: r.headers,
      body,
      json: () => JSON.parse(body),
    };
  };
  const post = async (path: string, obj: unknown) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(obj),
    });
    const body = await r.text();
    return { status: r.status, body, json: () => JSON.parse(body) };
  };

  // ── 静态：302 根 / index no-cache / assets immutable / SPA fallback ──
  const root = await get("/", { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/ext/cairn/");

  const idx = await get("/ext/cairn/");
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(idx.headers.get("cache-control"), "no-cache");
  assert.match(idx.body, /<!doctype html/i);

  const assetFile = readdirSync(join(ROOT, "ui", "assets"))
    .filter((f) => f.endsWith(".woff2"))
    .sort()[0];
  const asset = await get(`/ext/cairn/assets/${assetFile}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);

  const spa = await get("/ext/cairn/canvas/deep/path");
  assert.equal(spa.status, 200);
  assert.equal(spa.body, idx.body); // SPA fallback = index.html

  assert.equal((await get("/ext/cairn/nope.js")).status, 404); // 有扩展名缺失

  // ── GET /api/graph ──
  const g1 = (await get("/ext/cairn/api/graph")).json();
  assert.equal(g1.version, 2);
  assert.equal(g1.activeBranch, "main");
  assert.equal(g1.branches[0].head, "rev-3");

  // ── GET /api/status（D8 逐字段）──
  const s1 = (await get("/ext/cairn/api/status")).json();
  assert.equal(s1.running, false);
  assert.equal(s1.state, "running");
  assert.equal(s1.endReason, null);
  assert.equal(s1.activeBranch, "main");
  assert.equal(s1.rev, "rev-3");
  assert.equal(s1.budget.executes, 2);
  assert.equal(s1.budget.decides, 1);
  assert.equal(s1.budget.maxExecutes, 5);
  assert.equal(s1.budget.maxDecides, undefined);
  assert.equal(s1.usage.totalTokens, 30);
  assert.ok(s1.elapsedMs > 0);
  assert.equal(s1.env, undefined); // 真实端点无 env（非 MOCK）
  assert.equal(s1.currentActivityId, undefined);

  // ── GET /api/transcript（D5：分页 / 1000 上限 / nextOffset 递增 / 404）──
  const t1 = (await get("/ext/cairn/api/transcript?activity=act-001")).json();
  assert.equal(t1.events.length, 7);
  assert.equal(t1.nextOffset, 7);

  const p1 = (
    await get("/ext/cairn/api/transcript?activity=act-003&offset=0")
  ).json();
  assert.equal(p1.events.length, 1000); // 上限截断
  assert.equal(p1.nextOffset, 1005);
  const p2 = (
    await get("/ext/cairn/api/transcript?activity=act-003&offset=1000")
  ).json();
  assert.equal(p2.events.length, 5);
  assert.equal(p2.events[0].delta, "d1000");
  assert.equal(p2.nextOffset, 1005);

  // 追加一行 → nextOffset 递增（1006）
  const tApp = Transcript.open(dir, "decide", undefined, "act-003");
  tApp.append({ type: "end", reason: "stopped" });
  const p3 = (
    await get("/ext/cairn/api/transcript?activity=act-003&offset=1005")
  ).json();
  assert.equal(p3.events.length, 1);
  assert.equal(p3.nextOffset, 1006);
  assert.ok(p3.nextOffset > p1.nextOffset);
  tApp.close();

  const t404 = await get("/ext/cairn/api/transcript?activity=act-999");
  assert.equal(t404.status, 404);
  assert.match(t404.json().error, /not found/);
  assert.equal((await get("/ext/cairn/api/transcript")).status, 400);

  // ── GET /api/file（D6：notes 白名单 / 穿越 400 / 1MB 截断）──
  const f1 = (await get("/ext/cairn/api/file?path=notes/small.txt")).json();
  assert.equal(f1.content, "hello notes");
  assert.equal(f1.size, 11);

  assert.equal(
    (await get("/ext/cairn/api/file?path=../fgs.json")).status,
    400,
  ); // 相对穿越
  assert.equal(
    (await get(`/ext/cairn/api/file?path=${encodeURIComponent("/etc/passwd")}`)).status,
    400,
  ); // 绝对路径
  assert.equal((await get("/ext/cairn/api/file")).status, 400); // 缺 path

  const fBig = (await get("/ext/cairn/api/file?path=notes/big.txt")).json();
  assert.equal(fBig.size, BIG);
  assert.equal(fBig.content.length, 1024 * 1024); // 前 1MB
  assert.ok(fBig.content.startsWith("a"));

  // ── POST /api/ops（D7 白名单）──
  assert.equal(
    (await post("/ext/cairn/api/ops", { op: "frobnicate", args: {} })).status,
    400,
  ); // 未知 op
  const hint = await post("/ext/cairn/api/ops", {
    op: "add_hint",
    args: { text: " try /admin" },
  });
  assert.equal(hint.status, 200);
  assert.deepEqual(hint.json(), { ok: true });
  const g2 = (await get("/ext/cairn/api/graph")).json();
  assert.ok(
    g2.branches[0].revisions.at(-1).graph.hints.some(
      (h: { text: string }) => h.text === "try /admin",
    ),
  );
  assert.equal(
    (await post("/ext/cairn/api/ops", { op: "add_hint", args: {} })).status,
    400,
  ); // 空 text
  assert.equal(
    (await post("/ext/cairn/api/ops", { op: "abort" })).status,
    409,
  ); // 未 run
  assert.equal(
    (await post("/ext/cairn/api/ops", { op: "pause" })).status,
    409,
  );

  // ── POST /api/branch + /api/checkout ──
  const br = await post("/ext/cairn/api/branch", { name: "b2" });
  assert.equal(br.status, 200);
  assert.deepEqual(br.json(), { ok: true });
  const g3 = (await get("/ext/cairn/api/graph")).json();
  assert.ok(g3.branches.some((b: { name: string }) => b.name === "b2"));
  assert.equal(
    (await post("/ext/cairn/api/branch", { name: "b2" })).status,
    400,
  ); // 重名
  const co = await post("/ext/cairn/api/checkout", { branch: "b2" });
  assert.equal(co.status, 200);
  assert.equal(
    (await get("/ext/cairn/api/status")).json().activeBranch,
    "b2",
  );
  assert.equal(
    (await post("/ext/cairn/api/checkout", { branch: "nope" })).status,
    400,
  );

  // ── SSE /api/events（D3/D4：transcript + graph 帧）──
  const frames: Array<{
    type: string;
    rev?: string;
    event?: { delta?: string };
  }> = [];
  await new Promise<void>((ok) => {
    const req = httpGet(`${base}/ext/cairn/api/events`, (res) => {
      assert.equal(res.headers["content-type"], "text/event-stream");
      assert.equal(res.headers["cache-control"], "no-cache");
      let buf = "";
      res.on("data", (c) => {
        buf += c.toString();
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) {
              frames.push(JSON.parse(line.slice(6)));
            }
          }
        }
      });
      res.on("end", ok);
      res.on("error", ok);
    });
    req.on("response", () => ok());
  });
  await sleep(50);

  const tSse = Transcript.open(dir, "decide", undefined, "act-009");
  tSse.append({ type: "text_delta", delta: "sse-hello" });
  await until(() =>
    frames.some(
      (f) =>
        f.type === "transcript" &&
        f.event?.delta === "sse-hello",
    ),
  );

  const rev = ops.applyOp("add_hint", "user", (g) =>
    g.hints.push({ id: "h-99", text: "sse", status: "active" }),
  );
  await until(() => frames.some((f) => f.type === "graph" && f.rev === rev.id));

  tSse.close();
  srv.close();
  console.log("http: all endpoint assertions passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
