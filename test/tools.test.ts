/**
 * tools.ts 测试（Step 3）。
 * 覆盖 §9.2 验收：bash 超时 SIGKILL 熔断、>4KB Spill 落盘、Read 切片、
 * 路径逃逸防御、submit_fact 证据落盘/弱关联/降级提交、8 图工具。
 * Run: node test/run.mjs tools
 */
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FINDING_SCHEMA,
  executeBash,
  executeEdit,
  executeRead,
  executeWrite,
  makeExecuteTool,
  makeSubmitFact,
  validateFinding,
  type FindingSchema,
  type ToolCtx,
} from "../src/tools.ts";
import { GraphOps } from "../src/graphops.ts";

const dir = mkdtempSync(join(tmpdir(), "cairn-tools-"));
const ws = join(dir, "workspace");
const runDir = join(dir, "run");
mkdirSync(ws, { recursive: true });
mkdirSync(runDir, { recursive: true });
const ops = GraphOps.create(runDir, "origin", "goal");
const ctx: ToolCtx = { workspaceDir: ws, activityId: "t1", ops };
const exec = makeExecuteTool(ctx);

// --- executeBash：基础 / 退出码 / 超时 / Spill -------------------------------
{
  const r = await executeBash("echo hi", ws, "t1");
  assert.equal(r.ok, true);
  assert.equal(r.output, "hi");
}
{
  const r = await executeBash("exit 3", ws, "t1");
  assert.equal(r.ok, false);
}
{
  // §9.2 死锁防御：交互式/长命令被 timeout -s 9 熔断（用 2s 缩短测试）
  const t0 = Date.now();
  const r = await executeBash("sleep 30", ws, "t1", 2);
  assert.equal(r.ok, false);
  assert.match(r.output, /EXECUTION TIMEOUT/);
  assert.ok(Date.now() - t0 < 8000, "timeout 应在 ~2s 触发");
  // R8：外层 shell 命令替换不得逃逸 timeout 时钟（修前 5034ms，修后 ~2s）
  const t1 = Date.now();
  const rSub = await executeBash("$(sleep 5) echo done", ws, "t1", 2);
  assert.equal(rSub.ok, false, "$(sleep 5) 应在 2s 超时下被杀");
  assert.match(rSub.output, /EXECUTION TIMEOUT/);
  assert.ok(Date.now() - t1 < 4000, "命令替换不得绕过 timeout（应 ~2s）");
}
{
  // >4KB 输出 → Spill 落盘 + head/tail 截断
  const r = await executeBash("yes abcdefgh | head -1000", ws, "t1");
  assert.equal(r.ok, true);
  assert.match(r.output, /OUTPUT TRUNCATED > 4KB/);
  assert.ok(r.spillPath?.startsWith("notes/"));
  assert.ok(existsSync(join(ws, r.spillPath!)), "spill 文件应存在");
  const spill = readFileSync(join(ws, r.spillPath!), "utf8");
  assert.ok(spill.length > 4096, "spill 文件应为完整输出");
}

// --- executeRead：切片 -------------------------------------------------------
{
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n");
  writeFileSync(join(ws, "big.log"), lines);
  const r = executeRead("big.log", ws, 10, 5);
  assert.equal(r.ok, true);
  assert.match(r.output, /lines 11-15 of 50/);
  assert.match(r.output, /line-10/);
  assert.match(r.output, /line-14/);
  assert.doesNotMatch(r.output, /line-15/);
  assert.match(r.output, /offset_lines=15/);
  const missing = executeRead("nope.log", ws);
  assert.equal(missing.ok, false);
  const escape = executeRead("../../etc/passwd", ws);
  assert.equal(escape.ok, false);
  assert.match(escape.output, /escapes workspace/);
}

// --- executeWrite / executeEdit ----------------------------------------------
{
  const r = executeWrite("sub/dir/a.txt", "hello", ws);
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(ws, "sub/dir/a.txt"), "utf8"), "hello");
  const esc = executeWrite("../out.txt", "x", ws);
  assert.equal(esc.ok, false);

  const e1 = executeEdit("sub/dir/a.txt", "hello", "world", ws);
  assert.equal(e1.ok, true);
  assert.equal(readFileSync(join(ws, "sub/dir/a.txt"), "utf8"), "world");
  writeFileSync(join(ws, "dup.txt"), "xxxx");
  const e2 = executeEdit("dup.txt", "x", "y", ws);
  assert.equal(e2.ok, false);
  assert.match(e2.output, /occurs 4 times/);
  const e3 = executeEdit("dup.txt", "nope", "y", ws);
  assert.match(e3.output, /not found/);
}

// --- 8 图工具（经 makeExecuteTool 分发）---------------------------------------
{
  assert.match((await exec("add_step", { text: "A" })).output, /s-1/);
  ops.applyOp("user_hint", "user", (g) => g.hints.push({ id: "h-1", text: "检查端口", status: "active" }));
  const r2 = await exec("add_step", { text: "B", priority: 10, addresses_hint: "h-1" });
  assert.match(r2.output, /s-2/);
  const g1 = ops.headGraph();
  assert.equal(g1.steps[1].priority, 10);
  assert.equal(g1.steps[1].addresses_hint, "h-1");
  // 落实即闭环：hint 翻转 addressed（此前无任何代码路径置 addressed，e2e 实测只能 reject）
  assert.equal(g1.hints[0].status, "addressed");
  // 未知 hint id → 报错（模型不得拿文本猜 id）
  const r2b = await exec("add_step", { text: "C", addresses_hint: "h-404" });
  assert.match(r2b.output, /unknown hint id: h-404/);

  const sp = await exec("set_step_priority", { id: "s-2", priority: 99 });
  assert.equal(ops.headGraph().steps[1].priority, 99);
  assert.equal(sp.ok, true);
  assert.match((await exec("done_step", { id: "s-1" })).output, /done_step ok/);
  assert.match((await exec("drop_step", { id: "s-2", reason: "无效" })).output, /drop_step ok/);
  assert.equal(ops.headGraph().steps[0].status, "done");
  assert.equal(ops.headGraph().steps[1].status, "dropped");
  assert.equal(ops.headGraph().steps[1].lastOutcome, "无效");

  const sg = await exec("add_subgoal", { text: "拿下 /admin" });
  assert.match(sg.output, /sg-1/);
  assert.match((await exec("remove_subgoal", { id: "sg-1" })).output, /remove_subgoal ok/);
  assert.equal(ops.headGraph().subgoals.length, 0);

  ops.applyOp("user_hint", "user", (g) => g.hints.push({ id: "h-9", text: "试一下 SQLi", status: "active" }));
  assert.match((await exec("reject_hint", { id: "h-9", reason: "不适用" })).output, /reject_hint ok/);
  assert.equal(ops.headGraph().hints.find((h) => h.id === "h-9")!.status, "rejected");

  const bad = await exec("done_step", { id: "s-99" });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /unknown step/);
  assert.match((await exec("complete", { reason: "f-1 确证 flag" })).output, /run completed/);
  const unknown = await exec("nope", {});
  assert.equal(unknown.ok, false);
  assert.match(unknown.output, /unknown tool/);
}

// --- submit_fact：落盘 / superseded / weak_refs / findings / 降级 --------------
{
  const sf = makeSubmitFact(ctx);

  // 正常提交 → 证据落盘 + 入图
  const r1 = sf({ description: "3000 端口开放 HTTP", evidence: "curl: 200 OK ..." });
  assert.match(r1.output, /f-1 committed/);
  assert.ok(existsSync(join(ws, "notes/facts/f-1.txt")));
  const g1 = ops.headGraph();
  assert.equal(g1.facts.length, 1);
  assert.equal(g1.facts[0].spill_path, "notes/facts/f-1.txt");
  assert.ok(g1.facts[0].evidence_summary.length <= 80);

  // blocks → superseded 链
  const r2 = sf({ description: "3000 实为 Node 服务", evidence: "x-powered-by: Express", blocks: ["f-1"] });
  assert.match(r2.output, /superseded: f-1/);
  const g2 = ops.headGraph();
  assert.equal(g2.facts[0].superseded?.by_fact_id, "f-2");

  // 引用已作废 fact → weak_refs 标记（不拦截）
  const r3 = sf({ description: "f-1 提到的端口仍开放", evidence: "nc -zv ... open" });
  assert.match(r3.output, /WEAK REFS/);
  assert.deepEqual(ops.headGraph().facts[2].weak_refs, ["f-1"]);

  // findings 合法 → 入图
  const rf = sf({
    description: "登录接口 SQLi",
    evidence: "500 error on ' OR 1=1",
    findings: [{ title: "SQLi", endpoint: "/rest/user/login", severity: "high", evidence: "500 ..." }],
  });
  assert.match(rf.output, /f-4 committed/);
  const g4 = ops.headGraph();
  assert.equal(g4.findings.length, 1);
  assert.equal(g4.findings[0].severity, "high");
  assert.equal(g4.findings[0].evidence_path, "notes/facts/f-4.txt");

  // findings 连续 2 次校验失败 → 第 2 次降级强制入图
  const bad1 = sf({ description: "坏 findings 1", evidence: "e", findings: [{ title: "x" }] });
  assert.equal(bad1.ok, false, "第 1 次校验失败应拒绝");
  assert.match(bad1.output, /missing required field/);
  // R2：reject 分支证据也应落盘（崩溃不丢长程探测成果，§5.3）
  const factFiles = readdirSync(join(ws, "notes", "facts"), "utf8").filter((f) => f.endsWith(".txt"));
  const bad1Evidence = factFiles.map((f) => readFileSync(join(ws, "notes", "facts", f), "utf8"));
  assert.ok(bad1Evidence.some((c) => c.includes("坏 findings 1")), "reject 时证据应已落盘");
  // 偏差①：降级时只剥离非法 findings，合法者保留入图
  const bad2 = sf({
    description: "坏 findings 2",
    evidence: "e",
    findings: [
      { title: "ok", endpoint: "/e", severity: "low", evidence: "x" },
      { severity: "ultra" },
    ],
  });
  assert.match(bad2.output, /DEGRADED/);
  assert.match(bad2.output, /1 条合法 findings 已保留/);
  const g5 = ops.headGraph();
  const degraded = g5.facts.find((f) => f.quality === "degraded");
  assert.ok(degraded, "降级 fact 应入图");
  assert.equal(g5.findings.length, 2, "降级时非法 findings 被剥离，合法者保留");

  // 空描述拒绝
  const empty = sf({ description: "", evidence: "e" });
  assert.equal(empty.ok, false);
}

// --- validateFinding / 动态 Schema 工厂 ---------------------------------------
{
  const ok = validateFinding(
    { title: "t", endpoint: "/a", severity: "critical", evidence: "e" },
    DEFAULT_FINDING_SCHEMA,
  );
  assert.equal(ok.ok, true);
  const bad = validateFinding({ title: 42, endpoint: "/a", severity: "low", evidence: "e" }, DEFAULT_FINDING_SCHEMA);
  assert.equal(bad.ok, false);
  const custom: FindingSchema = {
    label: "flag",
    fields: [
      { name: "flag", type: "string", required: true },
      { name: "score", type: "number" },
    ],
  };
  assert.equal(validateFinding({ flag: "flag{a}" }, custom).ok, true);
  assert.equal(validateFinding({ score: 3 }, custom).ok, false);
}

rmSync(dir, { recursive: true, force: true });
