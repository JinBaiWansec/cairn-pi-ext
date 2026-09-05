// types.ts — 后端契约的手写镜像（carin_step6_plan §4 + §11 S27–S29 增补/更正）。
// 逐字段比对基准：
//   FGS*      ← src/graph.ts:427-506（FGSStep/FGSFact/FGSFinding/FGSHint/FGSGraph/FGSRevision/FGSBranch/FGSFile）
//   Transcript← src/transcript.ts:25-38（TranscriptEvent 包装）+ src/loop.ts:42-65（LoopEvent payload）
//   Status    ← src/engine.ts:51,67-87（EndReason + RunMeta）
// ponytail：TranscriptEvent 用扁平可选字段而非判别联合 —— JSONL 直接 JSON.parse 即可，渲染侧按 type 分支。

// ── Graph（src/graph.ts 镜像，S27）──────────────────────────────────────────
export type StepStatus = "pending" | "in_progress" | "done" | "dropped";

export interface FGSStep {
  id: string;
  text: string;
  priority: number;
  status: StepStatus;
  addresses_hint?: string; // S27（Step 5 快路径闭环）
  attempts: number; // S27（S8 重试徽章）
  lastOutcome?: string; // S27（dropped 节点缩略）
}

export interface FGSFact {
  id: string;
  description: string;
  /** ≤80 字精简摘要；完整证据在 spill_path。 */
  evidence_summary: string;
  /** notes/facts/<id>.txt */
  spill_path: string;
  superseded?: { by_fact_id?: string; reason: string };
  /** 引用了已作废 Fact 的 id 列表（弱关联，不拦截只标记）。 */
  weak_refs?: string[]; // S27
  quality?: "normal" | "degraded";
  /** positive = 触发 done_step 快路径；negative = 负事实/阻断。 */
  kind?: "positive" | "negative"; // S27
  created_at: number;
  created_by: "model" | "user"; // S27
}

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface FGSFinding {
  id: string;
  title: string;
  severity: FindingSeverity;
  // S27：非裸 evidence —— 后端用 data + evidence_path
  data: Record<string, unknown>;
  evidence_path: string;
}

export interface FGSHint {
  id: string;
  text: string;
  status: "active" | "addressed" | "rejected";
  rejection_reason?: string;
}

export interface FGSGraph {
  origin: string;
  goal: string;
  subgoals: Array<{ id: string; text: string }>;
  steps: FGSStep[];
  facts: FGSFact[];
  findings: FGSFinding[];
  hints: FGSHint[];
}

export interface FGSRevision {
  /** rev-<n>，全局单调递增。 */
  id: string;
  parent: string | null;
  op: string;
  by: "model" | "user";
  ts: number;
  note?: string;
  /** 该 revision 的完整图快照（不可变）。 */
  graph: FGSGraph;
}

export interface FGSBranch {
  name: string;
  forkFromRevision?: string;
  forkFromBranch?: string; // S27 更正（§4 的 forkFromRevision 单一字段为误；src/graph.ts:495）
  head: string;
  revisions: FGSRevision[];
}

// S27：/api/graph 根 schema = 完整 fgs.json（Branch 下拉读 activeBranch）
export interface FGSFile {
  version: 2;
  revCounter: number;
  branches: FGSBranch[];
  activeBranch: string;
}

// ── Transcript（transcript.ts + loop.ts 镜像）───────────────────────────────
export type ActivityKind = "decide" | "execute";

// S11：两套结束原因各自镜像
export type EndReason = "complete" | "aborted" | "budget" | "parked" | "error"; // run 级（engine.ts:51）
export type LoopEndReason =
  | "aborted"
  | "timeout"
  | "error"
  | "stream_broken"
  | "stopped"
  | "max_turns_exceeded"; // 活动级（loop.ts:42-48）

// ← pi-ai Usage（@earendil-works/pi-ai dist/types.d.ts:265；assistant 事件 usage 字段透传）
export interface UsageEvent {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  [key: string]: unknown; // 供应商差异：cacheWrite1h/reasoning 等
}

export interface TranscriptEvent {
  ts: number;
  /** "act-001" */
  activityId: string;
  kind: ActivityKind;
  stepId?: string;
  type: "prompt" | "text_delta" | "assistant" | "tool_call" | "tool_result" | "error" | "end";
  // prompt（S28：首行可折叠展示，默认收起）
  systemPrompt?: string;
  userPrompt?: string;
  // text_delta
  delta?: string;
  // assistant
  text?: string;
  usage?: UsageEvent | null;
  // tool_call / tool_result
  name?: string;
  args?: Record<string, unknown>;
  toolCallId?: string; // S28 camelCase 显式确认
  ok?: boolean;
  output?: string;
  spillPath?: string;
  // error（S28：事件体 { error: string }）
  error?: string;
  // end（活动级 LoopEndReason，S11 收束行）
  reason?: LoopEndReason;
  // 共享
  turn?: number;
}

// ── /api/status（S29：源自 RunMeta + engine 活动上下文）─────────────────────
export interface Status {
  running: boolean;
  state: "running" | "parked" | "ended"; // RunMeta.state
  endReason: EndReason | null; // RunMeta.endReason
  activeStepId?: string;
  activeBranch?: string;
  rev?: string;
  // RunMeta.budget（maxExecutes/maxDecides 来自 RunMeta.config，S4 逼近上限琥珀）
  budget: {
    executes: number;
    decides: number;
    maxExecutes?: number;
    maxDecides?: number;
  };
  usage: { input: number; output: number; totalTokens: number; costTotal: number }; // RunMeta.usage
  elapsedMs: number;
  currentActivityId?: string;
  env?: "mock"; // S10：mock 专属字段，真实端点无
}

// ── 其余端点 ────────────────────────────────────────────────────────────────
export interface TranscriptPage {
  events: TranscriptEvent[];
  nextOffset: number;
}

export interface FileContent {
  content: string;
  size: number;
}

export type SseEvent =
  | { type: "transcript"; event: TranscriptEvent }
  | { type: "graph"; rev: string; branch: string }
  | { type: "status"; status: Status };
