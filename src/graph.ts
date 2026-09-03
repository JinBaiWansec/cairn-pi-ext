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
