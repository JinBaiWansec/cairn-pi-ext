/**
 * engine.ts — Dual-Loop 编排器（carin_plan §3.2/§2.1，Step 5）。
 *
 *   状态机：budget 检查 → pickPending →（无 pending：Decide / zeroDiff≥2 → PARKED）
 *          → start_step(attempts+1) → Execute →
 *             positive fact → done_step_fast_path（连续 <3 次跳过 Decide）
 *             无事实 → fail_step（attempts≥2 → dropped）+ 连续 3 次 banner（D3）
 *          → 收尾 Decide（complete 检测）
 *   结束：complete / aborted / budget / parked / error
 *
 * 依赖面：node:fs + graph/graphops/tools/loop/transcript/prompts/config ——
 *   **无外部 agent 框架依赖**（G1）；工具调用即状态变更（G3），无文本协议解析。
 *
 * run.json（§2.1 审计记账）：<runDir>/run.json，原子写（tmp+rename）；
 *   每个活动结束 + 状态变更时重写；崩溃恢复 load 累加（executes/usage 保留）。
 *   双写顺序（R4）：先 applyOp（fgs）后 run.json —— 崩溃时 run.json 可落后
 *   1 活动（usage 少计可接受，fgs 是真理源）。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { FGSStep } from "./graph.js";
import {
  extractWorldResidue,
  projectDecideSkeleton,
  projectExecuteSubgraph,
  type FGSGraph,
} from "./graph.js";
import { GraphOps } from "./graphops.js";
import type { CairnConfig } from "./config.js";
import { getModel, getProvider } from "./config.js";
import type { LoopEndReason, LoopProvider } from "./loop.js";
import { runAgentLoop } from "./loop.js";
import {
  DECIDE_TOOLS,
  DEFAULT_FINDING_SCHEMA,
  makeExecuteTool,
  makeExecuteTools,
  type ToolDef,
} from "./tools.js";
import { decidePrompt, executePrompt, renderAgentsMd } from "./prompts.js";
import { Transcript } from "./transcript.js";

export type EndReason = "complete" | "aborted" | "budget" | "parked" | "error";

export interface EngineOptions {
  /** run 目录（fgs.json / run.json / transcripts/ / notes/ 均在此；替代旧 workspace 语义） */
  runDir: string;
  /** config.ts loadConfig() 的结果 */
  cfg: CairnConfig;
  onLog?: (line: string) => void;
  onBanner?: (text: string) => void;
  onWidget?: (lines: string[]) => void;
  /** 测试注入：覆盖 provider（默认 config.getProvider()） */
  provider?: LoopProvider;
  /** 测试注入：覆盖模型（默认按 decideModel/execute 解析 config.getModel） */
  model?: Model<any>;
}

/** run.json schema（plan §2.1 "Budget/Token Usage 审计记账"）。 */
export interface RunMeta {
  version: 1;
  origin: string;
  goal: string;
  config: {
    model: string;
    decideModel: string;
    contextWindow: number;
    maxTurns: number;
    activityTimeoutMs: number;
    turnTimeoutMs: number;
    maxExecutes: number;
  };
  budget: { executes: number; decides: number };
  usage: { input: number; output: number; totalTokens: number; costTotal: number };
  state: "running" | "parked" | "ended";
  endReason: EndReason | null;
  startedAt: number;
  endedAt: number | null;
}

const runFile = (runDir: string): string => join(runDir, "run.json");

interface ActivityResult {
  reason: LoopEndReason;
  error?: string;
  /** decide 用：head 是否推进（任何 applyOp 都推进 head） */
  changed: boolean;
  /** 任何活动：新 revision 中 op==="complete" 的 note */
  completedReason?: string;
  /** execute 用：活动前记 facts.length，活动后取增量 */
  newFacts: import("./graph.js").FGSFact[];
  lastUsage?: Usage;
}

export class CairnEngine {
  /** 进程级单例（index.ts 依赖） */
  static running: CairnEngine | null = null;

  state: "running" | "parked" | "ended" = "running";

  private ops: GraphOps | null = null;
  private meta: RunMeta | null = null;
  private abortCtrl = new AbortController();
  private zeroDiff = 0;
  private noFactStreak = 0;
  private fastPaths = 0;

  constructor(
    private opts: EngineOptions,
    /** 可选预绑定（startEngine 已 create-or-load）；缺省由 run() 幂等补建 */
    ops?: GraphOps,
  ) {
    this.ops = ops ?? null;
  }

  abort(): void {
    this.abortCtrl.abort();
    this.log("abort requested");
  }

  log(line: string): void {
    this.opts.onLog?.(`[cairn] ${line}`);
  }

  banner(text: string): void {
    this.log(text);
    this.opts.onBanner?.(text);
  }

  /** Idempotent：create-or-load fgs.json + run.json，然后跑主循环。 */
  async run(origin: string, goal: string): Promise<EndReason> {
    if (CairnEngine.running)
      throw new Error("a cairn engine is already running");
    CairnEngine.running = this;
    let reason: EndReason = "error";
    try {
      if (!this.ops) {
        const resumed = GraphOps.exists(this.opts.runDir);
        this.ops = resumed
          ? GraphOps.load(this.opts.runDir)
          : GraphOps.create(this.opts.runDir, origin, goal);
      }
      this.meta = this.loadOrCreateMeta(origin, goal);
      this.persistRun();
      this.log(
        `start runDir=${this.opts.runDir} goal="${goal.slice(0, 60)}"`,
      );
      this.crashRecovery();
      reason = await this.mainLoop();
    } finally {
      CairnEngine.running = null;
      this.finish(reason);
    }
    return reason;
  }

  // ---------------------------------------------------------------- main loop（plan §3.3 逐条 + D1-D4）

  private async mainLoop(): Promise<EndReason> {
    const { cfg } = this.opts;
    const ops = this.ops!;
    const meta = this.meta!;
    while (this.state === "running") {
      if (meta.budget.executes >= cfg.maxExecutes) {
        this.log(`budget exhausted (${meta.budget.executes}/${cfg.maxExecutes})`);
        return "budget";
      }
      const head = ops.headGraph();
      const nextStep = this.pickPending(head);
      if (!nextStep) {
        const res = await this.runActivity("decide");
        if (res.reason === "aborted") return "aborted";
        if (res.completedReason !== undefined) {
          this.log(`complete: ${res.completedReason}`);
          return "complete";
        }
        if (res.changed) {
          this.zeroDiff = 0;
        } else {
          this.zeroDiff += 1;
          if (this.zeroDiff >= 2) {
            this.banner("队列为空且 Decide 连续 2 轮无动作，进入挂起等待。请人工下发 Hint / Step。");
            this.state = "parked";
            this.persistRun();
            return "parked";
          }
        }
        continue;
      }
      // ── Execute ──
      ops.applyOp("start_step", "model", (draft) => {
        const s = draft.steps.find((x) => x.id === nextStep.id);
        if (s) {
          s.status = "in_progress";
          s.attempts += 1;
        }
      });
      meta.budget.executes += 1;
      this.persistRun();
      this.log(`execute ${nextStep.id} (attempt ${nextStep.attempts + 1}): ${nextStep.text.slice(0, 60)}`);
      const res = await this.runActivity("execute", nextStep);
      if (res.reason === "aborted") return "aborted";
      if (res.newFacts.some((f) => f.kind === "positive")) {
        // ★ 快路径核心修复：positive fact → 自动 done_step，连续 <3 次跳过 Decide
        ops.applyOp("done_step_fast_path", "model", (draft) => {
          const s = draft.steps.find((x) => x.id === nextStep.id);
          if (s) s.status = "done";
        });
        this.fastPaths += 1;
        const hasPending = ops
          .headGraph() // D2：重读 head（plan 伪代码读陈旧快照是 bug）
          .steps.some((s) => s.status === "pending");
        if (hasPending && this.fastPaths < 3) {
          this.log(`fast_path: ${nextStep.id} done (positive fact), streak ${this.fastPaths}`);
          continue;
        }
      }
      this.fastPaths = 0;
      if (res.newFacts.length === 0) {
        this.noFactStreak += 1;
        ops.applyOp("fail_step", "model", (draft) => {
          const s = draft.steps.find((x) => x.id === nextStep.id);
          if (s) {
            s.status = s.attempts >= 2 ? "dropped" : "pending";
            s.lastOutcome = `loop ${res.reason}${res.error ? `: ${res.error}` : ""}`;
          }
        });
        if (this.noFactStreak >= 3) {
          // D3：Stuck 软熔断（banner 提示，不终止；硬终止由 dropped/PARKED/预算兜底）
          this.banner(`连续 ${this.noFactStreak} 次 Execute 未提交事实，疑似停滞`);
          this.noFactStreak = 0;
        }
      } else {
        this.noFactStreak = 0;
      }
      const dec = await this.runActivity("decide");
      if (dec.reason === "aborted") return "aborted";
      if (dec.completedReason !== undefined) {
        this.log(`complete: ${dec.completedReason}`);
        return "complete";
      }
    }
    return this.state === "parked" ? "parked" : "aborted";
  }

  /** D1：priority 升序 + 编号升序取第一个 pending（纪律 2 "通过 priority 表达时序"的自洽实现）。 */
  private pickPending(head: FGSGraph): FGSStep | null {
    const num = (id: string): number => Number(id.split("-")[1]) || 0;
    return (
      head.steps
        .filter((s) => s.status === "pending")
        .sort((a, b) => a.priority - b.priority || num(a.id) - num(b.id))[0] ?? null
    );
  }

  /** 崩溃恢复：in_progress 步回 pending（applyOp "crash_recovery", by:"user"）。 */
  private crashRecovery(): void {
    const ops = this.ops!;
    const stuck = ops.headGraph().steps.filter((s) => s.status === "in_progress");
    if (!stuck.length) return;
    ops.applyOp("crash_recovery", "user", (draft) => {
      for (const s of stuck) {
        const t = draft.steps.find((x) => x.id === s.id);
        if (t) t.status = "pending";
      }
    });
    this.log(`crash recovery: ${stuck.map((s) => s.id).join(", ")} in_progress -> pending`);
  }

  // ---------------------------------------------------------------- activities（§3.4：两个活动共用组装）

  private async runActivity(
    kind: "decide" | "execute",
    step?: FGSStep,
  ): Promise<ActivityResult> {
    const { runDir, cfg } = this.opts;
    const ops = this.ops!;
    const meta = this.meta!;
    const t = Transcript.open(runDir, kind, step?.id);
    const beforeRevId = ops.activeBranch.head;
    const beforeFacts = ops.headGraph().facts.length;

    const { systemPrompt, userPrompt } =
      kind === "decide" ? this.decidePrompts() : this.executePrompts(step!);
    const tools: ToolDef[] =
      kind === "decide" ? DECIDE_TOOLS : makeExecuteTools();
    const ctx = {
      workspaceDir: runDir,
      activityId: t.activityId,
      ops,
      by: "model" as const,
    };

    const res = await runAgentLoop({
      provider: this.opts.provider ?? getProvider(),
      model:
        this.opts.model ??
        getModel(kind === "decide" ? cfg.decideModel : undefined),
      systemPrompt,
      userPrompt,
      tools,
      executeTool: makeExecuteTool(ctx),
      signal: this.abortCtrl.signal,
      timeoutMs: cfg.activityTimeoutMs,
      turnTimeoutMs: cfg.turnTimeoutMs,
      maxTurns: cfg.maxTurns,
      contextWindow: cfg.contextWindow,
      // SAFETY: LoopEvent 各分支均为 {type, ts, ...} 纯 JSON 键值对象，
      // 满足 TranscriptPayload（Record<string, unknown> 形状）；两接口无公共超类型。
      onEvent: (ev) => t.append(ev as unknown as Record<string, unknown>),
    });
    t.close();

    // ── 查图检测（§3.2 定案：不拦截 executeTool）──────────────────────────
    const branch = ops.activeBranch;
    const idx = branch.revisions.findIndex((r) => r.id === beforeRevId);
    const completeRev = branch.revisions
      .slice(idx + 1)
      .find((r) => r.op === "complete");
    const newFacts = ops.headGraph().facts.slice(beforeFacts);

    // ── run.json 记账（usage 累加本活动 lastUsage）────────────────────────
    if (res.lastUsage) {
      const u = res.lastUsage;
      meta.usage.input += u.input;
      meta.usage.output += u.output;
      meta.usage.totalTokens += u.totalTokens;
      meta.usage.costTotal += u.cost.total;
    }
    if (kind === "decide") meta.budget.decides += 1;
    this.persistRun();

    return {
      reason: res.reason,
      changed: ops.activeBranch.head !== beforeRevId,
      newFacts,
      ...(res.error ? { error: res.error } : {}),
      ...(completeRev?.note ? { completedReason: completeRev.note } : {}),
      ...(res.lastUsage ? { lastUsage: res.lastUsage } : {}),
    };
  }

  private decidePrompts(): { systemPrompt: string; userPrompt: string } {
    const ops = this.ops!;
    const g = ops.headGraph();
    const hints = g.hints.filter((h) => h.status === "active").map((h) => h.text);
    return decidePrompt({
      goal: g.goal,
      origin: g.origin,
      skeleton: projectDecideSkeleton(g),
      hints: hints.join("\n"),
      residue: extractWorldResidue(ops.data, ops.activeBranch),
    });
  }

  private executePrompts(step: FGSStep): {
    systemPrompt: string;
    userPrompt: string;
  } {
    const g = this.ops!.headGraph();
    const { cfg } = this.opts;
    const agentsMd = renderAgentsMd({
      workspaceDir: this.opts.runDir,
      oobIp: cfg.oobIp,
      tools: makeExecuteTools(),
      findingSchema: DEFAULT_FINDING_SCHEMA,
    });
    return executePrompt({
      goal: g.goal,
      step,
      projection: projectExecuteSubgraph(g, step),
      agentsMd,
    });
  }

  // ---------------------------------------------------------------- run.json

  private loadOrCreateMeta(origin: string, goal: string): RunMeta {
    const { cfg } = this.opts;
    const file = runFile(this.opts.runDir);
    if (existsSync(file)) {
      try {
        const m = JSON.parse(readFileSync(file, "utf8")) as RunMeta;
        if (m.version === 1) {
          // Resume：executes/usage 跨崩溃累加保留；state 重置为 running
          m.state = "running";
          m.endReason = null;
          return m;
        }
      } catch {
        /* corrupt run.json → 重建（fgs 是真理源） */
      }
    }
    return {
      version: 1,
      origin,
      goal,
      config: {
        model: cfg.model,
        decideModel: cfg.decideModel,
        contextWindow: cfg.contextWindow,
        maxTurns: cfg.maxTurns,
        activityTimeoutMs: cfg.activityTimeoutMs,
        turnTimeoutMs: cfg.turnTimeoutMs,
        maxExecutes: cfg.maxExecutes,
      },
      budget: { executes: 0, decides: 0 },
      usage: { input: 0, output: 0, totalTokens: 0, costTotal: 0 },
      state: "running",
      endReason: null,
      startedAt: Date.now(),
      endedAt: null,
    };
  }

  private persistRun(): void {
    if (!this.meta) return;
    const file = runFile(this.opts.runDir);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.meta, null, 2), "utf8");
    renameSync(tmp, file);
  }

  private finish(reason: EndReason): void {
    if (this.meta) {
      if (this.state !== "parked") this.state = "ended";
      this.meta.state = this.state;
      this.meta.endReason = reason;
      this.meta.endedAt = Date.now();
      this.persistRun();
    }
    this.log(`end reason=${reason}`);
    this.widget();
  }

  private widget(statusNote?: string): void {
    if (!this.ops || !this.meta) return;
    const g = this.ops.headGraph();
    const counts = {
      done: g.steps.filter((s) => s.status === "done").length,
      inProgress: g.steps.filter((s) => s.status === "in_progress").length,
      pending: g.steps.filter((s) => s.status === "pending").length,
      dropped: g.steps.filter((s) => s.status === "dropped").length,
    };
    const next =
      g.steps.find((s) => s.status === "in_progress") ??
      g.steps.find((s) => s.status === "pending");
    const lines = [
      statusNote ??
        `cairn ${this.state} | budget ${this.meta.budget.executes}/${this.opts.cfg.maxExecutes} | ${g.facts.length} facts ${g.findings.length} findings`,
      `goal: ${g.goal.slice(0, 100)}`,
      `steps: ${counts.done} done / ${counts.inProgress} in_progress / ${counts.pending} pending / ${counts.dropped} dropped${next ? ` | next: ${next.id} ${next.text.slice(0, 70)}` : ""}`,
    ];
    this.opts.onWidget?.(lines.filter(Boolean));
  }
}

/**
 * Idempotent start：create-or-load fgs.json（+ run.json），后台跑引擎
 * （D3：命令 handler 立即返回）。
 */
export function startEngine(
  opts: EngineOptions,
  origin: string,
  goal: string,
): {
  engine: CairnEngine;
  ops: GraphOps;
  resumed: boolean;
  done: Promise<EndReason>;
} {
  const resumed = GraphOps.exists(opts.runDir);
  const ops = resumed
    ? GraphOps.load(opts.runDir)
    : GraphOps.create(opts.runDir, origin, goal);
  const engine = new CairnEngine(opts, ops);
  const done = engine.run(origin, goal).catch((e) => {
    engine.log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
    return "error" as EndReason;
  });
  return { engine, ops, resumed, done };
}
