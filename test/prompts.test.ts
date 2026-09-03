/** prompts.ts smoke: placeholders rendered, contract present. Run via jiti one-liner. */
import assert from "node:assert";
import { decidePrompt, executePrompt, concludePrompt } from "../src/prompts.ts";

const d0 = decidePrompt({ snapshotPath: "/ws/snapshots/decide-abc.json", openStepCount: 0 });
const d2 = decidePrompt({ snapshotPath: "/ws/x.json", openStepCount: 2, compressHint: true });
assert.ok(d0.includes("/ws/snapshots/decide-abc.json"));
assert.ok(d0.includes("必须给出 steps"), "no open steps -> must give steps");
assert.ok(d2.includes("已有 2 个 open step"));
assert.ok(d2.includes("facts 较多"));
assert.ok(d0.includes('{"complete": {"reason"') && d0.includes('{"steps":') && d0.includes("subgoals"));

const e = executePrompt({ snapshotPath: "/ws/e.json", stepId: "s-3", stepText: "检查 zip 密码" });
assert.ok(e.includes("/ws/e.json") && e.includes("s-3: 检查 zip 密码"));
assert.ok(e.includes('"accepted": true, "data": {"description"'));
assert.ok(e.includes("conclude 指令"), "execute must pre-announce conclude override");

const c = concludePrompt({ snapshotPath: "/ws/c.json", stepId: "s-3", stepText: "检查 zip 密码" });
assert.ok(c.includes("/ws/c.json") && c.includes("s-3: 检查 zip 密码"));
assert.ok(c.includes("覆盖本会话之前所有") || c.includes("覆盖"));
assert.ok(c.includes("不要再运行任何命令"));

console.log("prompts.test: all assertions passed");
