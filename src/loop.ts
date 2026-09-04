import { createHash } from "node:crypto";
import { getOverflowPatterns } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  Provider,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ToolResult } from "./tools.js";

// ---------------------------------------------------------------------------
// loop.ts — 自研 agent loop（carin_plan §3.1，Step 4）
//
// 职责边界：
//   - 唯一 Runner：单 turn 流式消费 pi-ai Provider
//   - 双标志独立水位防御（nudgedWindow / nudgedContract，各限一次）
//   - 硬溢出紧急弹出（append-only 的唯一合法破坏点）
//   - 停滞打断器（连续 3 轮工具签名 hash 相同 → 熔断催促）
//   - 不做：图状态机（engine）、工具实现（tools.ts）、日志落盘（transcript，仅 onEvent 外抛）
//
// R7 适配（pi-ai 0.84.4，均已对 dist/types.d.ts 实证）：
//   a. model 为 Model<Api> 对象（非字符串）—— config.getModel(ref)
//   b. StreamOptions 只有 signal，无 timeoutMs —— 每 turn 新建
//      AbortSignal.any([signal, AbortSignal.timeout(turnTimeoutMs)])
//   c. UserMessage 必填 timestamp；ToolResultMessage.content 为 (Text|Image)[]
//   d. toolCall content 类型 "toolCall"，参数字段 arguments
//   e. done 事件无顶层 usage → chunk.message.usage；assistant content 是数组
//   f. 错误双通道：fetch 同步 throw + 流尾 error 事件 —— 两处都走硬溢出救援
//
// 依赖面：node:crypto + @earendil-works/pi-ai（类型）+ tools（仅类型）
// ---------------------------------------------------------------------------

/** 结构最小化的 Provider 抽象 —— 实际 config.getProvider() 的 Provider 满足此形状。 */
export type LoopProvider = Pick<Provider, "streamSimple">;

export type LoopEndReason =
  | "aborted"
  | "timeout"
  | "error"
  | "stream_broken"
  | "stopped"
  | "max_turns_exceeded";

export interface LoopResult {
  reason: LoopEndReason;
  turn: number;
  error?: string;
  /** 最后一次 done 的 usage —— engine 记账给 run.json usage 汇总 */
  lastUsage?: Usage;
}

export type LoopEvent =
  | { type: "prompt"; systemPrompt: string; userPrompt: string; ts: number }
  | { type: "text_delta"; delta: string; turn: number; ts: number }
  | { type: "assistant"; text: string; usage: Usage | null; turn: number; ts: number }
  | { type: "tool_call"; name: string; args: Record<string, unknown>; toolCallId: string; turn: number; ts: number }
  | { type: "tool_result"; name: string; ok: boolean; output: string; spillPath?: string; toolCallId: string; turn: number; ts: number }
  | { type: "error"; error: string; turn: number; ts: number }
  | { type: "end"; reason: LoopEndReason; turn: number; ts: number };

export interface LoopParams {
  provider: LoopProvider;
  /** Model 对象（R7-a）：config.getModel(ref) */
  model: Model<any>;
  systemPrompt: string;
  userPrompt: string;
  /** DECIDE_TOOLS / makeExecuteTools() —— ToolDef 形状与 Tool 同构 */
  tools: Tool[];
  /** tools.makeExecuteTool 返回的 executor（ExecuteTool 形状同构） */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  signal: AbortSignal;
  /** 活动总超时 */
  timeoutMs: number;
  /** 单 turn 超时（R7-b：AbortSignal.any 实现，无轮询定时器） */
  turnTimeoutMs: number;
  /** 最大 turn 数 */
  maxTurns: number;
  /** 模型上下文窗口（软水位基准） */
  contextWindow: number;
  onEvent: (event: LoopEvent) => void;
}

const md5 = (s: string): string => createHash("md5").update(s).digest("hex");

/** 硬溢出判定（R7-f：同步 throw 与流尾 error 事件共享）—— 用 pi-ai 原生溢出模式表。 */
const OVERFLOW_PATTERNS = getOverflowPatterns();
const isHardOverflow = (msg: string): boolean => OVERFLOW_PATTERNS.some((re) => re.test(msg));

const userMsg = (text: string): UserMessage => ({ role: "user", content: text, timestamp: Date.now() });

const toolResultMsg = (toolCallId: string, text: string, isError: boolean): ToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: isError ? "overflow-rescue" : "tool",
  content: [{ type: "text", text }],
  isError,
  timestamp: Date.now(),
});

function classifyFailure(err: unknown, outerSignal: AbortSignal): LoopEndReason {
  // 外层 signal abort → "aborted"；否则 abort/timeout 类错误只能来自 turn 超时信号 → "timeout"
  if (outerSignal.aborted) return "aborted";
  const name = err && typeof err === "object" && "name" in err ? (err as { name?: string }).name : undefined;
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "TimeoutError" || /timeout|abort/i.test(msg)) return "timeout";
  return "error";
}

export async function runAgentLoop(params: LoopParams): Promise<LoopResult> {
  const t0 = Date.now();
  const messages: Message[] = [userMsg(params.userPrompt)];
  const recentCalls: string[] = [];
  let prevUsageInput = 0;
  let lastUsage: Usage | null = null;
  let nudgedWindow = false;
  let nudgedContract = false;
  let turn = 0;

  const ts = () => Date.now();
  const emit = (event: LoopEvent): void => params.onEvent(event);

  const end = (reason: LoopEndReason, error?: string): LoopResult => {
    emit({ type: "end", reason, turn, ts: ts() });
    return { reason, turn, ...(error ? { error } : {}), ...(lastUsage ? { lastUsage } : {}) };
  };

  /** 硬溢出紧急弹出 —— append-only 的唯一合法破坏点（一次性，消费 nudgedWindow）。 */
  const rescueOverflow = (): void => {
    nudgedWindow = true;
    messages.pop(); // 弹出最后一条（通常是 tool_result）
    messages.push(toolResultMsg("overflow-rescue", "（已截断：上下文溢出，此工具结果被丢弃）", true));
    messages.push(userMsg("上下文已溢出，最后一条工具结果被丢弃。请立即用 submit_fact（kind=fact）提交关键事实，下一轮只依赖图投影决策。"));
  };

  emit({ type: "prompt", systemPrompt: params.systemPrompt, userPrompt: params.userPrompt, ts: ts() });

  for (;;) {
    turn++;
    if (params.signal.aborted) return end("aborted");
    if (Date.now() - t0 > params.timeoutMs) return end("timeout");
    if (turn > params.maxTurns) return end("max_turns_exceeded");

    // ── 软水位（90%）：注入警告并 continue —— 绝不能 break（plan ★）────────────
    if (prevUsageInput > 0.9 * params.contextWindow && !nudgedWindow) {
      nudgedWindow = true;
      messages.push(userMsg("上下文窗口已超过 90%。请立即压缩上下文：用 submit_fact（kind=fact）把关键事实提交入图，下一轮只依赖图投影决策，不要再读大文件。"));
      continue;
    }

    // ── 单 turn 流（R7-b：AbortSignal.any 实现 turn 超时）─────────────────────
    const turnSignal = AbortSignal.any([params.signal, AbortSignal.timeout(params.turnTimeoutMs)]);
    let stream;
    try {
      const context: Context = { systemPrompt: params.systemPrompt, messages, tools: params.tools };
      stream = params.provider.streamSimple(params.model, context, { signal: turnSignal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // R7-f：fetch 同步 throw 通道
      if (isHardOverflow(msg) && !nudgedWindow && messages.length > 2) {
        emit({ type: "error", error: msg, turn, ts: ts() });
        rescueOverflow();
        continue;
      }
      emit({ type: "error", error: msg, turn, ts: ts() });
      return end(classifyFailure(err, params.signal), msg);
    }

    // ── 事件消费 ──────────────────────────────────────────────────────────────
    let assistantMessage: AssistantMessage | null = null;
    let streamError: string | null = null;
    let streamErrObj: unknown = null;
    try {
      for await (const chunk of stream) {
        if (chunk.type === "text_delta") {
          emit({ type: "text_delta", delta: chunk.delta, turn, ts: ts() });
        } else if (chunk.type === "done") {
          assistantMessage = chunk.message; // R7-e：usage 在 message 上
        } else if (chunk.type === "error") {
          // R7-f：流尾 error 事件通道 —— 消息在 chunk.error 上（stopReason="error"|"aborted"）
          streamError = chunk.error.errorMessage ?? chunk.error.stopReason ?? "stream error";
          streamErrObj = new Error(streamError);
        }
      }
    } catch (err) {
      streamError = err instanceof Error ? err.message : String(err);
      streamErrObj = err;
    }

    if (streamError !== null) {
      if (isHardOverflow(streamError) && !nudgedWindow && messages.length > 2) {
        emit({ type: "error", error: streamError, turn, ts: ts() });
        rescueOverflow();
        continue;
      }
      emit({ type: "error", error: streamError, turn, ts: ts() });
      return end(classifyFailure(streamErrObj ?? streamError, params.signal), streamError);
    }
    if (assistantMessage === null) return end("stream_broken");

    // ── assistant 处理（append-only）─────────────────────────────────────────
    const msg = assistantMessage;
    if (msg.usage) {
      lastUsage = msg.usage;
      prevUsageInput = msg.usage.input;
    }
    const text = msg.content
      .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
    emit({ type: "assistant", text, usage: msg.usage ?? null, turn, ts: ts() });
    messages.push(msg);

    // ── 无工具调用 → 契约催促（一次性）→ 否则收尾 ─────────────────────────────
    const toolCalls = msg.content.filter((c): c is ToolCall => c.type === "toolCall");
    if (toolCalls.length === 0) {
      if (!nudgedContract) {
        nudgedContract = true;
        messages.push(userMsg("契约未满足：本轮必须至少调用一次工具（submit_fact / relation / complete）。请继续 loop。"));
        continue;
      }
      return end("stopped");
    }

    // ── 工具执行（R7-d：arguments 字段；事件在消息确认后逐条外抛）────────────
    for (const tc of toolCalls) {
      const args = (tc.arguments ?? {}) as Record<string, unknown>;
      emit({ type: "tool_call", name: tc.name, args, toolCallId: tc.id, turn, ts: ts() });
      let res: ToolResult;
      try {
        res = await params.executeTool(tc.name, args);
      } catch (err) {
        res = { ok: false, output: `工具执行出错：${err instanceof Error ? err.message : String(err)}` };
      }
      recentCalls.push(md5(`${tc.name}:${JSON.stringify(args)}:${res.output}`));
      if (recentCalls.length > 3) recentCalls.shift();
      emit({ type: "tool_result", name: tc.name, ok: res.ok, output: res.output, spillPath: res.spillPath, toolCallId: tc.id, turn, ts: ts() });
      messages.push(toolResultMsg(tc.id, res.output, !res.ok));
    }

    // ── 停滞熔断（连续 3 轮相同签名，一次性，复用 nudgedContract）────────────
    if (recentCalls.length === 3 && recentCalls[0] === recentCalls[1] && recentCalls[1] === recentCalls[2] && !nudgedContract) {
      nudgedContract = true;
      messages.push(userMsg("熔断：已连续 3 轮相同工具调用，判定停滞。请立即提交负事实（kind=deadend）声明该方向已穷尽，或换方向。不要重复同一动作。"));
      continue;
    }
  }
}
