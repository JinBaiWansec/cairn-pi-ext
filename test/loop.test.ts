/**
 * loop.ts 测试（Step 4）— mock Provider，零网络。
 * Run: node test/run.mjs loop
 */
import assert from "node:assert";
import { runAgentLoop } from "../src/loop.js";
import type { LoopEvent, LoopProvider, LoopResult } from "../src/loop.js";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  Model,
  StopReason,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import type { ToolResult } from "../src/tools.js";

// ── mock 基础设施 ────────────────────────────────────────────────────────────

type Step =
  | { kind: "text"; text: string; usageInput?: number }
  | { kind: "tool"; calls: { name: string; args?: Record<string, unknown> }[]; usageInput?: number }
  | { kind: "error"; message: string; via: "throw" | "event" }
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

function usage(input: number): Usage {
  return {
    input,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantMsg(
  content: AssistantMessage["content"],
  input: number,
  stopReason: StopReason = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "mock-model",
    usage: usage(input),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

const textContent = (t: string) => ({ type: "text" as const, text: t });
const toolCallContent = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

interface MockedProvider {
  provider: LoopProvider;
  /** 每次 streamSimple 时的 messages 快照（append-only / pop 验证用） */
  turns: Message[][];
}

function makeProvider(steps: Step[]): MockedProvider {
  let call = 0;
  const turns: Message[][] = [];
  const provider: LoopProvider = {
    streamSimple(_model, context, options) {
      const step = steps[Math.min(call, steps.length - 1)];
      call++;
      turns.push([...context.messages]);
      // R7-f 同步 throw 通道（fetch 失败）
      if (step.kind === "error" && step.via === "throw") throw new Error(step.message);
      const stream: AssistantMessageEventStream = createAssistantMessageEventStream();
      void (async () => {
        try {
          if (step.kind === "error") {
            // R7-f 流尾 error 事件通道
            stream.push({ type: "error", reason: "error", error: assistantMsg([], 0, "error", step.message) });
          } else if (step.kind === "slow") {
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, step.ms);
              options?.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
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
  return { provider, turns };
}

interface RunOptions {
  maxTurns?: number;
  contextWindow?: number;
  turnTimeoutMs?: number;
  timeoutMs?: number;
  executeTool?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  controller?: AbortController;
}

async function run(steps: Step[], opts: RunOptions = {}) {
  const { provider, turns } = makeProvider(steps);
  const events: LoopEvent[] = [];
  let toolCallCount = 0;
  const controller = opts.controller ?? new AbortController();
  const res: LoopResult = await runAgentLoop({
    provider,
    model: mockModel,
    systemPrompt: "sys",
    userPrompt: "task",
    tools: [],
    executeTool:
      opts.executeTool ??
      (async (name: string, args: Record<string, unknown>) => ({
        ok: true,
        output: `out-${toolCallCount++}:${name}:${JSON.stringify(args)}`,
      })),
    signal: controller.signal,
    timeoutMs: opts.timeoutMs ?? 60_000,
    turnTimeoutMs: opts.turnTimeoutMs ?? 10_000,
    maxTurns: opts.maxTurns ?? 12,
    contextWindow: opts.contextWindow ?? 100_000,
    onEvent: (e) => events.push(e),
  });
  return { res, events, turns };
}

const allMessages = (turns: Message[][]): Message[] => turns.flat();
// 末轮快照即全量（append-only）—— “仅一次”类断言只在末轮快照上计数，避免跨快照重复
const finalMsgs = (turns: Message[][]): Message[] => turns[turns.length - 1] ?? [];
const userTexts = (msgs: Message[]): string[] =>
  msgs.filter((m) => m.role === "user").map((m) => (m as { content: string }).content);

// ── 场景 1：正常收尾 ─────────────────────────────────────────────────────────

{
  const { res, events, turns } = await run([
    { kind: "tool", calls: [{ name: "submit_fact", args: { statement: "s1" } }] },
    { kind: "text", text: "done" },
  ]);
  assert.equal(res.reason, "stopped");
  assert.ok(res.lastUsage, "lastUsage 记账给 engine");
  assert.equal(res.lastUsage.input, 100);
  // 事件序列：prompt → assistant(tool 轮) → tool_call → tool_result → assistant ×2 → end
  assert.equal(events[0].type, "prompt");
  assert.equal(events[1].type, "assistant");
  assert.equal(events[2].type, "tool_call");
  assert.equal(events[3].type, "tool_result");
  const assistants = events.filter((e) => e.type === "assistant");
  assert.equal(assistants.length, 3); // tool 轮 + 纯文本轮 + 契约催促后收尾轮
  assert.equal(events[events.length - 1].type, "end");
  // append-only 验证：末轮快照条数 = 1(user) + 2(asst) + 1(tr) + 1(契约) = 5
  assert.equal(turns[turns.length - 1].length, 5);
}

// ── 场景 2：契约催促（一次性）──────────────────────────────────────────────

{
  const { res, turns } = await run([
    { kind: "text", text: "hi" },
    { kind: "text", text: "hi again" },
  ]);
  assert.equal(res.reason, "stopped");
  assert.equal(userTexts(finalMsgs(turns)).filter((t) => t.includes("契约未满足")).length, 1);
}

// ── 场景 3：停滞熔断（3 轮相同签名，仅一次）────────────────────────────────

{
  const constantTool = async (): Promise<ToolResult> => ({ ok: true, output: "same" });
  const { res, turns } = await run(
    [
      { kind: "tool", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "tool", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "tool", calls: [{ name: "bash", args: { command: "ls" } }] },
      { kind: "text", text: "give up" },
    ],
    { executeTool: constantTool },
  );
  assert.equal(res.reason, "stopped");
  assert.equal(userTexts(finalMsgs(turns)).filter((t) => t.includes("熔断")).length, 1);
}

// ── 场景 4：软水位（90% 警告一次性）────────────────────────────────────────

{
  const { res, turns } = await run(
    [
      { kind: "tool", calls: [{ name: "submit_fact" }], usageInput: 95_000 },
      { kind: "text", text: "ok" },
      { kind: "text", text: "ok2" },
    ],
    { contextWindow: 100_000 },
  );
  assert.equal(res.reason, "stopped");
  assert.equal(userTexts(finalMsgs(turns)).filter((t) => t.includes("90%")).length, 1);
}

// ── 场景 5：硬溢出救援（同步 throw 通道）───────────────────────────────────

{
  const { res, events, turns } = await run([
    { kind: "tool", calls: [{ name: "read", args: { path: "big.txt" } }] },
    { kind: "error", message: "context length exceeded", via: "throw" },
    { kind: "text", text: "recovered" },
  ]);
  assert.equal(res.reason, "stopped");
  assert.equal(userTexts(finalMsgs(turns)).filter((t) => t.includes("上下文已溢出")).length, 1, "紧急消息仅一次");
  // pop 验证：第三轮流快照中原始 toolResult 被救援 toolResult 替换
  const rescue = (turns[2] ?? []).find(
    (m) => m.role === "toolResult" && (m as { toolCallId: string }).toolCallId === "overflow-rescue",
  );
  assert.ok(rescue, "救援 toolResult 存在");
  assert.equal((rescue as { isError: boolean }).isError, true);
  assert.ok(events.some((e) => e.type === "error" && e.error.includes("context length exceeded")), "error 事件外抛");
}

// ── 场景 6：流尾 error 事件通道（R7-f）─────────────────────────────────────

{
  const { res, turns } = await run([
    { kind: "tool", calls: [{ name: "read", args: { path: "big.txt" } }] },
    { kind: "error", message: "prompt too long; exceeded max context length", via: "event" },
    { kind: "text", text: "recovered" },
  ]);
  assert.equal(res.reason, "stopped");
  assert.equal(userTexts(finalMsgs(turns)).filter((t) => t.includes("上下文已溢出")).length, 1);
}

// ── 场景 7：非溢出错误 → end error（不救援）───────────────────────────────

{
  const { res } = await run([
    { kind: "tool", calls: [{ name: "read" }] },
    { kind: "error", message: "network down", via: "throw" },
  ]);
  assert.equal(res.reason, "error");
  assert.ok(res.error?.includes("network down"));
}

// ── 场景 8：maxTurns 超限 ───────────────────────────────────────────────────

{
  const { res } = await run([{ kind: "tool", calls: [{ name: "bash", args: { command: "ls" } }] }], { maxTurns: 3 });
  assert.equal(res.reason, "max_turns_exceeded");
  assert.equal(res.turn, 4);
}

// ── 场景 9：signal 已 abort → end aborted（不进 turn）─────────────────────

{
  const controller = new AbortController();
  controller.abort();
  const { res } = await run([{ kind: "tool", calls: [{ name: "bash" }] }], { controller });
  assert.equal(res.reason, "aborted");
}

// ── 场景 10：工具 isError → ToolResultMessage.isError ─────────────────────

{
  const failTool = async (name: string): Promise<ToolResult> =>
    name === "fail" ? { ok: false, output: "boom" } : { ok: true, output: "fine" };
  const { turns } = await run(
    [
      { kind: "tool", calls: [{ name: "fail" }, { name: "ok_tool" }] },
      { kind: "text", text: "end" },
    ],
    { executeTool: failTool },
  );
  const trs = finalMsgs(turns).filter((m) => m.role === "toolResult") as {
    toolName: string;
    isError: boolean;
    content: { text: string }[];
  }[];
  assert.equal(trs.length, 2);
  assert.equal(trs[0].isError, true);
  assert.equal(trs[0].content[0].text, "boom");
  assert.equal(trs[1].isError, false);
}

// ── 场景 11：单 turn 超时（R7-b AbortSignal.any）→ end timeout ────────────

{
  const { res } = await run([{ kind: "slow", ms: 300, text: "late" }], { turnTimeoutMs: 50 });
  assert.equal(res.reason, "timeout");
}
