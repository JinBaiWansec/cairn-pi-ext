/**
 * fixes.test.ts — no-LLM regression tests for the three engine fixes:
 *   1. D5-1 execute snapshot fact window: origin + newest EXECUTE_FACT_WINDOW
 *   2. decide change gate: unchanged state + 0 fails -> dormancy (no LLM);
 *      parse failures retry the same state, from fails>=3 the gate sleeps
 *   3. hints: consumed after successful decide parse; fingerprint linkage
 *      (new hint -> decide; consumption -> one confirmation decide; stable)
 *
 * runSubSession is patched BEFORE engine.ts loads, so no real sub-session
 * (and no model) is ever invoked.
 * Run: node test/run.mjs fixes
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as subagent from "../src/subagent.ts";
import { EXECUTE_FACT_WINDOW, FgsGraph } from "../src/graph.ts";

let calls = 0;
let fakeText = "{}";
(subagent as Record<string, unknown>).runSubSession = async () => {
  calls++;
  return { text: fakeText, timedOut: false };
};
const { CairnEngine } = await import("../src/engine.ts");

const fail = (msg: string): never => {
  console.error(`ASSERT FAIL: ${msg}`);
  process.exit(1);
};

const ws = mkdtempSync(join(tmpdir(), "cairn-fixes-"));
const wsG = mkdtempSync(join(tmpdir(), "cairn-fixesG-"));
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

  // ------------------------------------------------ 2+3. gate + hints fp
  {
    const logs: string[] = [];
    const g = FgsGraph.create(wsG, "origin", "goal");
    const e = new CairnEngine(
      {
        workspace: wsG,
        decideModel: "fake",
        executeModel: "fake",
        maxExecutes: 5,
        decideTimeoutMs: 1000,
        executeTimeoutMs: 1000,
        concludeTimeoutMs: 1000,
        dormancyMs: 1,
        onLog: (l) => logs.push(l),
      },
      g,
    );
    const eng = e as unknown as {
      runDecide(): Promise<string>;
      decideFp(): string;
      lastDecideFp: string | null;
      decideFpFails: number;
    };
    const fpOf = () => g.data.facts.length; // sanity anchor, unused

    // A: first decide — lastDecideFp null -> gate passes; "{}" -> kind none
    calls = 0;
    fakeText = "{}";
    if ((await eng.runDecide()) !== "continue") fail("A: want continue");
    if (calls !== 1) fail(`A: sub-session must run once, calls=${calls}`);
    if (eng.decideFpFails !== 0) fail("A: fails must be 0");
    if (eng.lastDecideFp === null) fail("A: lastDecideFp must be set");

    // B: unchanged state, fails=0 -> dormancy, NO LLM
    calls = 0;
    if ((await eng.runDecide()) !== "continue") fail("B: want continue");
    if (calls !== 0) fail(`B: gate must skip LLM, calls=${calls}`);
    if (!logs.some((l) => l.includes("dormancy (no LLM)")))
      fail("B: want dormancy log");

    // H: new hint -> state change -> sub-session; garbage parse -> fails=1
    g.addHint("hint-1");
    calls = 0;
    fakeText = "no json here";
    if ((await eng.runDecide()) !== "continue") fail("H: want continue");
    if (calls !== 1) fail(`H: changed state must run LLM, calls=${calls}`);
    if (eng.decideFpFails !== 1) fail(`H: want fails=1, got ${eng.decideFpFails}`);
    // fingerprint of the state at A must NOT have been recorded (parse failed)
    if (eng.lastDecideFp === eng.decideFp())
      fail("H: lastDecideFp must not advance on parse failure");

    // R1/R2: unchanged state (hint still unconsumed), fails=1,2 -> retry LLM
    for (const want of [2, 3]) {
      calls = 0;
      if ((await eng.runDecide()) !== "continue") fail(`R: want continue (fails=${want})`);
      if (calls !== 1)
        fail(`R: fails=${want - 1} must retry LLM, calls=${calls}`);
      if (eng.decideFpFails !== want)
        fail(`R: want fails=${want}, got ${eng.decideFpFails}`);
    }

    // R3: fails>=3 -> gate sleeps again, NO LLM
    calls = 0;
    if ((await eng.runDecide()) !== "continue") fail("R3: want continue");
    if (calls !== 0) fail(`R3: gate must sleep at fails>=3, calls=${calls}`);
    if (!logs.some((l) => l.includes("3 parse failures already")))
      fail("R3: want '3 parse failures already' log");

    // G: new hint -> state change -> fails reset, sub-session, success ->
    //    consumes BOTH unconsumed hints (2)
    g.addHint("hint-2");
    calls = 0;
    fakeText = "{}";
    if ((await eng.runDecide()) !== "continue") fail("G: want continue");
    if (calls !== 1) fail(`G: changed state must run LLM, calls=${calls}`);
    if (eng.decideFpFails !== 0) fail("G: fails must reset on state change");
    if (!g.data.hints.every((h) => h.consumed) || g.data.hints.length !== 2)
      fail(`G: both hints must be consumed, got ${JSON.stringify(g.data.hints)}`);
    if (!logs.some((l) => l.includes("hints consumed: 2")))
      fail("G: want 'hints consumed: 2' log");

    // P: consumption changed the fp -> exactly ONE confirmation decide
    calls = 0;
    fakeText = "{}";
    if ((await eng.runDecide()) !== "continue") fail("P: want continue");
    if (calls !== 1)
      fail(`P: confirmation decide must run once, calls=${calls}`);
    if (calls > 1) fail("P: confirmation must be a single run");

    // Q: stable now -> dormancy, no LLM
    calls = 0;
    if ((await eng.runDecide()) !== "continue") fail("Q: want continue");
    if (calls !== 0) fail(`Q: stable state must sleep, calls=${calls}`);

    if (fpOf() !== 1) fail("anchor: graph should have only origin fact");
    console.log(
      "fixes.test: gate OK (A=1,B=0,H=1,R1=1,R2=1,R3=0,G=1,P=1,Q=0 LLM calls)",
    );
  }
  console.log("fixes.test: all assertions passed");
} finally {
  rmSync(ws, { recursive: true, force: true });
  rmSync(wsG, { recursive: true, force: true });
}
