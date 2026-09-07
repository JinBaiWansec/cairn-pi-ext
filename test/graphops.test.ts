/**
 * graphops.ts + FGS 投影/事实 helper 测试（Step 2）。
 * Run: node test/run.mjs graphops
 */
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFactEntry,
  estTokens,
  extractWorldResidue,
  factDedupKey,
  projectDecideSkeleton,
  projectExecuteSubgraph,
  type FGSFact,
  type FGSGraph,
} from "../src/graph.ts";
import { GraphOps } from "../src/graphops.ts";

const dir = mkdtempSync(join(tmpdir(), "cairn-graphops-"));
try {
  // ---------------------------------------------------------------- create
  const ops = GraphOps.create(dir, "juice-shop 靶机", "拿到后台 flag");
  assert.ok(GraphOps.exists(dir));
  assert.equal(ops.data.version, 2);
  assert.equal(ops.data.revCounter, 1);
  assert.equal(ops.activeBranch.name, "main");
  assert.equal(ops.headGraph().origin, "juice-shop 靶机");

  // ---------------------------------------------------------------- applyOp
  const rev1 = ops.applyOp("add_step", "model", (g) => {
    g.steps.push({ id: "s-1", text: "端口扫描", priority: 1, status: "pending", attempts: 0 });
  });
  assert.equal(rev1.id, "rev-2");
  assert.equal(rev1.parent, "rev-1");
  assert.equal(rev1.by, "model");
  assert.equal(ops.data.revCounter, 2);
  assert.equal(ops.activeBranch.head, "rev-2");

  // 不可变：rev-1 的快照不能被后续 op 污染
  const rev1Snap = ops.branch("main").revisions.find((r) => r.id === "rev-1")!;
  assert.equal(rev1Snap.graph.steps.length, 0);
  assert.equal(ops.headGraph().steps.length, 1);

  ops.applyOp("start_step", "model", (g) => {
    g.steps[0].status = "in_progress";
    g.steps[0].attempts = 1;
  });
  const rev3 = ops.branch("main").revisions.find((r) => r.id === "rev-3")!;
  assert.equal(rev3.op, "start_step");
  assert.equal(rev3.graph.steps[0].status, "in_progress");

  // load 往返
  const re = GraphOps.load(dir);
  assert.equal(re.data.revCounter, 3);
  assert.equal(re.headGraph().steps[0].attempts, 1);

  // ---------------------------------------------------------------- fork + 世界残留
  re.forkBranch("alt"); // 默认从 main head (rev-3) fork
  const alt = re.branch("alt");
  assert.equal(alt.forkFromRevision, "rev-3");
  assert.equal(alt.forkFromBranch, "main");
  assert.equal(alt.revisions.length, 3);
  assert.equal(re.activeBranch.name, "main"); // fork 不切换

  // main 在 fork 点之后新增 fact → alt 应看到世界残留
  re.applyOp("submit_fact", "model", (g) => {
    g.facts.push({
      id: "f-1",
      description: "3000 端口开放，Node 服务",
      evidence_summary: "nmap 输出",
      spill_path: "notes/facts/f-1.txt",
      created_at: Date.now(),
      created_by: "model",
    });
  });
  const residue = extractWorldResidue(re.data, alt);
  assert.ok(residue.includes("f-1"));
  assert.ok(residue.includes("世界残留"));

  // alt 上的变更不污染 main
  re.checkout("alt");
  re.applyOp("drop_step", "model", (g) => {
    g.steps[0].status = "dropped";
  });
  assert.equal(re.headGraph().steps[0].status, "dropped");
  re.checkout("main");
  assert.equal(re.headGraph().steps[0].status, "in_progress");
  assert.equal(extractWorldResidue(re.data, re.branch("main")), "");

  // fork 自中间 revision：残留只算 fork 点之后的 fact
  re.checkout("main");
  const mid = re.forkBranch("back", "main", "rev-2");
  const midResidue = extractWorldResidue(re.data, mid);
  assert.ok(midResidue.includes("f-1")); // rev-3/rev-4 之后的 fact
  re.checkout("main");

  // rev-<n> 跨分支全局递增
  re.checkout("back");
  const revBack = re.applyOp("add_step", "model", (g) => {
    g.steps.push({ id: "s-2", text: "接口枚举", priority: 2, status: "pending", attempts: 0 });
  });
  assert.ok(Number(revBack.id.slice(4)) > 4);
  re.checkout("main");
  const revMain = re.applyOp("add_step", "model", (g) => {
    g.steps.push({ id: "s-3", text: "鉴权爆破", priority: 3, status: "pending", attempts: 0 });
  });
  assert.ok(Number(revMain.id.slice(4)) > Number(revBack.id.slice(4)));

  // ---------------------------------------------------------------- 投影
  const g: FGSGraph = re.headGraph();
  const sk = JSON.parse(projectDecideSkeleton(g)) as {
    steps: Array<{ id: string; status: string }>;
    facts: Array<{ id: string; d: string; sup: boolean }>;
  };
  const skIds = sk.steps.map((s) => s.id).join(",");
  assert.ok(skIds.includes("s-3"));
  assert.ok(skIds.includes("s-1")); // main 上 s-1 仍 in_progress
  assert.ok(!skIds.includes("s-2")); // s-2 只在 back 分支
  // dropped 隐藏：alt 分支上 s-1 已 dropped
  const skAlt = JSON.parse(projectDecideSkeleton(re.headGraph(re.branch("alt")))) as {
    steps: Array<{ id: string }>;
  };
  assert.ok(!skAlt.steps.map((s) => s.id).join(",").includes("s-1"));
  for (const f of sk.facts) assert.ok(f.d.length <= 51); // ≤50 字 + …

  const s3 = g.steps.find((s) => s.id === "s-3")!;
  const sub = JSON.parse(projectExecuteSubgraph(g, s3)) as {
    facts: Array<{ id: string; path: string }>;
    step: { id: string };
  };
  assert.equal(sub.step.id, "s-3");
  for (const f of sub.facts) assert.ok(f.path.startsWith("notes/facts/"));

  // 预算：塞 500 条大 fact，投影仍 ≤ 2.5k tok 预算（*4 字符）
  const big: FGSGraph = structuredClone(g);
  for (let i = 0; i < 500; i++) {
    big.facts.push({
      id: `f-${i + 100}`,
      description: "x".repeat(500),
      evidence_summary: "e",
      spill_path: `notes/facts/f-${i + 100}.txt`,
      created_at: Date.now(),
      created_by: "model",
    });
  }
  assert.ok(projectExecuteSubgraph(big, big.steps.find((s) => s.id === "s-3")!).length <= 2500 * 4 + 64);
  assert.ok(projectDecideSkeleton(big).length <= 1500 * 4 + 64);

  // ---------------------------------------------------------------- 事实 helper
  const existing: FGSFact[] = [
    {
      id: "f-1",
      description: "旧认知",
      evidence_summary: "e",
      spill_path: "notes/facts/f-1.txt",
      created_at: 1,
      created_by: "model",
    },
  ];
  const r1 = buildFactEntry({
    id: "f-2",
    description: "推翻 f-1 的新认知",
    evidence: "curl 输出……",
    by: "model",
    blocks: ["f-1"],
    existing,
  });
  assert.equal(r1.fact.evidence_summary, "curl 输出……"); // ≤80 字全保留
  assert.equal(r1.fact.spill_path, "notes/facts/f-2.txt");
  assert.deepEqual(r1.superseded, [{ id: "f-1", by: "f-2" }]);

  // superseded 链：再引用 f-1（已作废）→ weak_refs
  existing.push(r1.fact);
  existing[0].superseded = { by_fact_id: "f-2", reason: "被推翻" };
  const r2 = buildFactEntry({
    id: "f-3",
    description: "基于 f-1 的补充",
    evidence: "…",
    by: "model",
    existing,
  });
  assert.deepEqual(r2.fact.weak_refs, ["f-1"]);
  assert.deepEqual(r2.superseded, []);

  // 降级提交
  const r3 = buildFactEntry({
    id: "f-4",
    description: "d",
    evidence: "e",
    by: "model",
    quality: "degraded",
    existing,
  });
  assert.equal(r3.fact.quality, "degraded");

  // 去重键
  assert.equal(factDedupKey("端口 3000 开放"), factDedupKey("端口3000开放 "));
  assert.notEqual(factDedupKey("端口3000"), factDedupKey("端口8080"));

  // R1：estTokens CJK 修正（纯 len/4 对中文低估 ~3.4×）
  const zh = "通过子代理机制可以并行执行多个独立的探索任务来加速整体进度"; // 29 字
  assert.equal(estTokens(zh), 29, "CJK 应按 ~1 字/token 计（旧实现 8）");
  assert.equal(estTokens("abcd"), 1, "ASCII 仍按 4 字符/token");
  assert.equal(estTokens("端口abcd"), 2 + 1, "混合串：CJK + ASCII/4");

  // Step 7：onGraphChange 提交点通知 + checkout
  const notified: Array<[string, string]> = [];
  re.onGraphChange((r, b) => notified.push([r, b]));
  const rv = re.applyOp("add_hint", "user", (g) => {
    g.hints.push({ id: "h-1", text: "t", status: "active" });
  });
  assert.deepEqual(notified.at(-1), [rv.id, re.data.activeBranch]);
  re.checkout("back");
  assert.equal(re.data.activeBranch, "back");
  assert.ok(notified.some(([r, b]) => b === "back"));
  assert.throws(() => re.checkout("nope"), /unknown branch nope/);

  console.log("graphops: all assertions passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
