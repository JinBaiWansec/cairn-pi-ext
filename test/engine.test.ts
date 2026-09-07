/**
 * engine.ts 测试（Step 5）— 全 mock Provider，零网络，脱离 NO_MODEL 名单。
 * mock 复用 loop.test.ts 的 makeProvider Step 模式；GraphOps 在 os.tmpdir()
 * 子目录 create，每场景独立目录。
 *
 * T1 快路径闭环 + complete    T2 fail → dropped → PARKED    T3 3 周期强制 Decide
 * T4 预算耗尽                T5 run.json 记账               T6 abort
 * T7 崩溃恢复（in_progress → pending）
 * Run: node test/run.mjs engine
 */
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  StopReason,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import type { CairnConfig } from "../src/config.js";
import { GraphOps } from "../src/graphops.js";
import type { FGSGraph } from "../src/graph.js";
import { CairnEngine, type RunMeta } from "../src/engine.js";
import type { LoopProvider } from "../src/loop.js";

// ── mock 基础设施（loop.test.ts 模式）───────────────────────────────────────

type Step =
  | { kind: "text"; text: string; usageInput?: number }
  | { kind: "tool"; calls: { name: string; args?: Record<string, unknown> }[]; usageInput?: number }
  | { kind: "slow"; ms: number; text: string };

const mockModel = {
  id: "mock",
  name: "Mock",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://mock.local",
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
} as unknown as Model<any>;

const usage = (input: number): Usage => ({
  input,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistantMsg = (
  content: AssistantMessage["content"],
  input: number,
  stopReason: StopReason = "stop",
  errorMessage?: string,
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "mock",
  model: "mock-model",
  usage: usage(input),
  stopReason,
  ...(errorMessage ? { errorMessage } : {}),
  timestamp: Date.now(),
});

const textContent = (t: string) => ({ type: "text" as const, text: t });
const toolCallContent = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

function makeProvider(steps: Step[]): LoopProvider {
  let call = 0;
  return {
    streamSimple(_model, _context, options) {
      const step = steps[Math.min(call, steps.length - 1)];
      call++;
      const stream: AssistantMessageEventStream = createAssistantMessageEventStream();
      void (async () => {
        try {
          if (step.kind === "slow") {
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, step.ms);
              options?.signal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(t);
                  resolve();
                },
                { once: true },
              );
            });
            if (options?.signal?.aborted) throw new Error("aborted by turn timeout");
            stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: assistantMsg([textContent(step.text)], 0) });
            stream.push({ type: "done", reason: "stop", message: assistantMsg([textContent(step.text)], 100) });
          } else if (step.kind === "text") {
            stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: assistantMsg([textContent(step.text)], 0) });
            stream.push({ type: "done", reason: "stop", message: assistantMsg([textContent(step.text)], step.usageInput ?? 100) });
          } else {
            const calls = step.calls.map((c, i) => toolCallContent(`call-${call}-${i}`, c.name, c.args ?? {}));
            stream.push({ type: "done", reason: "stop", message: assistantMsg(calls, step.usageInput ?? 100) });
          }
        } catch (err) {
          stream.push({
            type: "error",
            reason: "aborted",
            error: assistantMsg([], 0, "aborted", err instanceof Error ? err.message : String(err)),
          });
        } finally {
          stream.end();
        }
      })();
      return stream;
    },
  };
}

const baseCfg: CairnConfig = {
  baseUrl: "http://mock.local",
  apiKey: "k",
  model: "mock",
  decideModel: "",
  contextWindow: 100_000,
  oobIp: "",
  maxTurns: 12,
  activityTimeoutMs: 30_000,
  turnTimeoutMs: 10_000,
  bashTimeoutSec: 5,
  maxExecutes: 60,
};

const addStep = (
  ops: GraphOps,
  id: string,
  text: string,
  priority = 50,
  status: FGSGraph["steps"][number]["status"] = "pending",
  attempts = 0,
): void => {
  ops.applyOp("add_step", "user", (g) => {
    g.steps.push({ id, text, priority, status, attempts });
  });
}

interface Scenario {
  steps: Step[];
  cfg?: CairnConfig;
  pre?: (ops: GraphOps) => void;
  abortAfterMs?: number;
}

const runDirs: string[] = [];

async function runScenario(sc: Scenario): Promise<{
  reason: Awaited<ReturnType<typeof CairnEngine.prototype.run>>;
  runDir: string;
  ops: GraphOps;
  banners: string[];
  logs: string[];
}> {
  const runDir = mkdtempSync(join(tmpdir(), "cairn-engine-"));
  runDirs.push(runDir);
  const ops = GraphOps.create(runDir, "origin", "goal");
  sc.pre?.(ops);
  const banners: string[] = [];
  const logs: string[] = [];
  // 预绑定 ops：测试断言与引擎共享同一实例（engine.run 幂等 load 会另起实例，
  // 预建目录下的文件快照对测试侧是陈旧的）
  const engine = new CairnEngine(
    {
      runDir,
      cfg: sc.cfg ?? baseCfg,
      provider: makeProvider(sc.steps),
      model: mockModel,
      onLog: (l) => logs.push(l),
      onBanner: (b) => banners.push(b),
    },
    ops,
  );
  const p = engine.run("origin", "goal");
  if (sc.abortAfterMs) setTimeout(() => engine.abort(), sc.abortAfterMs);
  const reason = await p;
  return { reason, runDir, ops, banners, logs };
}

const readMeta = (runDir: string): RunMeta =>
  JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunMeta;

const fact = (description: string) => ({
  name: "submit_fact",
  args: { description, evidence: `ev ${description}`, kind: "positive" },
});

const text = (t = "t"): Step => ({ kind: "text", text: t });
/** 活动收尾：tool 轮后的 2 个纯文本轮（契约催促 → stopped）。 */
const tail = (): Step[] => [text(), text()];

try {
  // ── T1：快路径闭环 + complete（验收指标"快路径状态一致性"）──────────────
  {
    const { reason, runDir, ops, logs } = await runScenario({
      steps: [
        { kind: "tool", calls: [
          { name: "add_step", args: { text: "step A", priority: 10 } },
          { name: "add_step", args: { text: "step B", priority: 20 } },
        ]},
        ...tail(),
        { kind: "tool", calls: [fact("A done")] },
        ...tail(),
        { kind: "tool", calls: [fact("B done")] },
        ...tail(),
        { kind: "tool", calls: [{ name: "complete", args: { reason: "both done" } }] },
        ...tail(),
      ],
    });
    assert.equal(reason, "complete", "T1: endReason=complete");
    const g = ops.headGraph();
    assert.equal(g.steps.length, 2, "T1: 两步存在");
    assert.ok(g.steps.every((s) => s.status === "done"), "T1: 全 done 无 in_progress 悬挂");
    const meta = readMeta(runDir);
    assert.equal(meta.budget.decides, 2, "T1: 快路径未触发中间 decide（decides=2）");
    assert.equal(meta.budget.executes, 2);
    assert.equal(meta.endReason, "complete");
    assert.equal(meta.state, "ended");
    assert.ok(logs.some((l) => l.includes("fast_path")), "T1: fast_path 日志");
    console.log("T1 OK fast-path closed loop + complete");
  }

  // ── T2：fail → dropped → PARKED ──────────────────────────────────────────
  {
    const { reason, runDir, ops, banners } = await runScenario({
      steps: [text("no facts here")], // 所有活动纯文本（clamp）
      pre: (ops) => addStep(ops, "s-1", "will fail"),
    });
    assert.equal(reason, "parked", "T2: endReason=parked");
    const s = ops.headGraph().steps[0];
    assert.equal(s.status, "dropped", "T2: attempts>=2 → dropped");
    assert.equal(s.lastOutcome, "loop stopped", "T2: lastOutcome 记录 loop reason");
    assert.ok(banners.some((b) => b.includes("挂起")), "T2: banner 收到挂起文案");
    const meta = readMeta(runDir);
    assert.equal(meta.endReason, "parked");
    assert.equal(meta.state, "parked");
    assert.equal(meta.budget.executes, 2);
    console.log("T2 OK fail -> dropped -> PARKED");
  }

  // ── T3：3 周期强制 Decide（第 3 次 fastPath 后触发，非第 4 次）──────────
  {
    const { reason, runDir, ops } = await runScenario({
      steps: [
        { kind: "tool", calls: [fact("a")] }, ...tail(),
        { kind: "tool", calls: [fact("b")] }, ...tail(),
        { kind: "tool", calls: [fact("c")] }, ...tail(),
        { kind: "tool", calls: [{ name: "complete", args: { reason: "r" } }] },
        ...tail(),
      ],
      pre: (ops) => {
        addStep(ops, "s-1", "a", 10);
        addStep(ops, "s-2", "b", 20);
        addStep(ops, "s-3", "c", 30);
        addStep(ops, "s-4", "d", 40);
      },
    });
    assert.equal(reason, "complete", "T3: endReason=complete");
    const meta = readMeta(runDir);
    assert.equal(meta.budget.executes, 3, "T3: 第 3 次 fastPath 后即 decide（非第 4 次）");
    assert.equal(meta.budget.decides, 1, "T3: 恰好 1 次 decide");
    const g = ops.headGraph();
    assert.equal(g.steps.filter((s) => s.status === "done").length, 3);
    assert.equal(g.steps.find((s) => s.id === "s-4")?.status, "pending", "T3: s-4 未被执行");
    console.log("T3 OK 3-cycle forced Decide");
  }

  // ── T4：预算耗尽 ─────────────────────────────────────────────────────────
  {
    const { reason, runDir, ops } = await runScenario({
      steps: [text("no facts")],
      cfg: { ...baseCfg, maxExecutes: 2 },
      pre: (ops) => addStep(ops, "s-1", "burn budget"),
    });
    assert.equal(reason, "budget", "T4: endReason=budget");
    const meta = readMeta(runDir);
    assert.equal(meta.budget.executes, 2, "T4: run.json budget.executes=2");
    assert.equal(meta.endReason, "budget");
    assert.equal(ops.headGraph().steps[0].status, "dropped");
    console.log("T4 OK budget exhausted");
  }

  // ── T5：run.json 记账（T1 同脚本）────────────────────────────────────────
  {
    const { runDir } = await runScenario({
      steps: [
        { kind: "tool", calls: [
          { name: "add_step", args: { text: "step A", priority: 10 } },
          { name: "add_step", args: { text: "step B", priority: 20 } },
        ]},
        ...tail(),
        { kind: "tool", calls: [fact("A done")] },
        ...tail(),
        { kind: "tool", calls: [fact("B done")] },
        ...tail(),
        { kind: "tool", calls: [{ name: "complete", args: { reason: "both done" } }] },
        ...tail(),
      ],
    });
    const meta = readMeta(runDir);
    // 4 个活动（decide+exec+exec+decide）× lastUsage(input=100, output=10, total=110, cost=0)
    assert.equal(meta.usage.input, 400, "T5: usage 累加 = 各活动 lastUsage 之和");
    assert.equal(meta.usage.output, 40);
    assert.equal(meta.usage.totalTokens, 440);
    assert.equal(meta.usage.costTotal, 0);
    assert.equal(meta.state, "ended");
    assert.equal(meta.endReason, "complete");
    assert.ok(meta.startedAt > 0 && meta.endedAt !== null);
    console.log("T5 OK run.json accounting");
  }

  // ── T6：abort（exec 进行中 slow 步）─────────────────────────────────────
  {
    const { reason, runDir, ops } = await runScenario({
      steps: [{ kind: "slow", ms: 3000, text: "late" }],
      pre: (ops) => addStep(ops, "s-1", "slow step"),
      abortAfterMs: 400,
    });
    assert.equal(reason, "aborted", "T6: endReason=aborted");
    const meta = readMeta(runDir);
    assert.equal(meta.endReason, "aborted", "T6: 终态 run.json endReason");
    assert.equal(meta.state, "ended");
    assert.ok(meta.endedAt !== null);
    // 图里 in_progress 残留由下次 run 的 crashRecovery 消化（T7 覆盖）
    assert.equal(ops.headGraph().steps[0].status, "in_progress", "T6: abort 不回退步状态（恢复语义归下次 run）");
    console.log("T6 OK abort mid-execute");
  }

  // ── T7：崩溃恢复（手工造 in_progress → run 后回 pending 并正常推进）────
  {
    const runDir = mkdtempSync(join(tmpdir(), "cairn-engine-"));
    runDirs.push(runDir);
    const ops = GraphOps.create(runDir, "origin", "goal");
    addStep(ops, "s-1", "crashed mid-flight", 50);
    ops.applyOp("start_step", "user", (g) => {
      const s = g.steps.find((x) => x.id === "s-1");
      if (s) {
        s.status = "in_progress";
        s.attempts = 1;
      }
    });
    const banners: string[] = [];
    const logs: string[] = [];
    const engine = new CairnEngine(
      {
        runDir,
        cfg: baseCfg,
        provider: makeProvider([{ kind: "text", text: "no facts" }]),
        model: mockModel,
        onLog: (l) => logs.push(l),
        onBanner: (b) => banners.push(b),
      },
      ops,
    );
    const reason = await engine.run("origin", "goal");
    // crashRecovery → pending → exec(attempts=2) → dropped → decide → zeroDiff×2 → parked
    assert.equal(reason, "parked", "T7: 恢复后 run 正常推进至 parked");
    assert.ok(
      ops.activeBranch.revisions.some((r) => r.op === "crash_recovery" && r.by === "user"),
      "T7: crash_recovery revision 存在（by=user）",
    );
    assert.ok(logs.some((l) => l.includes("crash recovery")), "T7: 恢复日志");
    const s = ops.headGraph().steps[0];
    assert.equal(s.status, "dropped", "T7: 恢复的步被重放直至 dropped");
    assert.equal(readMeta(runDir).budget.executes, 1, "T7: 重放 1 次 exec");
    console.log("T7 OK crash recovery");
  }

  // ── T8：pause/resume 间隙门 + abort 优先 + currentActivityId + onStatus ──
  {
    const runDir = mkdtempSync(join(tmpdir(), "cairn-engine-"));
    runDirs.push(runDir);
    const ops = GraphOps.create(runDir, "origin", "goal");
    addStep(ops, "s-1", "slow then resume");
    const statusFrames: Array<{ act: string | null }> = [];
    const engine = new CairnEngine(
      {
        runDir,
        cfg: baseCfg,
        provider: makeProvider([
          { kind: "slow", ms: 2000, text: "slow1" }, // exec#1
          ...tail(),
          ...tail(), // decide#1
          { kind: "slow", ms: 4000, text: "slow2" }, // exec#2 拉长，abort 必落在活动内
          ...tail(),
        ]),
        model: mockModel,
      },
      ops,
    );
    engine.onStatus(() => statusFrames.push({ act: engine.currentActivityId }));
    const p = engine.run("origin", "goal");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(engine.running, true, "T8: running getter");
    assert.ok(engine.currentActivityId, "T8: 活动进行中 currentActivityId 非空");
    engine.pause();
    engine.pause(); // 幂等
    assert.equal(statusFrames.length, 2, "T8: 活动开始 + pause 各 1 帧（重复 pause 幂等）");
    await new Promise((r) => setTimeout(r, 2500)); // slow 活动完成后主循环应挂在间隙门
    assert.equal(ops.headGraph().steps[0].attempts, 1, "T8: pause 期间不启动第 2 次 exec");
    assert.equal(engine.currentActivityId, null, "T8: 间隙中无活动");
    engine.resume();
    await new Promise((r) => setTimeout(r, 600)); // 间隙门 300ms 轮询，resume 生效 ≤300ms
    assert.equal(ops.headGraph().steps[0].attempts, 2, "T8: resume 后主循环恢复（第 2 次 exec 启动）");
    engine.abort(); // abort 优先：间隙门含 !aborted 立即醒来
    const reason = await p;
    assert.equal(reason, "aborted", "T8: abort 优先于 pause 门");
    assert.ok(statusFrames.some((f) => f.act === null), "T8: 活动结束帧（act=null）");
    // 未运行引擎上 pause/resume 空操作
    const idle = new CairnEngine({ runDir, cfg: baseCfg }, ops);
    idle.pause();
    idle.resume();
    console.log("T8 OK pause/resume gate + abort priority + onStatus");
  }

  console.log("engine.test: all 8 scenarios passed");
} finally {
  for (const d of runDirs) rmSync(d, { recursive: true, force: true });
}
