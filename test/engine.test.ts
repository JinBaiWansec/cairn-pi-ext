/**
 * engine.test.ts — real-model smoke: fresh start -> decide runs -> external
 * abort propagates -> end reason "aborted", graph persisted.
 */
import { startEngine } from "../src/engine.js";
import { FgsGraph } from "../src/graph.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ws = mkdtempSync(join(tmpdir(), "cairn-engine-"));
let widgetCalls = 0;
const logs: string[] = [];

const t0 = Date.now();
const { engine, resumed, done } = startEngine(
  {
    workspace: ws,
    decideModel: "qwen/qwen-27b",
    executeModel: "qwen/qwen-27b",
    maxExecutes: 2,
    decideTimeoutMs: 60_000,
    executeTimeoutMs: 30_000,
    concludeTimeoutMs: 15_000,
    dormancyMs: 300,
    onWidget: () => widgetCalls++,
    onLog: (l) => logs.push(l),
  },
  "origin: smoke test on kali",
  "goal: 确认本机可以运行 node",
);

assert(!resumed, "fresh workspace must not resume");
assert(FgsGraph.exists(ws), "fgs.json created immediately");
assert(FgsGraph.peek(ws)!.facts[0].source === "origin", "origin seeded as f-1");
assert(FgsGraph.peek(ws)!.goal.text.startsWith("goal:"), "goal stored");

setTimeout(() => engine.abort(), 8_000);
const reason = await done;

console.log(logs.join("\n"));
const data = FgsGraph.peek(ws)!;
assert(reason === "aborted", `end reason, got ${reason}`);
assert(data.stats.decides >= 1, "decide counter bumped");
assert(widgetCalls >= 1, "widget called");
assert(
  logs.some((l) => l.includes("abort requested")),
  "abort logged",
);
assert(
  logs.some((l) => l.includes("decide: sub-session start")),
  "decide sub-session started",
);
const secs = (Date.now() - t0) / 1000;
console.log(
  `engine smoke: reason=${reason} decides=${data.stats.decides} ${secs.toFixed(1)}s`,
);
rmSync(ws, { recursive: true, force: true });
console.log("engine.test: all assertions passed");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`ASSERT FAIL: ${msg}`);
    console.error(logs.join("\n"));
    process.exit(1);
  }
}
