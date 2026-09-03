/**
 * protocol.ts smoke test: fence tolerance, surrounding prose, bad JSON, missing fields.
 * Run: node -e "import('jiti').then(async (m) => { const j = m.createJiti(import.meta.url); await j.import('./test/protocol.test.ts'); })"
 */
import assert from "node:assert";
import type {
 DecideOutput,
 ExecuteOutput,
 ParseResult,
} from "../src/protocol.ts";
import {
 parseDecideOutput,
 parseExecuteOutput,
 extractJson,
} from "../src/protocol.ts";

// --- extraction
assert.deepEqual(
 extractJson('blah {not json} then\n```json\n{"a":1}\n```trailing'),
 { a: 1 },
);
assert.deepEqual(extractJson('前文 {"x": [1, {"y": 2}]} 后文'), {
 x: [1, { y: 2 }],
});
assert.equal(extractJson("no braces at all"), null);
assert.equal(extractJson("{broken"), null);
assert.deepEqual(extractJson('escaped " in string {"a": "he said \\"hi\\""}'), {
 a: 'he said "hi"',
});

// --- decide: complete
let r: ParseResult<DecideOutput | ExecuteOutput> = parseDecideOutput(
 '分析完毕。\n```json\n{"complete": {"reason": "flag 已找到"}}\n```',
);
assert.ok(
 r.ok && r.value.kind === "complete" && r.value.reason === "flag 已找到",
);

r = parseDecideOutput('{"complete": {}}');
assert.ok(!r.ok, "complete without reason must fail");
r = parseDecideOutput('{"complete": "yes"}');
assert.ok(!r.ok);

// --- decide: steps
r = parseDecideOutput(
 '{"steps": ["列出目录", "检查 zip"], "subgoals": {"add": ["找到 zip"], "done": ["sg-1"]}}',
);
assert.ok(r.ok && r.value.kind === "steps");
if (r.ok && r.value.kind === "steps") {
 assert.equal(r.value.steps.length, 2);
 assert.deepEqual(r.value.subgoals?.add, ["找到 zip"]);
 assert.deepEqual(r.value.subgoals?.done, ["sg-1"]);
 assert.equal(r.value.subgoals?.drop, undefined);
}
r = parseDecideOutput('{"steps": ["a", "b", "c"]}');
assert.ok(!r.ok && /at most 2/.test(r.error), "3 steps must fail");
r = parseDecideOutput('{"steps": []}');
assert.ok(!r.ok, "empty steps must fail");
r = parseDecideOutput('{"steps": [42]}');
assert.ok(!r.ok);
r = parseDecideOutput('{"steps": ["a"], "subgoals": {"add": [1]}}');
assert.ok(!r.ok && /subgoals.add/.test(r.error));

// --- decide: none
r = parseDecideOutput("当前有 open step，无需动作。\n{}");
assert.ok(r.ok && r.value.kind === "none");
r = parseDecideOutput('{"foo": 1}');
assert.ok(!r.ok && /unknown decide payload keys/.test(r.error));

// --- decide: garbage
assert.ok(!parseDecideOutput("纯文本，没有 JSON").ok);
assert.ok(!parseDecideOutput("").ok);
assert.ok(!parseDecideOutput("[1,2,3]").ok);

// --- execute: accepted
r = parseExecuteOutput(
 '探索完成。\n{"accepted": true, "data": {"description": "zip 未加密", "findings": [{"title": "t", "evidence": "e"}]}}',
);
assert.ok(r.ok && r.value.kind === "accepted");
if (r.ok && r.value.kind === "accepted") {
 assert.equal(r.value.description, "zip 未加密");
 assert.deepEqual(r.value.findings, [{ title: "t", evidence: "e" }]);
}
r = parseExecuteOutput('{"accepted": true, "data": {"description": "d"}}');
assert.ok(r.ok && r.value.kind === "accepted" && r.value.findings.length === 0);

// --- execute: rejected
r = parseExecuteOutput('{"accepted": false, "reason": "policy_refusal"}');
assert.ok(
 r.ok && r.value.kind === "rejected" && r.value.reason === "policy_refusal",
);
r = parseExecuteOutput('{"accepted": false}');
assert.ok(!r.ok, "rejected without reason must fail");

// --- execute: missing fields
r = parseExecuteOutput('{"accepted": true}');
assert.ok(!r.ok, "accepted without data must fail");
r = parseExecuteOutput('{"accepted": true, "data": {}}');
assert.ok(!r.ok && /description/.test(r.error));
r = parseExecuteOutput(
 '{"accepted": true, "data": {"description": "", "findings": []}}',
);
assert.ok(!r.ok, "empty description must fail");
r = parseExecuteOutput(
 '{"accepted": true, "data": {"description": "d", "findings": [{"title": "t"}]}}',
);
assert.ok(!r.ok && /finding/.test(r.error));
r = parseExecuteOutput('{"maybe": 1}');
assert.ok(!r.ok, "no accepted key must fail");

console.log("protocol.test: all assertions passed");
