/**
 * engine.ts — the deterministic serial CairnEngine (PLAN.md §5).
 *
 *   loop: decide -> for each new step: execute (+ conclude fallback) -> persist
 *   3. no new steps & no open steps & not complete -> dormancy (hints) -> loop
 *   end: complete / abort / budget exhausted
 *
 * Single instance per process (D3). Crash recovery = replay steps that are
 * still open/running after load.
 */

import { FgsGraph, type FgsStep } from "./graph.js";
import { concludePrompt, decidePrompt, executePrompt } from "./prompts.js";
import { parseDecideOutput, parseExecuteOutput } from "./protocol.js";
import { runSubSession } from "./subagent.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface CairnConfig {
  workspace: string;
  decideModel: string; // "provider/model-id"
  executeModel: string;
  /** Max execute runs total (PLAN default 20). */
  maxExecutes: number;
  decideTimeoutMs: number; // 120s
  executeTimeoutMs: number; // 300s
  concludeTimeoutMs: number; // 90s
  /** No-action dormancy before re-deciding (PLAN: 30s). */
  dormancyMs: number;
  onWidget?: (lines: string[]) => void;
  onLog?: (line: string) => void;
}

export const DEFAULTS: Omit<CairnConfig, "workspace" | "onWidget" | "onLog"> = {
  decideModel: "qwen/qwen-27b",
  executeModel: "qwen/qwen-27b",
  maxExecutes: 20,
  decideTimeoutMs: 120_000,
  executeTimeoutMs: 300_000,
  concludeTimeoutMs: 90_000,
  dormancyMs: 30_000,
};

const KB = 1024;

export type EndReason = "complete" | "aborted" | "budget" | "error";

export class CairnEngine {
  /** Process-wide singleton (D3). */
  static running: CairnEngine | null = null;

  aborted = false;
  private signal = { aborted: false };
  private round = 0;
  /** Change gate (mirrors original ReasonCheckpoint): fingerprint of the state
   * the last *successful* decide parse ran against. null = never decided. */
  private lastDecideFp: string | null = null;
  /** Consecutive decide parse failures on the unchanged fingerprint; resets
   * when the fingerprint changes. */
  private decideFpFails = 0;
  /** Fingerprint of the state the LAST sub-session attempt ran against (set on
   * every attempt, success or failure). decideFpFails only accumulates while
   * this stays the same — a parse failure does NOT advance lastDecideFp, so
   * retrying must be measured against the attempted state, not the last
   * successful one. */
  private decideFpAttempt: string | null = null;

  constructor(
    private cfg: CairnConfig,
    private graph: FgsGraph,
  ) {}

  abort(): void {
    this.aborted = true;
    this.signal.aborted = true;
    this.log("abort requested");
  }

  log(line: string): void {
    this.cfg.onLog?.(`[cairn] ${line}`);
  }

  /** Idempotent entry: create or resume the graph, run the loop. */
  async run(_origin: string, goal: string): Promise<EndReason> {
    if (CairnEngine.running)
      throw new Error("a cairn engine is already running");
    CairnEngine.running = this;
    try {
      this.log(
        `start workspace=${this.cfg.workspace} goal="${goal.slice(0, 60)}"`,
      );
      // Crash recovery (PLAN §7): replay steps that never reached a terminal
      // state. Their sub-sessions are gone; a fresh execute session replays.
      for (const s of [...this.graph.data.steps])
        if (s.status === "open" || s.status === "running")
          await this.runStep(s);

      let reason: EndReason = "aborted";
      while (!this.aborted) {
        if (this.graph.data.stats.executes >= this.cfg.maxExecutes) {
          this.log(
            `budget exhausted (${this.graph.data.stats.executes}/` +
              `${this.cfg.maxExecutes} executes); open steps left for restart`,
          );
          reason = "budget";
          break;
        }
        this.round += 1;
        const outcome = await this.runDecide();
        if (outcome === "complete") {
          reason = "complete";
          break;
        }
        if (outcome === "abort") break;
      }
      this.widget();
      this.log(`end reason=${reason} round=${this.round}`);
      return reason;
    } finally {
      CairnEngine.running = null;
    }
  }

  // ---------------------------------------------------------------- decide

  private async runDecide(): Promise<"continue" | "complete" | "abort"> {
    const bytes = this.graph.fullGraphBytes();
    const snapPath = this.graph.decideSnapshot();
    if (bytes >= 32 * KB)
      this.log(`graph ${bytes}B >= 32KB: requesting compression`);
    else if (bytes >= 16 * KB) this.log(`graph ${bytes}B >= 16KB (warn)`);

    // Change gate: if facts / unconsumed hints / step states are unchanged
    // since the last successful parse, the LLM would see the same graph and
    // the same answer — skip the sub-session and just sleep. After parse
    // failures we retry the same state at most 3 times, then wait for the
    // graph to change again. (Original: reason skipped when
    // "reason state unchanged facts=... hints=... open_intents=...".)
    const fp = this.decideFp();
    // Two dormancy cases:
    //  - state unchanged since the last SUCCESSFUL parse (nothing new to say);
    //  - state unchanged and >=3 parse failures on THIS state (give up until
    //    the state changes). Checked against decideFpAttempt because a failed
    //    parse never advances lastDecideFp.
    const dormant =
      (fp === this.lastDecideFp && this.decideFpFails === 0) ||
      (fp === this.decideFpAttempt && this.decideFpFails >= 3);
    if (dormant) {
      this.log(
        `decide: graph unchanged${
          this.decideFpFails
            ? `, ${this.decideFpFails} parse failures already`
            : " since last successful parse"
        } — dormancy (no LLM)`,
      );
      await this.dormancy();
      if (this.aborted) return "abort";
      return "continue";
    }
    if (fp !== this.decideFpAttempt) this.decideFpFails = 0;

    const prompt = decidePrompt({
      snapshotPath: snapPath,
      openStepCount: this.graph.openSteps().length,
      compressHint: bytes >= 32 * KB,
    });
    this.graph.bumpCounter("decides");
    this.graph.save();
    this.widget(
      `decide round ${this.round} (snapshot ${snapPath.split("/").pop()})`,
    );

    this.log("decide: sub-session start");
    const res = await runSubSession({
      phase: "decide",
      prompt,
      workspace: this.cfg.workspace,
      modelRef: this.cfg.decideModel,
      timeoutMs: this.cfg.decideTimeoutMs,
      abortSignal: this.signal,
    });
    if (this.aborted) return "abort";
    this.decideFpAttempt = fp;

    const parsed = parseDecideOutput(res.text);
    if (!parsed.ok) {
      // PLAN: decide parse failure -> skip this round (open steps stay open;
      // next DECIDE re-decides). The fingerprint is NOT updated, so the gate
      // above retries this same state (up to 3x) instead of sleeping on it.
      this.decideFpFails += 1;
      this.log(`decide parse failed: ${parsed.error} (skipping round)`);
      await this.dormancy();
      return "continue";
    }
    this.lastDecideFp = fp;
    this.decideFpFails = 0;

    // The snapshot this sub-session saw contained every unconsumed hint, so
    // mark them consumed now that the LLM has ruled on them. The fingerprint
    // (which counts unconsumed hints) then changes once more, triggering one
    // confirmation decide; after that the gate sleeps until NEW hints arrive.
    const consumed = this.graph.consumeHints();
    if (consumed > 0) {
      this.log(`hints consumed: ${consumed}`);
      this.graph.save();
    }

    switch (parsed.value.kind) {
      case "complete":
        this.log(`complete: ${parsed.value.reason}`);
        return "complete";
      case "none": {
        // Re-decide if something is still queued; otherwise sleep for hints.
        if (this.graph.openSteps().length === 0) {
          this.log("no action: dormancy (waiting for hints)");
          await this.dormancy();
          if (this.aborted) return "abort";
        }
        return "continue";
      }
      case "steps": {
        if (parsed.value.subgoals)
          this.graph.applySubgoals(parsed.value.subgoals);
        for (const text of parsed.value.steps) {
          if (this.aborted) return "abort";
          const step = this.graph.addStep(text);
          this.log(`new step ${step.id}: ${text.slice(0, 80)}`);
          this.graph.save();
          await this.runStep(step);
        }
        return "continue";
      }
    }
    return "continue"; // unreachable: union exhausted
  }

  // ---------------------------------------------------------------- execute

  private async runStep(step: FgsStep): Promise<void> {
    this.graph.setStepStatus(step.id, "running");
    this.graph.save();
    this.widget(`step ${step.id} running: ${step.text.slice(0, 80)}`);

    let session: AgentSession | null = null;
    try {
      this.graph.bumpCounter("executes");
      this.graph.save();
      const snapPath = this.graph.executeSnapshot(step.id);
      const prompt = executePrompt({
        snapshotPath: snapPath,
        stepId: step.id,
        stepText: step.text,
      });
      this.log(`execute ${step.id}: sub-session start`);
      const exec = await runSubSession({
        phase: "execute",
        prompt,
        workspace: this.cfg.workspace,
        modelRef: this.cfg.executeModel,
        timeoutMs: this.cfg.executeTimeoutMs,
        abortSignal: this.signal,
        keepSession: true, // engine owns it; conclude reuses it (D2)
      });
      session = exec.session;

      let out = parseExecuteOutput(exec.text);
      let viaConclude = false;
      // PLAN §5: timeout OR parse failure -> same-session conclude, 90s.
      if (exec.timedOut || !out.ok) {
        this.log(
          `execute ${step.id} ${
            exec.timedOut
              ? "timed out"
              : `parse failed: ${out.ok ? "" : out.error}`
          } -> conclude fallback`,
        );
        this.graph.bumpCounter("concludes");
        this.graph.save();
        this.widget(`step ${step.id} conclude fallback`);
        const concSnap = this.graph.executeSnapshot(step.id);
        const conc = await runSubSession({
          phase: "conclude",
          prompt: concludePrompt({
            snapshotPath: concSnap,
            stepId: step.id,
            stepText: step.text,
          }),
          workspace: this.cfg.workspace,
          modelRef: this.cfg.executeModel,
          timeoutMs: this.cfg.concludeTimeoutMs,
          session,
          abortSignal: this.signal,
        });
        const c2 = parseExecuteOutput(conc.text);
        if (c2.ok) {
          out = { ok: true, value: c2.value };
          viaConclude = true;
        } else if (!out.ok) out = { ok: false, error: `conclude: ${c2.error}` };
      }

      if (this.aborted) return;
      if (out.ok && out.value.kind === "accepted") {
        const fact = this.graph.recordStepResult(
          step.id,
          out.value.description,
          out.value.findings,
          viaConclude,
        );
        this.log(
          `step ${step.id} done${viaConclude ? " (via conclude)" : ""} -> ${fact.id}`,
        );
      } else {
        this.graph.dropStep(step.id);
        const why = !out.ok
          ? `no usable output: ${out.error}`
          : out.value.kind === "rejected"
            ? `rejected: ${out.value.reason}`
            : "unrecognized output";
        this.log(`step ${step.id} dropped (${why})`);
      }
    } finally {
      session?.dispose();
      this.graph.save();
      this.widget();
    }
  }

  // ---------------------------------------------------------------- helpers

  /** Stable fingerprint of decision-relevant graph state: fact count,
   * unconsumed hint count, step id:status string, subgoal done flags. */
  private decideFp(): string {
    const d = this.graph.data;
    const steps = d.steps.map((s) => `${s.id}:${s.status}`).join(",");
    const subs = d.goal.subgoals.map((g) => (g.done ? "1" : "0")).join("");
    return `${d.facts.length}|${this.graph.unconsumedHints().length}|${steps}|${subs}`;
  }

  private async dormancy(): Promise<void> {
    const end = Date.now() + this.cfg.dormancyMs;
    while (!this.aborted && Date.now() < end)
      await new Promise((r) => setTimeout(r, 500));
  }

  private widget(statusNote?: string): void {
    const d = this.graph.data;
    const counts = {
      done: d.steps.filter((s) => s.status === "done").length,
      open: d.steps.filter((s) => s.status === "open").length,
      running: d.steps.filter((s) => s.status === "running").length,
      dropped: d.steps.filter((s) => s.status === "dropped").length,
    };
    const current =
      d.steps.find((s) => s.status === "running") ??
      d.steps.filter((s) => s.status === "open").at(-1);
    const lines = [
      statusNote ??
        `cairn ${this.aborted ? "aborting" : "running"} | round ${this.round} | budget ${d.stats.executes}/${this.cfg.maxExecutes} | graph ${d.facts.length} facts ${d.findings.length} findings`,
      `goal: ${d.goal.text.slice(0, 100)}`,
      `steps: ${counts.done} done / ${counts.running} running / ${counts.open} open / ${counts.dropped} dropped${
        current ? ` | now: ${current.id} ${current.text.slice(0, 70)}` : ""
      }`,
      d.goal.subgoals
        .map((g) => `${g.done ? "✓" : "·"} ${g.id} ${g.text.slice(0, 60)}`)
        .join(" | "),
    ];
    this.cfg.onWidget?.(lines.filter(Boolean));
  }
}

/**
 * Idempotent start: create a fresh graph (or resume the existing one) and
 * launch the engine in the background (D3: the command handler returns
 * immediately).
 */
export function startEngine(
  cfg: CairnConfig,
  origin: string,
  goal: string,
): {
  engine: CairnEngine;
  graph: FgsGraph;
  resumed: boolean;
  done: Promise<EndReason>;
} {
  const resumed = FgsGraph.exists(cfg.workspace);
  const graph = resumed
    ? FgsGraph.load(cfg.workspace)
    : FgsGraph.create(cfg.workspace, origin, goal);
  const engine = new CairnEngine(cfg, graph);
  const done = engine.run(origin, goal).catch((e) => {
    engine.log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
    return "error" as EndReason;
  });
  return { engine, graph, resumed, done };
}
