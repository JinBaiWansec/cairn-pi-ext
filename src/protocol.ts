/**
 * protocol.ts — end-of-message JSON protocol (PLAN.md §6).
 *
 * Sub-sessions end their last assistant message with a single JSON object.
 * Extraction tolerates ```json fences and prose before/after: the first
 * brace-balanced object that JSON.parses wins.
 */

// ---------------------------------------------------------------- decide

export type SubgoalSpec = { add?: string[]; done?: string[]; drop?: string[] };

export type DecideOutput =
  | { kind: "complete"; reason: string }
  | { kind: "steps"; steps: string[]; subgoals?: SubgoalSpec }
  | { kind: "none" };

// ---------------------------------------------------------------- execute / conclude

export interface Finding {
  title: string;
  evidence: string;
}

export type ExecuteOutput =
  | { kind: "accepted"; description: string; findings: Finding[] }
  | { kind: "rejected"; reason: string };

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// ---------------------------------------------------------------- extraction

/**
 * First JSON object in text, in the SAME order as original Cairn
 * (dispatcher/output_parser.py extract_json_object): candidate segments are
 * the full text, then each ``` fence in document order; per segment try the
 * whole segment as a JSON document first (object only), then scan each '{'
 * position. First object wins; null when none found.
 */
const FENCED_BLOCK_RE = /```(?:json)?\s*\n?([\s\S]*?)```/gi;

export function extractJson(text: string): unknown | null {
  const segments: string[] = [text.trim()];
  for (const m of text.matchAll(FENCED_BLOCK_RE)) segments.push(m[1].trim());
  const seen = new Set<string>();
  for (const seg of segments) {
    if (seg === "" || seen.has(seg)) continue;
    seen.add(seg);
    // 1. whole segment as a JSON document
    try {
      const p = JSON.parse(seg);
      if (p !== null && typeof p === "object" && !Array.isArray(p)) return p;
    } catch {
      // not a full JSON document — fall through to brace scan
    }
    // 2. first brace-balanced object in the segment
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] !== "{") continue;
      const end = matchBrace(seg, i);
      if (end === -1) continue;
      try {
        const p = JSON.parse(seg.slice(i, end + 1));
        if (p !== null && typeof p === "object" && !Array.isArray(p))
          return p;
      } catch {
        // not valid JSON — keep scanning
      }
    }
  }
  return null;
}

/** Index of the '}' balancing the '{' at start, respecting strings/escapes. -1 if unbalanced. */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------- decide parsing

const isStr = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;
const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(isStr);

export function parseDecideOutput(text: string): ParseResult<DecideOutput> {
  const raw = extractJson(text);
  if (raw === null) return { ok: false, error: "no JSON object found" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "JSON is not an object" };
  }
  const o = raw as Record<string, unknown>;

  if (o.complete !== undefined) {
    const c = o.complete;
    if (
      typeof c !== "object" ||
      c === null ||
      !isStr((c as Record<string, unknown>).reason)
    ) {
      return {
        ok: false,
        error: "complete requires a non-empty reason string",
      };
    }
    return {
      ok: true,
      value: { kind: "complete", reason: (c as { reason: string }).reason },
    };
  }

  if (o.steps !== undefined) {
    if (!isStrArr(o.steps) || o.steps.length === 0) {
      return { ok: false, error: "steps must be a non-empty array of strings" };
    }
    if (o.steps.length > 2)
      return { ok: false, error: "steps must have at most 2 entries" };
    let subgoals: SubgoalSpec | undefined;
    if (o.subgoals !== undefined) {
      const s = o.subgoals;
      if (typeof s !== "object" || s === null || Array.isArray(s)) {
        return { ok: false, error: "subgoals must be an object" };
      }
      const so = s as Record<string, unknown>;
      for (const k of ["add", "done", "drop"] as const) {
        if (so[k] !== undefined && !isStrArr(so[k])) {
          return {
            ok: false,
            error: `subgoals.${k} must be an array of strings`,
          };
        }
      }
      subgoals = {
        add: so.add as string[] | undefined,
        done: so.done as string[] | undefined,
        drop: so.drop as string[] | undefined,
      };
    }
    return { ok: true, value: { kind: "steps", steps: o.steps, subgoals } };
  }

  if (Object.keys(o).length === 0) return { ok: true, value: { kind: "none" } };
  return {
    ok: false,
    error: `unknown decide payload keys: ${Object.keys(o).join(", ")}`,
  };
}

// ---------------------------------------------------------------- execute/conclude parsing

export function parseExecuteOutput(text: string): ParseResult<ExecuteOutput> {
  const raw = extractJson(text);
  if (raw === null) return { ok: false, error: "no JSON object found" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "JSON is not an object" };
  }
  const o = raw as Record<string, unknown>;

  if (o.accepted === false) {
    if (!isStr(o.reason))
      return { ok: false, error: "rejected payload requires a reason string" };
    return { ok: true, value: { kind: "rejected", reason: o.reason } };
  }
  if (o.accepted !== true)
    return { ok: false, error: "accepted must be true or false" };

  const d = o.data;
  if (typeof d !== "object" || d === null || Array.isArray(d)) {
    return { ok: false, error: "data must be an object" };
  }
  const dobj = d as Record<string, unknown>;
  if (!isStr(dobj.description)) {
    return { ok: false, error: "data.description must be a non-empty string" };
  }
  const findings: Finding[] = [];
  if (dobj.findings !== undefined) {
    if (!Array.isArray(dobj.findings))
      return { ok: false, error: "data.findings must be an array" };
    for (const f of dobj.findings) {
      if (
        typeof f !== "object" ||
        f === null ||
        !isStr((f as Record<string, unknown>).title) ||
        !isStr((f as Record<string, unknown>).evidence)
      ) {
        return {
          ok: false,
          error: "each finding needs title and evidence strings",
        };
      }
      findings.push({
        title: (f as { title: string }).title,
        evidence: (f as { evidence: string }).evidence,
      });
    }
  }
  return {
    ok: true,
    value: { kind: "accepted", description: dobj.description, findings },
  };
}
