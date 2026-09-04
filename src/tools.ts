/**
 * tools.ts — 安全工具层（plan §5 / §8 / §9.1 Step 3）。
 *
 * 零 pi 依赖（不 import pi-ai / pi-coding-agent）：自研 loop（Step 4）经
 * executeTool 回调驱动执行，本模块只负责"执行"与"工具定义"。
 * pi 插件属性全部归 index.ts（Step 7）。
 *
 * 组成：
 *  - 4 世界工具：executeBash（§5.2 逐字实现）、executeRead（切片）、
 *    executeWrite / executeEdit —— 路径全部锁死 workspaceDir 防逃逸
 *  - submit_fact：证据强制落盘 notes/facts/<id>.txt + 动态 Finding 校验
 *    + 连续 2 次校验失败降级提交（quality: "degraded"，§5.3）
 *  - 8 Decide 图工具执行器：纯内存 Single-Writer（GraphOps.applyOp）
 *  - makeExecuteTool(ctx)：loop 用统一分发入口 (name, args) → ToolResult
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Type, type TSchema } from "typebox";
import { buildFactEntry, factDedupKey, type FGSFinding, type FGSGraph, type FGSStep } from "./graph.js";
import type { GraphOps, OpBy } from "./graphops.js";

export interface ToolResult {
  ok: boolean;
  output: string;
  spillPath?: string;
}

export interface ToolCtx {
  workspaceDir: string;
  activityId: string;
  ops: GraphOps;
  /** 图变更署名（默认 "model"）。 */
  by?: OpBy;
}

const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const num = (v: unknown, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : d;

/** 路径锁：相对路径基于 workspaceDir，绝对路径必须仍在其中（防逃逸）。 */
function lockPath(workspaceDir: string, p: string): string | { error: string } {
  if (!p || typeof p !== "string") return { error: "empty path" };
  const ws = resolve(workspaceDir);
  const abs = resolve(ws, p);
  if (abs !== ws && !abs.startsWith(ws + sep))
    return { error: `path escapes workspace: ${p}` };
  return abs;
}

// ============================================================================
// 世界工具
// ============================================================================

/** §5.2 逐字实现：非交互 spawn + timeout -s 9 + 10MB 熔断 + 4KB Spill。 */
export async function executeBash(
  cmd: string,
  workspaceDir: string,
  activityId: string,
  timeoutSec = 30,
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    // 跨环境通用 POSIX / BusyBox 语法：-s 9
    // R8：timeout 直接 argv spawn（不再套外层 bash -c），否则外层 shell 的命令替换
    //（如 $(sleep 5)）发生在 exec timeout 之前，超时/熔断保证形同虚设。
    // GNU timeout -s 9 对被杀命令自身退出 137，下方 code===137 判定不受影响。
    const child = spawn("timeout", ["-s", "9", `${timeoutSec}s`, "bash", "-c", cmd], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"], // 关闭 stdin，杜绝交互式挂起
      env: {
        ...process.env,
        CI: "1",
        TERM: "dumb",
        DEBIAN_FRONTEND: "noninteractive",
        GIT_TERMINAL_PROMPT: "0",
      },
    });

    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB 物理上限防御 OOM
    let killedByBufferOverflow = false;

    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BUFFER_BYTES) {
        killedByBufferOverflow = true;
        child.kill("SIGKILL");
      } else {
        stdoutChunks.push(chunk);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes <= MAX_BUFFER_BYTES) stderrChunks.push(chunk);
    });

    child.on("close", (code, signal) => {
      if (killedByBufferOverflow) {
        return resolve({
          ok: false,
          output: `[EXECUTION BLOCKED] Output exceeded 10MB buffer limit.`,
        });
      }
      if (signal === "SIGKILL" || code === 137) {
        return resolve({
          ok: false,
          output: `[EXECUTION TIMEOUT] Command killed after ${timeoutSec}s limit.`,
        });
      }

      const raw =
        Buffer.concat(stdoutChunks).toString("utf8") +
        "\n" +
        Buffer.concat(stderrChunks).toString("utf8");
      const trimmed = raw.trim();

      // Spill 处理：超 4KB 截断落盘
      const MAX_INLINE = 4096;
      if (Buffer.byteLength(trimmed, "utf8") <= MAX_INLINE) {
        return resolve({ ok: code === 0, output: trimmed });
      }

      const fileName = `tool-${activityId}-${Date.now().toString().slice(-4)}.txt`;
      const spillRelPath = join("notes", fileName);
      mkdirSync(join(workspaceDir, "notes"), { recursive: true });
      writeFileSync(join(workspaceDir, spillRelPath), trimmed, "utf8");

      const head = trimmed.slice(0, 1500);
      const tail = trimmed.slice(-1500);
      const notice = `\n\n[OUTPUT TRUNCATED > 4KB] Full output saved to: ${spillRelPath}\nUse read(path, offset_lines, max_lines) to view segments or bash grep/tail.\n\n`;

      resolve({
        ok: code === 0,
        output: `${head}${notice}${tail}`,
        spillPath: spillRelPath,
      });
    });
  });
}

/** Read 切片：大日志按行窗读取（§5.1 原生支持切片读取大日志）。 */
export function executeRead(
  p: string,
  workspaceDir: string,
  offsetLines = 0,
  maxLines = 2000,
): ToolResult {
  const lp = lockPath(workspaceDir, p);
  if (typeof lp !== "string") return { ok: false, output: `[READ ERROR] ${lp.error}` };
  if (!existsSync(lp)) return { ok: false, output: `[READ ERROR] no such file: ${p}` };
  const lines = readFileSync(lp, "utf8").split("\n");
  const total = lines.length;
  const from = Math.max(0, Math.min(offsetLines, total));
  const to = Math.min(total, from + Math.max(1, maxLines));
  const body = lines.slice(from, to).join("\n");
  const more = to < total ? ` (use offset_lines=${to} to continue)` : "";
  return {
    ok: true,
    output: `[read ${p} lines ${from + 1}-${to} of ${total}${more}]\n${body}`,
  };
}

/** Write：绝对路径锁死 Workspace。 */
export function executeWrite(
  p: string,
  content: string,
  workspaceDir: string,
): ToolResult {
  const lp = lockPath(workspaceDir, p);
  if (typeof lp !== "string") return { ok: false, output: `[WRITE ERROR] ${lp.error}` };
  try {
    mkdirSync(dirname(lp), { recursive: true });
    writeFileSync(lp, content, "utf8");
    return { ok: true, output: `wrote ${Buffer.byteLength(content, "utf8")}B to ${p}` };
  } catch (e) {
    return { ok: false, output: `[WRITE ERROR] ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Edit：精确字符串唯一替换（old_str 必须恰好出现 1 次）。 */
export function executeEdit(
  p: string,
  oldStr: string,
  newStr: string,
  workspaceDir: string,
): ToolResult {
  const lp = lockPath(workspaceDir, p);
  if (typeof lp !== "string") return { ok: false, output: `[EDIT ERROR] ${lp.error}` };
  if (!existsSync(lp)) return { ok: false, output: `[EDIT ERROR] no such file: ${p}` };
  if (!oldStr) return { ok: false, output: `[EDIT ERROR] empty old_str` };
  const text = readFileSync(lp, "utf8");
  const count = text.split(oldStr).length - 1;
  if (count === 0) return { ok: false, output: `[EDIT ERROR] old_str not found in ${p}` };
  if (count > 1)
    return { ok: false, output: `[EDIT ERROR] old_str occurs ${count} times in ${p} — must be unique` };
  writeFileSync(lp, text.replace(oldStr, newStr), "utf8");
  return { ok: true, output: `edited ${p} (1 replacement)` };
}

// ============================================================================
// 动态 Finding Schema 工厂（§6.4；定义数据由 Step 5/6 的 AGENTS.md 生成提供）
// ============================================================================

export interface FindingFieldDef {
  name: string;
  type: "string" | "number" | "boolean";
  enum?: string[];
  required?: boolean;
}

export interface FindingSchema {
  label: string;
  fields: FindingFieldDef[];
}

/** §6.4 默认 Finding 模式定义。 */
export const DEFAULT_FINDING_SCHEMA: FindingSchema = {
  label: "安全漏洞 / 突破口 / 标志 Flag",
  fields: [
    { name: "title", type: "string", required: true },
    { name: "endpoint", type: "string", required: true },
    { name: "severity", type: "string", enum: ["info", "low", "medium", "high", "critical"], required: true },
    { name: "evidence", type: "string", required: true },
  ],
};

/** Finding 元素的 typebox schema（submit_fact.findings[] 用）。 */
export function makeFindingElement(schema: FindingSchema): TSchema {
  const props: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of schema.fields) {
    props[f.name] = f.enum
      ? { type: "string", enum: f.enum }
      : { type: f.type === "string" ? "string" : f.type };
    if (f.required) required.push(f.name);
  }
  return Type.Object(props as never, { additionalProperties: true, required });
}

export function validateFinding(
  raw: unknown,
  schema: FindingSchema,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, error: "finding must be an object" };
  const o = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const def of schema.fields) {
    const v = o[def.name];
    if (v === undefined || v === null || v === "") {
      if (def.required)
        return { ok: false, error: `missing required field '${def.name}'` };
      continue;
    }
    if (def.enum && !def.enum.includes(String(v)))
      return { ok: false, error: `'${def.name}' must be one of ${def.enum.join("|")}` };
    if (def.type === "string" && typeof v !== "string")
      return { ok: false, error: `'${def.name}' must be a string` };
    if (def.type === "number" && typeof v !== "number")
      return { ok: false, error: `'${def.name}' must be a number` };
    if (def.type === "boolean" && typeof v !== "boolean")
      return { ok: false, error: `'${def.name}' must be a boolean` };
    out[def.name] = v;
  }
  return { ok: true, value: out };
}

// ============================================================================
// submit_fact（§5.3：证据强制落盘 / 弱关联标记 / 降级提交）
// ============================================================================

export interface SubmitFactArgs {
  description: string;
  evidence: string;
  findings?: unknown[];
  kind?: string;
  blocks?: string[];
}

const maxNumId = (ids: string[], prefix: string): number => {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  return ids.reduce((m, id) => {
    const mm = id.match(re);
    return mm ? Math.max(m, Number(mm[1])) : m;
  }, 0);
};

export function makeSubmitFact(
  ctx: ToolCtx,
  findingSchema: FindingSchema = DEFAULT_FINDING_SCHEMA,
) {
  let findFailStreak = 0;
  return (a: SubmitFactArgs): ToolResult => {
    if (!a.description?.trim() || !a.evidence?.trim())
      return { ok: false, output: "[SUBMIT_FACT ERROR] description 与 evidence 均不可为空" };
    const g = ctx.ops.headGraph();
    const id = `f-${maxNumId(g.facts.map((f) => f.id), "f") + 1}`;

    // 证据强制落盘提前到 findings 校验之前（R2）：reject 分支不再丢证据，
    // 避免长程探测成果在崩溃时丢失（§5.3）。
    const factFile = join(ctx.workspaceDir, `notes/facts/${id}.txt`);
    mkdirSync(dirname(factFile), { recursive: true });
    writeFileSync(
      factFile,
      `fact: ${id}\nactivity: ${ctx.activityId}\n\ndescription: ${a.description}\n\nevidence:\n${a.evidence}\n`,
      "utf8",
    );

    // Finding 校验；连续 2 次失败 → 以 quality:"degraded" 强制入图
    const findings: FGSFinding[] = [];
    let degraded = false;
    if (a.findings?.length) {
      const valid: FGSFinding[] = [];
      let firstErr = "";
      for (const raw of a.findings) {
        const r = validateFinding(raw, findingSchema);
        if (r.ok) {
          valid.push({
            id: `find-${maxNumId(g.findings.map((f) => f.id), "find") + valid.length + 1}`,
            title: String(r.value.title ?? "finding"),
            severity: String(r.value.severity ?? "info") as FGSFinding["severity"],
            data: r.value,
            evidence_path: `notes/facts/${id}.txt`,
          });
        } else if (!firstErr) firstErr = r.error;
      }
      if (firstErr) {
        findFailStreak += 1;
        if (findFailStreak < 2)
          return {
            ok: false,
            output: `[SUBMIT_FACT REJECTED] findings 校验失败: ${firstErr}（连续 ${findFailStreak}/2 次，再失败将剥离 findings 以 degraded 强制入图）`,
          };
        // 连续 2 次失败 → degraded 强制入图（§5.3）；偏差①：只剥离非法 findings，
        // 合法者保留入图（而非 plan 反思中旧实现的全部剥离）。
        degraded = true;
        findings.push(...valid);
      } else {
        findFailStreak = 0;
        findings.push(...valid);
      }
    }

    // 快路径判定依据（Step 5）：kind 仅接受 positive/negative，其余值忽略（不落图）
    const kind =
      a.kind === "positive" || a.kind === "negative" ? a.kind : undefined;
    const { fact, superseded } = buildFactEntry({
      id,
      description: a.description,
      evidence: a.evidence,
      by: ctx.by ?? "model",
      quality: degraded ? "degraded" : "normal",
      ...(kind ? { kind } : {}),
      existing: g.facts,
      blocks: a.blocks,
    });

    if (!degraded) {
      ctx.ops.applyOp(
        "submit_fact",
        ctx.by ?? "model",
        (draft) => {
          draft.facts.push(fact);
          for (const s of superseded) {
            const t = draft.facts.find((f) => f.id === s.id);
            if (t) t.superseded = { by_fact_id: fact.id, reason: "superseded by new fact" };
          }
          draft.findings.push(...findings);
        },
        id,
      );
      const dup = g.facts.find((f) => factDedupKey(f.description) === factDedupKey(fact.description));
      const dupNote = dup ? `\n[DUPLICATE WARNING] 与 ${dup.id} 描述高度相似，请确认是否应使用 blocks 作废旧 fact。` : "";
      const weakNote = fact.weak_refs?.length
        ? `\n[WEAK REFS] 引用了已作废的 ${fact.weak_refs.join(", ")}，已标记 weak_refs，Decide 下轮核验。`
        : "";
      return {
        ok: true,
        output: `fact ${id} committed (evidence → ${fact.spill_path})${superseded.length ? `; superseded: ${superseded.map((s) => s.id).join(", ")}` : ""}${fact.weak_refs?.length ? weakNote : ""}${dupNote}`,
      };
    }

    // 降级提交路径（保留合法 findings，仅剥离非法者）
    const failCount = findFailStreak;
    ctx.ops.applyOp("submit_fact", ctx.by ?? "model", (draft) => {
      draft.facts.push(fact);
      for (const s of superseded) {
        const t = draft.facts.find((f) => f.id === s.id);
        if (t) t.superseded = { by_fact_id: fact.id, reason: "superseded by new fact" };
      }
      draft.findings.push(...findings);
    }, `${id} (degraded)`);
    findFailStreak = 0;
    return {
      ok: true,
      output: `fact ${id} committed DEGRADED (findings 连续 ${failCount} 次 Schema 校验失败，非法 findings 已剥离${findings.length ? `，${findings.length} 条合法 findings 已保留` : ""}，quality="degraded"；evidence → ${fact.spill_path})`,
    };
  };
}

// ============================================================================
// 8 Decide 图工具（纯内存 Single-Writer，§5.1）
// ============================================================================

function findStep(g: FGSGraph, id: string): FGSStep {
  const s = g.steps.find((x) => x.id === id);
  if (!s) throw new Error(`unknown step id: ${id}`);
  return s;
}

const GRAPH_OPS = {
  add_step(g: FGSGraph, text: string, priority?: number, addressesHint?: string): string {
    if (!text.trim()) throw new Error("step text 不可为空");
    const id = `s-${maxNumId(g.steps.map((s) => s.id), "s") + 1}`;
    g.steps.push({
      id,
      text: text.trim(),
      priority: priority ?? 50,
      status: "pending",
      attempts: 0,
      ...(addressesHint ? { addresses_hint: addressesHint } : {}),
    });
    return `step ${id} added`;
  },
  drop_step(g: FGSGraph, id: string, reason: string): string {
    const s = findStep(g, id);
    s.status = "dropped";
    s.lastOutcome = reason;
    return `step ${id} dropped`;
  },
  done_step(g: FGSGraph, id: string): string {
    findStep(g, id).status = "done";
    return `step ${id} marked done`;
  },
  set_step_priority(g: FGSGraph, id: string, priority: number): string {
    findStep(g, id).priority = priority;
    return `step ${id} priority → ${priority}`;
  },
  add_subgoal(g: FGSGraph, text: string): string {
    if (!text.trim()) throw new Error("subgoal text 不可为空");
    const id = `sg-${maxNumId(g.subgoals.map((s) => s.id), "sg") + 1}`;
    g.subgoals.push({ id, text: text.trim() });
    return `subgoal ${id} added`;
  },
  remove_subgoal(g: FGSGraph, id: string): string {
    const i = g.subgoals.findIndex((s) => s.id === id);
    if (i < 0) throw new Error(`unknown subgoal id: ${id}`);
    g.subgoals.splice(i, 1);
    return `subgoal ${id} removed`;
  },
  reject_hint(g: FGSGraph, id: string, reason: string): string {
    const h = g.hints.find((x) => x.id === id);
    if (!h) throw new Error(`unknown hint id: ${id}`);
    h.status = "rejected";
    h.rejection_reason = reason;
    return `hint ${id} rejected`;
  },
  complete(_g: FGSGraph, reason: string): string {
    if (!reason.trim()) throw new Error("complete 需要 reason");
    return `run completed: ${reason.trim()}`;
  },
} as const;

export type GraphOpName = keyof typeof GRAPH_OPS;

export function makeGraphOpExecutor(ctx: ToolCtx) {
  const by = ctx.by ?? "model";
  return (op: GraphOpName, args: Record<string, unknown>): ToolResult => {
    // applyOp 在克隆的 draft 上执行 mutator：校验失败抛错则 revision 不落盘
    const values = Object.values(args);
    try {
      const rev = ctx.ops.applyOp(
        op,
        by,
        (draft) => {
          (GRAPH_OPS[op] as (g: FGSGraph, ...a: unknown[]) => string)(draft, ...values);
        },
        op === "complete" ? str(args.reason) : undefined,
      );
      // 重新在落盘后的 head 上取值生成回报消息（不再改图）
      const head = ctx.ops.headGraph();
      const msg =
        op === "add_step"
          ? `step ${head.steps[head.steps.length - 1]?.id ?? "?"} added`
          : op === "add_subgoal"
            ? `subgoal ${head.subgoals[head.subgoals.length - 1]?.id ?? "?"} added`
            : op === "complete"
              ? `run completed: ${str(args.reason)}`
              : `${op} ok (${rev.id})`;
      return { ok: true, output: msg };
    } catch (e) {
      return { ok: false, output: String(e instanceof Error ? e.message : e) };
    }
  };
}

// ============================================================================
// loop 统一分发入口（Step 4 接线）
// ============================================================================

export type ExecuteTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

export function makeExecuteTool(ctx: ToolCtx): ExecuteTool {
  const submitFact = makeSubmitFact(ctx);
  const graphOp = makeGraphOpExecutor(ctx);
  const handlers: Record<string, (a: Record<string, unknown>) => ToolResult | Promise<ToolResult>> = {
    bash: (a) => executeBash(str(a.command), ctx.workspaceDir, ctx.activityId, num(a.timeout_sec, 30)),
    read: (a) => executeRead(str(a.path), ctx.workspaceDir, num(a.offset_lines, 0), num(a.max_lines, 2000)),
    write: (a) => executeWrite(str(a.path), str(a.content), ctx.workspaceDir),
    edit: (a) => executeEdit(str(a.path), str(a.old_str), str(a.new_str), ctx.workspaceDir),
    submit_fact: (a) =>
      submitFact({
        description: str(a.description),
        evidence: str(a.evidence),
        findings: a.findings as unknown[] | undefined,
        kind: a.kind as string | undefined,
        blocks: a.blocks as string[] | undefined,
      }),
    add_step: (a) =>
      graphOp("add_step", { text: a.text, priority: a.priority, addresses_hint: a.addresses_hint }),
    drop_step: (a) => graphOp("drop_step", { id: a.id, reason: a.reason }),
    done_step: (a) => graphOp("done_step", { id: a.id }),
    set_step_priority: (a) => graphOp("set_step_priority", { id: a.id, priority: a.priority }),
    add_subgoal: (a) => graphOp("add_subgoal", { text: a.text }),
    remove_subgoal: (a) => graphOp("remove_subgoal", { id: a.id }),
    reject_hint: (a) => graphOp("reject_hint", { id: a.id, reason: a.reason }),
    complete: (a) => graphOp("complete", { reason: a.reason }),
  };
  return async (name, args) => {
    const h = handlers[name];
    if (!h) return { ok: false, output: `unknown tool: ${name}` };
    try {
      return await h(args ?? {});
    } catch (e) {
      return { ok: false, output: `tool error: ${e instanceof Error ? e.message : String(e)}` };
    }
  };
}

// ============================================================================
// 工具定义（typebox TSchema；Step 4 直接喂给 pi-ai streamSimple 的 tools 数组）
// ============================================================================

export interface ToolDef {
  name: string;
  description: string;
  parameters: TSchema;
}

export const DECIDE_TOOLS: ToolDef[] = [
  {
    name: "add_step",
    description: "添加一个待执行的 Step（战术单元）。priority 数字越小越先执行（默认 50）。addresses_hint 可选：本 step 落实哪条 hint。",
    parameters: Type.Object({
      text: Type.String({ description: "step 目标描述" }),
      priority: Type.Optional(Type.Number({ description: "优先级，越小越先" })),
      addresses_hint: Type.Optional(Type.String({ description: "对应的 hint id" })),
    }, { required: ["text"] }),
  },
  {
    name: "drop_step",
    description: "废弃一个无效 Step（标记 dropped，附原因）。",
    parameters: Type.Object({ id: Type.String(), reason: Type.String() }, { required: ["id", "reason"] }),
  },
  {
    name: "done_step",
    description: "标记 Step 已完成。",
    parameters: Type.Object({ id: Type.String() }, { required: ["id"] }),
  },
  {
    name: "set_step_priority",
    description: "重排 Step 优先级。",
    parameters: Type.Object({ id: Type.String(), priority: Type.Number() }, { required: ["id", "priority"] }),
  },
  {
    name: "add_subgoal",
    description: "添加战略子目标。",
    parameters: Type.Object({ text: Type.String() }, { required: ["text"] }),
  },
  {
    name: "remove_subgoal",
    description: "移除战略子目标。",
    parameters: Type.Object({ id: Type.String() }, { required: ["id"] }),
  },
  {
    name: "reject_hint",
    description: "显式闭环一条人工 Hint（标记 rejected + 原因），告知人该提示已被处理。",
    parameters: Type.Object({ id: Type.String(), reason: Type.String() }, { required: ["id", "reason"] }),
  },
  {
    name: "complete",
    description: "标记系统目标（Goal）已达成并终止 Run。",
    parameters: Type.Object({ reason: Type.String({ description: "达成依据（引用 fact id）" }) }, { required: ["reason"] }),
  },
];

export function makeExecuteTools(findingSchema: FindingSchema = DEFAULT_FINDING_SCHEMA): ToolDef[] {
  return [
    {
      name: "bash",
      description: "在 workspace 执行 shell 命令（非交互；stdin 关闭；超时 SIGKILL；>4KB 输出自动落盘 notes/ 并给路径）。",
      parameters: Type.Object({
        command: Type.String(),
        timeout_sec: Type.Optional(Type.Number({ description: "秒，默认 30" })),
      }, { required: ["command"] }),
    },
    {
      name: "read",
      description: "按行窗读取文件（切片读大日志/Spill 文件）。",
      parameters: Type.Object({
        path: Type.String(),
        offset_lines: Type.Optional(Type.Number({ description: "起始行（0 基）" })),
        max_lines: Type.Optional(Type.Number({ description: "最多行数，默认 2000" })),
      }, { required: ["path"] }),
    },
    {
      name: "write",
      description: "写文件（相对 workspace；自动建父目录）。",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }, { required: ["path", "content"] }),
    },
    {
      name: "edit",
      description: "精确字符串唯一替换（old_str 必须在文件中恰好出现 1 次）。",
      parameters: Type.Object({ path: Type.String(), old_str: Type.String(), new_str: Type.String() }, { required: ["path", "old_str", "new_str"] }),
    },
    {
      name: "submit_fact",
      description: "把关键技术事实沉淀入 FGS 图。evidence 会被强制落盘 notes/facts/；blocks 列出被本 fact 作废旧 fact 的 id；findings 按 AGENTS.md 的 Finding 模式定义提交。",
      parameters: Type.Object({
        description: Type.String({ description: "事实描述（≤50 字为宜，可引用 f-<n>）" }),
        evidence: Type.String({ description: "完整证据（工具输出片段等）" }),
        findings: Type.Optional(Type.Array(makeFindingElement(findingSchema))),
        kind: Type.Optional(Type.String()),
        blocks: Type.Optional(Type.Array(Type.String(), { description: "被作废的既有 fact id" })),
      }, { required: ["description", "evidence"] }),
    },
  ];
}
