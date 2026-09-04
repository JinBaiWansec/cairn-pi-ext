/**
 * transcript.ts 测试（Step 4）— 本地临时目录，无网络。
 * Run: node test/run.mjs transcript
 */
import assert from "node:assert";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript, __resetTranscriptStateForTest, onTranscriptEvent, ringTail } from "../src/transcript.js";
import type { TranscriptEvent } from "../src/transcript.js";

const dir = mkdtempSync(join(tmpdir(), "cairn-transcript-"));
// 每场景独立子目录，编号断言互不干扰
const sub = (name: string): string => join(dir, name);
try {
  __resetTranscriptStateForTest();

  // ── 场景 1：顺序追加 ──────────────────────────────────────────────────────
  {
    const t = Transcript.open(sub("s1"), "decide");
    t.append({ type: "prompt", turn: 1 });
    t.append({ type: "assistant", turn: 1, text: "a" });
    t.append({ type: "end", turn: 2 });
    const lines = readFileSync(t.path, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 3);
    const parsed = lines.map((l) => JSON.parse(l) as TranscriptEvent);
    assert.deepEqual(parsed.map((e) => e.type), ["prompt", "assistant", "end"]);
    assert.equal(parsed[0].activityId, t.activityId);
    assert.equal(parsed[0].kind, "decide");
    assert.ok(parsed[0].ts > 0);
    // tail 与文件同序
    assert.deepEqual(t.tail(3).map((e) => e.type), ["prompt", "assistant", "end"]);
    t.close();
  }

  // ── 场景 2：编号自增（含“重启”续号）──────────────────────────────────────
  {
    const t1 = Transcript.open(sub("s2"), "decide");
    const t2 = Transcript.open(sub("s2"), "execute", "step-1");
    const t3 = Transcript.open(sub("s2"), "decide");
    assert.equal(t1.activityId, "act-001");
    assert.equal(t2.activityId, "act-002");
    assert.equal(t3.activityId, "act-003");
    assert.ok(t2.path.endsWith("act-002-execute-step-1.jsonl"), "stepId 入文件名");
    // “重启”：close 全部 + 清空模块缓存（目录保留）→ 续号 act-004
    for (const t of [t1, t2, t3]) t.close();
    __resetTranscriptStateForTest();
    const t4 = Transcript.open(sub("s2"), "decide");
    assert.equal(t4.activityId, "act-004", "崩溃重启自动续号");
    t4.close();
  }

  // ── 场景 3：幂等（同 id 重复 open 同实例，不重复建文件）─────────────────
  {
    const a = Transcript.open(sub("s3"), "decide", undefined, "act-005");
    const b = Transcript.open(sub("s3"), "decide", undefined, "act-005");
    assert.equal(a, b, "同 (runDir, activityId) 返回同一实例");
    a.append({ type: "x" });
    const lines = readFileSync(a.path, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 1, "不重复建文件/重复写");
    assert.ok(readdirSync(join(sub("s3"), "transcripts")).filter((f) => f.includes("act-005")).length === 1);
    a.close();
  }

  // ── 场景 4：ring 淘汰（5001 条 → ringTail(10) 为最新 10 条）─────────────
  {
    __resetTranscriptStateForTest();
    const t = Transcript.open(sub("s4"), "execute", "s9", "act-900");
    for (let i = 1; i <= 5001; i++) t.append({ type: "tick", n: i });
    const tail10 = ringTail(10);
    assert.equal(tail10.length, 10);
    assert.equal(tail10[0]["n"], 4992);
    assert.equal(tail10[9]["n"], 5001);
    // 文件行数不受 ring 淘汰影响（5001 行全落盘）
    const lineCount = readFileSync(t.path, "utf8").trimEnd().split("\n").length;
    assert.equal(lineCount, 5001);
    t.close();
  }

  // ── 场景 5：listener 与文件同序 ──────────────────────────────────────────
  {
    __resetTranscriptStateForTest();
    const seen: TranscriptEvent[] = [];
    onTranscriptEvent((ev) => seen.push(ev));
    const t = Transcript.open(sub("s5"), "decide", undefined, "act-901");
    t.append({ type: "a" });
    t.append({ type: "b" });
    assert.deepEqual(seen.map((e) => e.type), ["a", "b"]);
    assert.equal(seen[0].activityId, "act-901");
    const fileTypes = readFileSync(t.path, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => (JSON.parse(l) as TranscriptEvent).type);
    assert.deepEqual(seen.map((e) => e.type), fileTypes, "listener 与文件同序");
    t.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
