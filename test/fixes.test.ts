/**
 * fixes.test.ts — no-LLM regression test for the execute snapshot fact window:
 *   D5-1: origin + newest EXECUTE_FACT_WINDOW (old FgsGraph API, 保留至 Step 7
 *   随 FgsGraph 旧 API 整体删除)。
 *
 * Step 5：旧 change-gate / hints 节（依赖 runSubSession 文本协议）随 engine
 * 重写删除 —— 新状态机（zeroDiff/PARKED/快路径）由 engine.test.ts T1-T7 覆盖。
 * Run: node test/run.mjs fixes
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXECUTE_FACT_WINDOW, FgsGraph } from "../src/graph.ts";

const fail = (msg: string): never => {
  console.error(`ASSERT FAIL: ${msg}`);
  process.exit(1);
};

const ws = mkdtempSync(join(tmpdir(), "cairn-fixes-"));
try {
  // ------------------------------------------------ 1. execute fact window
  {
    const g = FgsGraph.create(ws, "origin-text", "goal-text");
    for (let i = 0; i < 19; i++) {
      const s = g.addStep(`step ${i}`);
      g.setStepStatus(s.id, "running");
      g.recordStepResult(s.id, `fact ${i}`, [], false);
    }
    if (g.data.facts.length !== 20) fail(`want 20 facts, got ${g.data.facts.length}`);

    const exec = JSON.parse(
      readFileSync(g.executeSnapshot(g.data.steps[0].id), "utf8"),
    ) as { facts: { text: string; source: string }[] };
    if (exec.facts.length !== EXECUTE_FACT_WINDOW + 1)
      fail(`window: want ${EXECUTE_FACT_WINDOW + 1} facts, got ${exec.facts.length}`);
    if (exec.facts[0].source !== "origin")
      fail(`window: first fact must be origin, got ${exec.facts[0].source}`);
    if (exec.facts.at(-1)?.text !== "fact 18")
      fail(`window: last fact must be newest, got ${exec.facts.at(-1)?.text}`);

    // small graph (< window+1) passes through untouched
    const ws2 = mkdtempSync(join(tmpdir(), "cairn-fixes2-"));
    const g2 = FgsGraph.create(ws2, "o2", "g2");
    for (let i = 0; i < 4; i++) {
      const s = g2.addStep(`s ${i}`);
      g2.setStepStatus(s.id, "running");
      g2.recordStepResult(s.id, `f ${i}`, [], false);
    }
    const exec2 = JSON.parse(
      readFileSync(g2.executeSnapshot(g2.data.steps[0].id), "utf8"),
    ) as { facts: unknown[] };
    if (exec2.facts.length !== 5)
      fail(`small graph: want 5 facts, got ${exec2.facts.length}`);
    rmSync(ws2, { recursive: true, force: true });
    console.log("fixes.test: window OK (20->9 trimmed, 5->5 untouched)");
  }
  console.log("fixes.test: all assertions passed");
} finally {
  rmSync(ws, { recursive: true, force: true });
}
