/**
 * subagent.ts smoke: real sub-session runs "ls 当前目录并回答", event stream
 * visible, hard timeout fires. Run via jiti one-liner (takes ~1 min, hits local LLM).
 */
import assert from "node:assert";
import { runSubSession } from "../src/subagent.ts";

const events: string[] = [];
const r = await runSubSession({
 phase: "execute",
 prompt:
  "用 bash 执行 `ls` 查看当前目录，然后用一句话回答目录里有什么。" +
  '最后必须输出一行 JSON：{"accepted": true, "data": {"description": "<目录内容一句话>"}}',
 workspace: "/home/kali/work/cairn-pi-ext",
 modelRef: "qwen/qwen-27b",
 timeoutMs: 180_000,
 onEvent: (e) => events.push(`${e.type}${e.detail ? `:${e.detail}` : ""}`),
});

console.log("timedOut:", r.timedOut, "error:", r.error);
console.log("last text:", r.text.slice(-400));
console.log("events:", events.length, "|", events.slice(-8).join(" "));

assert.ok(!r.timedOut, "should not time out");
assert.ok(!r.error, `prompt run failed: ${r.error}`);
assert.ok(r.text.length > 0, "assistant text must not be empty");

// hard timeout: 3s budget must abort
const t0 = Date.now();
const r2 = await runSubSession({
 phase: "decide",
 prompt: "慢慢思考，写一段很长的分析",
 workspace: "/home/kali/work/cairn-pi-ext",
 modelRef: "qwen/qwen-27b",
 timeoutMs: 3000,
});
const elapsed = Date.now() - t0;
console.log("timeout case: timedOut:", r2.timedOut, "elapsed:", elapsed);
assert.ok(r2.timedOut, "3s budget must time out");

console.log("subagent.test: all assertions passed");
