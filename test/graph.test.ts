/**
 * graph.ts smoke test: append -> state transitions -> snapshot round-trip.
 * Run: node test/graph.test.ts
 */
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FgsGraph } from "../src/graph.ts";

const ws = mkdtempSync(join(tmpdir(), "cairn-graph-"));
try {
 // create
 const g = FgsGraph.create(ws, "/tmp/ctf 里有个 zip", "解出 flag");
 assert.equal(g.data.facts.length, 1);
 assert.equal(g.data.facts[0].source, "origin");
 assert.equal(FgsGraph.peek(ws)?.goal.text, "解出 flag");

 // reload from disk (round-trip)
 const g2 = FgsGraph.load(ws);
 assert.equal(g2.data.goal.text, "解出 flag");

 // steps + state machine
 const s1 = g2.addStep("列出 /tmp/ctf 内容");
 const s2 = g2.addStep("检查 zip 密码");
 assert.deepEqual(
  g2.openSteps().map((s) => s.id),
  [s1.id, s2.id],
 );
 g2.setStepStatus(s1.id, "running");
 assert.throws(
  () => g2.setStepStatus(s1.id, "running"),
  /illegal step transition/,
 );
 assert.throws(() => g2.setStepStatus(s1.id, "done"), /requires resultFactId/);
 const fact = g2.recordStepResult(
  s1.id,
  "zip 文件为 ctf.zip，未加密",
  [{ title: "zip 存在", evidence: "ls 输出" }],
  false,
 );
 assert.equal(fact.source, `step:${s1.id}`);
 assert.equal(g2.getStep(s1.id)?.status, "done");
 assert.equal(g2.getStep(s1.id)?.result_fact_id, fact.id);
 assert.equal(g2.data.findings.length, 1);
 g2.dropStep(s2.id);
 assert.equal(g2.getStep(s2.id)?.status, "dropped");
 // terminal states are frozen
 assert.throws(
  () => g2.setStepStatus(s1.id, "running"),
  /illegal step transition/,
 );
 assert.throws(
  () => g2.setStepStatus(s2.id, "running"),
  /illegal step transition/,
 );

 // conclude path
 const s3 = g2.addStep("尝试常见弱口令");
 g2.setStepStatus(s3.id, "running");
 const cf = g2.recordStepResult(s3.id, "尝试了 4 个弱口令均未通过", [], true);
 assert.equal(cf.source, `conclude:${s3.id}`);
 assert.equal(g2.getStep(s3.id)?.status, "done");

 // subgoals
 g2.applySubgoals({ add: ["找到 zip", "解出 flag"] });
 const sg0 = g2.data.goal.subgoals[0].id;
 g2.applySubgoals({ done: [sg0] });
 assert.equal(g2.data.goal.subgoals[0].done, true);
 g2.applySubgoals({ drop: [g2.data.goal.subgoals[1].id] });
 assert.equal(g2.data.goal.subgoals.length, 1);

 // hints
 g2.addHint("先看文件上传");
 assert.equal(g2.unconsumedHints().length, 1);
 assert.equal(g2.consumeHints(), 1);
 assert.equal(g2.unconsumedHints().length, 0);
 g2.addHint("另一个 hint"); // unconsumed, should appear in snapshots
 g2.save();

 // snapshots
 const decidePath = g2.decideSnapshot();
 const decide = JSON.parse(readFileSync(decidePath, "utf8"));
 assert.equal(decide.phase, "decide");
 assert.ok(Array.isArray(decide.steps) && decide.steps.length === 3);
 assert.ok(Array.isArray(decide.findings) && decide.findings.length === 1);
 assert.ok(
  decide.hints.some((h: { text: string }) => h.text === "另一个 hint"),
 );

 const execPath = g2.executeSnapshot("s-1");
 const exec = JSON.parse(readFileSync(execPath, "utf8"));
 assert.equal(exec.phase, "execute");
 assert.equal(exec.steps, null);
 assert.equal(exec.findings, null);
 assert.equal(exec.current_step.id, "s-1");
 assert.equal(exec.current_step.text, "列出 /tmp/ctf 内容");
 assert.ok(exec.origin.includes("/tmp/ctf"));
 assert.ok(exec.goal.text === "解出 flag");

 // idempotency: same content -> same path (hash)
 assert.equal(g2.decideSnapshot(), decidePath);

 // budget helper
 assert.ok(g2.fullGraphBytes() > 100);

 // crash-recovery: only open steps are scheduled
 const g3 = FgsGraph.load(ws);
 assert.deepEqual(g3.openSteps(), []);
 const s4 = g3.addStep("恢复后新增");
 assert.deepEqual(
  g3.openSteps().map((s) => s.id),
  [s4.id],
 );

 console.log("graph.test: all assertions passed");
} finally {
 rmSync(ws, { recursive: true, force: true });
}
