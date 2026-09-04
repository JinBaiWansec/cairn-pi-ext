/**
 * FgsGraph — persistent Fact-Goal-Step graph for the Cairn engine.
 *
 * Storage: <workspace>/fgs.json (single writer: read -> mutate -> full rewrite
 * via temp file + atomic rename). Snapshots land in <workspace>/snapshots/.
 *
 * Entity semantics (PLAN.md §6):
 *  - origin is seeded as fact f-1 (source=origin)
 *  - step state machine: open -> running -> done | dropped
 *  - conclude-rescued steps still land in "done" (source=conclude:<step>)
 *  - hints are appended and consumed by the engine (consumed flag)
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type StepStatus = "open" | "running" | "done" | "dropped";

/**
 * Execute context budget (PLAN §5, D5-1): max recent facts (excluding origin)
 * shown to an execute sub-session. The full graph stays available to decide.
 */
export const EXECUTE_FACT_WINDOW = 8;

export interface FgsGoal {
  text: string;
  subgoals: { id: string; text: string; done: boolean }[];
}

export interface FgsFact {
  id: string;
  text: string;
  source: string; // "origin" | "step:s-1" | "conclude:s-1"
  ts: number;
}

export interface FgsStep {
  id: string;
  text: string;
  status: StepStatus;
  result_fact_id: string | null;
}

export interface FgsFinding {
  id: string;
  title: string;
  evidence: string;
  source_step: string;
}

export interface FgsHint {
  text: string;
  ts: number;
  consumed: boolean;
}

export interface FgsStats {
  decides: number;
  executes: number;
  concludes: number;
  started_ts: number;
  updated_ts: number;
}

export interface Fgs {
  version: 1;
  origin: string;
  goal: FgsGoal;
  facts: FgsFact[];
  steps: FgsStep[];
  findings: FgsFinding[];
  hints: FgsHint[];
  stats: FgsStats;
}

/** Snapshot handed to sub-sessions. Full = decide; pruned = execute. */
export interface FgsSnapshot {
  phase: "decide" | "execute";
  origin: string;
  goal: FgsGoal;
  facts: FgsFact[];
  steps: FgsStep[] | null; // pruned snapshot omits the step list
  findings: FgsFinding[] | null; // pruned snapshot omits findings
  current_step: FgsStep | null; // execute only
  hints: FgsHint[]; // unconsumed only
}

const now = () => Math.floor(Date.now() / 1000);

export class FgsGraph {
  private readonly file: string;
  private readonly snapDir: string;
  data: Fgs;

  private constructor(file: string, data: Fgs) {
    this.file = file;
    this.snapDir = join(dirname(file), "snapshots");
    this.data = data;
  }

  /** Create a fresh graph on disk. Throws if the file already exists. */
  static create(workspace: string, origin: string, goalText: string): FgsGraph {
    const file = join(workspace, "fgs.json");
    if (existsSync(file)) throw new Error(`fgs.json already exists at ${file}`);
    mkdirSync(workspace, { recursive: true });
    const data: Fgs = {
      version: 1,
      origin,
      goal: { text: goalText, subgoals: [] },
      facts: [
        { id: "f-1", text: `origin: ${origin}`, source: "origin", ts: now() },
      ],
      steps: [],
      findings: [],
      hints: [],
      stats: {
        decides: 0,
        executes: 0,
        concludes: 0,
        started_ts: now(),
        updated_ts: now(),
      },
    };
    const g = new FgsGraph(file, data);
    g.save();
    return g;
  }

  /** Load an existing graph (crash recovery path). */
  static load(workspace: string): FgsGraph {
    const file = join(workspace, "fgs.json");
    if (!existsSync(file)) throw new Error(`no fgs.json at ${file}`);
    const data = FgsGraph.parseFile(file);
    if (data.version !== 1)
      throw new Error(`unsupported fgs version ${data.version}`);
    return new FgsGraph(file, data);
  }

  static exists(workspace: string): boolean {
    return existsSync(join(workspace, "fgs.json"));
  }

  /** Read-only load for the UI server (no mutation). */
  static peek(workspace: string): Fgs | null {
    const file = join(workspace, "fgs.json");
    if (!existsSync(file)) return null;
    return FgsGraph.parseFile(file);
  }

  private static parseFile(file: string): Fgs {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      throw new Error(
        `failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      return JSON.parse(raw) as Fgs;
    } catch (e) {
      throw new Error(
        `corrupt fgs.json at ${file}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ---------------------------------------------------------------- persistence

  save(): void {
    this.data.stats.updated_ts = now();
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.file);
  }

  // ---------------------------------------------------------------- counters / ids

  private nextId(prefix: string): string {
    let n = 0;
    for (const s of this.data.steps)
      if (s.id.startsWith(`${prefix}-`))
        n = Math.max(n, Number(s.id.slice(prefix.length + 1)) || 0);
    for (const f of this.data.facts)
      if (f.id.startsWith(`${prefix}-`))
        n = Math.max(n, Number(f.id.slice(prefix.length + 1)) || 0);
    for (const fd of this.data.findings)
      if (fd.id.startsWith(`${prefix}-`))
        n = Math.max(n, Number(fd.id.slice(prefix.length + 1)) || 0);
    for (const sg of this.data.goal.subgoals)
      if (sg.id.startsWith(`${prefix}-`))
        n = Math.max(n, Number(sg.id.slice(prefix.length + 1)) || 0);
    return `${prefix}-${n + 1}`;
  }

  bumpCounter(k: "decides" | "executes" | "concludes"): void {
    this.data.stats[k] += 1;
  }

  // ---------------------------------------------------------------- facts

  addFact(text: string, source: string): FgsFact {
    const fact: FgsFact = { id: this.nextId("f"), text, source, ts: now() };
    this.data.facts.push(fact);
    return fact;
  }

  // ---------------------------------------------------------------- steps (state machine)

  addStep(text: string): FgsStep {
    const step: FgsStep = {
      id: this.nextId("s"),
      text,
      status: "open",
      result_fact_id: null,
    };
    this.data.steps.push(step);
    return step;
  }

  getStep(id: string): FgsStep | undefined {
    return this.data.steps.find((s) => s.id === id);
  }

  openSteps(): FgsStep[] {
    return this.data.steps.filter((s) => s.status === "open");
  }

  /**
   * Step state machine: open -> running -> done | dropped.
   * Throws on illegal transitions (guards against double-scheduling).
   */
  setStepStatus(
    id: string,
    status: StepStatus,
    resultFactId?: string,
  ): FgsStep {
    const step = this.getStep(id);
    if (!step) throw new Error(`unknown step ${id}`);
    const legal: Record<StepStatus, StepStatus[]> = {
      open: ["running", "dropped"], // open->dropped: cleanup of never-scheduled steps
      running: ["done", "dropped"],
      done: [],
      dropped: [],
    };
    if (!legal[step.status].includes(status)) {
      throw new Error(
        `illegal step transition ${step.status} -> ${status} (step ${id})`,
      );
    }
    if (status === "done" && !resultFactId) {
      throw new Error(`step ${id} -> done requires resultFactId`);
    }
    step.status = status;
    if (status === "done" && resultFactId) step.result_fact_id = resultFactId;
    return step;
  }

  /**
   * Execute success: fact (source=step:<id>) + step done + result link.
   */
  recordStepResult(
    stepId: string,
    description: string,
    findings: { title: string; evidence: string }[],
    viaConclude: boolean,
  ): FgsFact {
    const fact = this.addFact(
      description,
      viaConclude ? `conclude:${stepId}` : `step:${stepId}`,
    );
    this.setStepStatus(stepId, "done", fact.id);
    for (const f of findings) {
      this.data.findings.push({
        id: this.nextId("fd"),
        title: f.title,
        evidence: f.evidence,
        source_step: stepId,
      });
    }
    return fact;
  }

  dropStep(stepId: string): void {
    this.setStepStatus(stepId, "dropped");
  }

  // ---------------------------------------------------------------- subgoals

  applySubgoals(spec: {
    add?: string[];
    done?: string[];
    drop?: string[];
  }): void {
    for (const text of spec.add ?? []) {
      this.data.goal.subgoals.push({
        id: this.nextId("sg"),
        text,
        done: false,
      });
    }
    for (const id of spec.done ?? []) {
      const sg = this.data.goal.subgoals.find((g) => g.id === id);
      if (sg) sg.done = true;
    }
    for (const id of spec.drop ?? []) {
      this.data.goal.subgoals = this.data.goal.subgoals.filter(
        (g) => g.id !== id,
      );
    }
  }

  // ---------------------------------------------------------------- hints

  addHint(text: string): FgsHint {
    const hint: FgsHint = { text, ts: now(), consumed: false };
    this.data.hints.push(hint);
    return hint;
  }

  unconsumedHints(): FgsHint[] {
    return this.data.hints.filter((h) => !h.consumed);
  }

  consumeHints(): number {
    let n = 0;
    for (const h of this.data.hints)
      if (!h.consumed) {
        h.consumed = true;
        n++;
      }
    return n;
  }

  /** External hint injection (UI /hints endpoint): append + persist. */
  injectHint(text: string): Fgs {
    this.addHint(text);
    this.save();
    return this.data;
  }

  // ---------------------------------------------------------------- snapshots

  private writeSnapshot(snap: FgsSnapshot, phase: string): string {
    mkdirSync(this.snapDir, { recursive: true });
    const hash = createHash("sha256")
      .update(JSON.stringify(snap))
      .digest("hex")
      .slice(0, 12);
    const path = join(this.snapDir, `${phase}-${hash}.json`);
    writeFileSync(path, JSON.stringify(snap, null, 2), "utf8");
    return path;
  }

  /** Decide snapshot: full graph (goal + all facts/steps/findings + unconsumed hints). */
  decideSnapshot(): string {
    const snap: FgsSnapshot = {
      phase: "decide",
      origin: this.data.origin,
      goal: this.data.goal,
      facts: this.data.facts,
      steps: this.data.steps,
      findings: this.data.findings,
      current_step: null,
      hints: this.unconsumedHints(),
    };
    return this.writeSnapshot(snap, "decide");
  }

  /**
   * Execute snapshot (context budget, PLAN §5 D5-1): goal + origin + current
   * step + the TAIL of the fact chain + unconsumed hints. Omits the step list
   * and findings, and prunes facts to origin + the most recent
   * EXECUTE_FACT_WINDOW entries so the 27B worker window stays small on long
   * runs (the full graph remains available to the decide phase).
   */
  executeSnapshot(stepId: string): string {
    const step = this.getStep(stepId);
    if (!step) throw new Error(`unknown step ${stepId}`);
    const snap: FgsSnapshot = {
      phase: "execute",
      origin: this.data.origin,
      goal: this.data.goal,
      facts: this.executeFacts(),
      steps: null,
      findings: null,
      current_step: step,
      hints: this.unconsumedHints(),
    };
    return this.writeSnapshot(snap, "execute");
  }

  /** origin fact + the most recent EXECUTE_FACT_WINDOW facts (D5-1 window). */
  private executeFacts(): FgsFact[] {
    const all = this.data.facts;
    if (all.length <= EXECUTE_FACT_WINDOW + 1) return all;
    const originFact = all.find((f) => f.source === "origin");
    const rest = all.filter((f) => f.source !== "origin");
    return [
      ...(originFact ? [originFact] : rest.slice(0, 1)),
      ...rest.slice(-EXECUTE_FACT_WINDOW),
    ];
  }

  /** Bytes of the full-graph JSON — used for the 16/32KB soft budget. */
  fullGraphBytes(): number {
    return Buffer.byteLength(JSON.stringify(this.data), "utf8");
  }
}

// ============================================================================
// 二期 FGS 数据结构（plan §4.1）— revision 树 + 分支
//
// fgs.json = FGSFile（version 2）；每次图变更由 GraphOps.append 一条不可变
// FGSRevision（rev-<n> 全局单调递增，全量图快照）。旧 Fgs/FgsGraph API 保留
// 至 Step 5/7 随 engine/index 重写删除。
// ============================================================================

export interface FGSStep {
  id: string;
  text: string;
  priority: number;
  status: "pending" | "in_progress" | "done" | "dropped";
  addresses_hint?: string;
  attempts: number;
  lastOutcome?: string;
}

export interface FGSFact {
  id: string;
  description: string;
  /** ≤80 字精简摘要；完整证据在 spill_path（plan §5.3 强制落盘）。 */
  evidence_summary: string;
  /** notes/facts/<id>.txt */
  spill_path: string;
  superseded?: { by_fact_id?: string; reason: string };
  /** 引用了已作废 Fact 的 id 列表（§5.3 弱关联，不拦截只标记）。 */
  weak_refs?: string[];
  quality?: "normal" | "degraded";
  /** 快路径判定依据（Step 5）：positive = 新正面事实（触发 done_step 快路径）；negative = 负事实/阻断（§6.3 纪律 3）。缺省 = 未标注。 */
  kind?: "positive" | "negative";
  created_at: number;
  created_by: "model" | "user";
}

export interface FGSFinding {
  id: string;
  title: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
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
  /** 增补：世界残留提取需要知道源分支名（plan 只有 forkFromRevision）。 */
  forkFromBranch?: string;
  head: string;
  revisions: FGSRevision[];
}

/** fgs.json 根 schema。activeBranch 归 Single-Writer 所有（run.json 只存预算/usage 元数据）。 */
export interface FGSFile {
  version: 2;
  revCounter: number;
  branches: FGSBranch[];
  activeBranch: string;
}

// ---------------------------------------------------------------- projections
// plan §4.2：纯函数，FGSGraph/FGSFile 进 → prompt 片段出（嵌入 §6.2/6.3 模板）。

/**
 * 粗估 token：ASCII ≈ 4 字符/token；CJK（汉字/全角标点）≈ 1 字符/token。
 * R1：纯 len/4 对中文低估 ~3.4×（39 字中文句估 10、实际 ~34），
 * 投影预算按 budget*4 字符折算时 CJK 场景可超 3×，威胁 Decide Prefill 指标。
 */
export const estTokens = (s: string): number => {
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      (c >= 0x4e00 && c <= 0x9fff) || // CJK 统一汉字
      (c >= 0x3400 && c <= 0x4dbf) || // 扩展 A
      (c >= 0xf900 && c <= 0xfaff) || // 兼容汉字
      (c >= 0x3000 && c <= 0x303f) || // CJK 标点（。、《》等）
      (c >= 0xff00 && c <= 0xffef) // 全角形（，！？（）等）
    )
      cjk++;
  }
  return cjk + Math.ceil((s.length - cjk) / 4);
};

const trunc = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max) + "…";

const DECIDE_SKELETON_BUDGET = 1500; // tokens
const EXECUTE_SUBGRAPH_BUDGET = 2500; // tokens

export interface FGSSkeleton {
  origin: string;
  goal: string;
  subgoals: string[];
  steps: Array<{ id: string; status: string; p: number; t: string }>;
  facts: Array<{ id: string; d: string; sup: boolean }>;
  findings: Array<{ id: string; sev: string; t: string }>;
  hints: string[];
}

/**
 * Decide 骨架投影（§4.2，恒定 ≤1.5k tokens）：
 *  - Fact：仅 id + description(≤50字) + superseded 标记，强制剥离 evidence
 *  - Step：pending/in_progress + 最近 3 个 done，隐藏 dropped
 *  - 渐进裁剪：hints → findings → 最近 10 条 facts
 */
export function projectDecideSkeleton(g: FGSGraph): string {
  const budget = DECIDE_SKELETON_BUDGET * 4;
  const factsOf = (fs: FGSFact[]) =>
    fs.map((f) => ({ id: f.id, d: trunc(f.description, 50), sup: !!f.superseded }));
  let sk: FGSSkeleton = {
    origin: g.origin,
    goal: g.goal,
    subgoals: g.subgoals.map((s) => s.text),
    steps: [
      ...g.steps
        .filter((s) => s.status === "pending" || s.status === "in_progress")
        .sort((a, b) => a.priority - b.priority),
      ...g.steps.filter((s) => s.status === "done").slice(-3),
    ].map((s) => ({ id: s.id, status: s.status, p: s.priority, t: s.text })),
    facts: factsOf(g.facts),
    findings: g.findings.map((f) => ({ id: f.id, sev: f.severity, t: f.title })),
    hints: g.hints.filter((h) => h.status === "active").map((h) => h.text),
  };
  const size = (x: FGSSkeleton) => JSON.stringify(x).length;
  if (size(sk) > budget) sk = { ...sk, hints: [] };
  if (size(sk) > budget) sk = { ...sk, findings: [] };
  if (size(sk) > budget) sk = { ...sk, facts: factsOf(g.facts.slice(-10)) };
  let out = JSON.stringify(sk);
  if (out.length > budget) out = out.slice(0, budget) + "…";
  return out;
}

export interface FGSExecuteProjection {
  goal: string;
  step: { id: string; text: string; priority: number; attempts: number };
  facts: Array<{ id: string; d: string; path: string }>;
}

/**
 * Execute 局部子图投影（§4.2，恒定 ≤2.5k tokens）：
 * Goal + 当前 Step + 相关未作废 Facts（origin + 未 superseded，摘要 ≤100 字 +
 * spill 路径）。超预算时从最旧 fact 开始裁（origin 永保留）。
 */
export function projectExecuteSubgraph(g: FGSGraph, step: FGSStep): string {
  const budget = EXECUTE_SUBGRAPH_BUDGET * 4;
  const usable = g.facts.filter((f) => !f.superseded);
  const origin = usable.find((f) => f.id === "f-1") ?? usable[0] ?? null;
  let rest = usable.filter((f) => f !== origin);
  const build = (fs: FGSFact[]): string =>
    JSON.stringify({
      goal: g.goal,
      step: {
        id: step.id,
        text: step.text,
        priority: step.priority,
        attempts: step.attempts,
      },
      facts: fs.map((f) => ({
        id: f.id,
        d: trunc(f.description, 100),
        path: f.spill_path,
      })),
    } satisfies FGSExecuteProjection);
  while (origin && rest.length && build([origin, ...rest]).length > budget) {
    rest = rest.slice(1);
  }
  return build(origin ? [origin, ...rest] : rest);
}

/**
 * 世界残留提取（§4.2，Fork 防裂脑）：源分支在 Fork 点之后新产生的 fact 描述。
 * 非 fork 分支或无残留时返回 ""。
 */
export function extractWorldResidue(file: FGSFile, branch: FGSBranch): string {
  if (!branch.forkFromBranch || branch.forkFromBranch === branch.name) return "";
  const src = file.branches.find((b) => b.name === branch.forkFromBranch);
  if (!src) return "";
  const forkRev = branch.revisions.find((r) => r.id === branch.forkFromRevision);
  const baseIds = new Set((forkRev?.graph.facts ?? []).map((f) => f.id));
  const srcHead =
    src.revisions.find((r) => r.id === src.head)?.graph.facts ?? [];
  const residue = srcHead.filter((f) => !baseIds.has(f.id));
  if (!residue.length) return "";
  return [
    "# 世界残留（不在本分支认知中，但靶机物理状态已改变）",
    ...residue.map((f) => `- ${f.id}: ${trunc(f.description, 80)}`),
  ].join("\n");
}

// ---------------------------------------------------------------- fact helpers
// plan §5.3：证据落盘 / 弱关联 / 降级提交。纯函数，由 GraphOps 在 applyOp 内应用。

/** 去重键：小写、去非字母数字（含 CJK）、取前 80 字。 */
export const factDedupKey = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "").slice(0, 80);

/**
 * submit_fact 入图条目构建：
 *  - evidence_summary = 前 80 字；spill_path = notes/facts/<id>.txt
 *  - weak_refs = 正文引用（f-\d+）且已 superseded 的 fact id
 *  - blocks 中的 fact id 被新 fact 标记为 superseded（superseded 链）
 */
export function buildFactEntry(args: {
  id: string;
  description: string;
  evidence: string;
  by: "model" | "user";
  quality?: "normal" | "degraded";
  /** 快路径判定依据（Step 5）：positive/negative，缺省 = 未标注。 */
  kind?: "positive" | "negative";
  /** 本 fact 作废的既有 fact id 列表。 */
  blocks?: string[];
  existing: FGSFact[];
}): { fact: FGSFact; superseded: Array<{ id: string; by: string }> } {
  const { id, description, evidence, by, quality, kind, existing } = args;
  const blocks = args.blocks ?? [];
  const refs = [...`${description}\n${evidence}`.matchAll(/f-(\d+)/g)].map(
    (m) => `f-${m[1]}`,
  );
  const weak = [...new Set(refs)].filter(
    (r) => r !== id && existing.some((f) => f.id === r && f.superseded),
  );
  const fact: FGSFact = {
    id,
    description,
    evidence_summary: trunc(evidence, 80),
    spill_path: `notes/facts/${id}.txt`,
    ...(weak.length ? { weak_refs: weak } : {}),
    ...(quality ? { quality } : {}),
    ...(kind ? { kind } : {}),
    created_at: Date.now(),
    created_by: by,
  };
  const byId = new Map(existing.map((f) => [f.id, f]));
  const superseded = blocks
    .filter((b) => b !== id && byId.has(b) && !byId.get(b)!.superseded)
    .map((b) => ({ id: b, by: id }));
  return { fact, superseded };
}
