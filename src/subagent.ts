/**
 * subagent.ts — headless sub-session wrapper (PLAN.md §7, D1/D2/D4).
 *
 * One sub-session = one pi AgentSession: original Cairn tool whitelist,
 * host extensions/skills masked, independent model, hard timeout via abort,
 * last assistant message text returned for protocol parsing.
 * Conclude reuses the SAME session (D2): pass `session` to re-prompt it.
 */

import { homedir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Model, TextContent } from "@earendil-works/pi-ai/compat";

type AnyModel = Model<any>;

/** Original Cairn pi adapter tool whitelist (D1: zero custom tools). */
export const TOOL_WHITELIST = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
];

export interface SubSessionEvent {
  type: string;
  detail?: string;
}

export interface SubSessionResult {
  /** Last assistant message text (may be empty on hard failure). */
  text: string;
  /** True when the hard timeout fired and the session was aborted. */
  timedOut: boolean;
  /** Error message if the prompt run itself failed (network/model error). */
  error?: string;
  /** The session (so conclude can reuse it / engine can dispose it). */
  session: AgentSession;
}

export interface RunSubSessionOptions {
  phase: "decide" | "execute" | "conclude";
  prompt: string;
  /** Sub-session working directory (cairn workspace). */
  workspace: string;
  /** "provider/model-id", e.g. "qwen/qwen-27b". */
  modelRef: string;
  timeoutMs: number;
  onEvent?: (e: SubSessionEvent) => void;
  /** Reuse an existing session (conclude on the same session, D2). */
  session?: AgentSession;
  /**
   * When true, a session created here is NOT disposed at exit — the caller
   * owns it (engine reuses the execute session for conclude, then disposes).
   */
  keepSession?: boolean;
  /** External abort (e.g. /cairn abort): polled on every event. */
  abortSignal?: { aborted: boolean };
}

let modelRuntime: ModelRuntime | undefined;
async function resolveModel(ref: string): Promise<AnyModel> {
  if (!modelRuntime) modelRuntime = await ModelRuntime.create();
  const [provider, ...rest] = ref.split("/");
  const id = rest.join("/");
  if (!provider || !id)
    throw new Error(`bad modelRef "${ref}" (want provider/model-id)`);
  const model = modelRuntime.getModel(provider, id);
  if (!model)
    throw new Error(`model not found: ${ref} (check ~/.pi/agent/models.json)`);
  return model;
}

/** Mask host extensions/skills/templates/themes/context files (D4: no recursion). */
async function makeResourceLoader(
  workspace: string,
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: `${homedir()}/.pi/agent`,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return loader;
}

function lastAssistantText(session: AgentSession): string {
  const msgs = session.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as {
      role?: string;
      content?: string | (TextContent | { type: string })[];
    };
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    return (m.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b as TextContent).text)
      .join("\n");
  }
  return "";
}

function summarize(event: {
  type: string;
  [k: string]: unknown;
}): string | undefined {
  switch (event.type) {
    case "tool_execution_start":
      return String((event as { toolName?: string }).toolName ?? "");
    case "tool_execution_end":
      return String((event as { toolName?: string }).toolName ?? "");
    case "message_start":
    case "message_end":
      return undefined;
    default:
      return undefined;
  }
}

export async function runSubSession(
  opts: RunSubSessionOptions,
): Promise<SubSessionResult> {
  const created = !opts.session;
  let session = opts.session;
  if (!session) {
    const model = await resolveModel(opts.modelRef);
    const resourceLoader = await makeResourceLoader(opts.workspace);
    const { session: s } = await createAgentSession({
      cwd: opts.workspace,
      model,
      tools: TOOL_WHITELIST,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.create(opts.workspace),
    });
    session = s;
  }

  const unsubscribe = session.subscribe((event) => {
    if (opts.abortSignal?.aborted) void session.abort();
    opts.onEvent?.({ type: event.type, detail: summarize(event) });
  });

  let timedOut = false;
  let error: string | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    void session?.abort();
  }, opts.timeoutMs);
  try {
    await session.prompt(opts.prompt);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
    unsubscribe();
    if (created && !opts.keepSession) session?.dispose();
  }

  return { text: lastAssistantText(session), timedOut, error, session };
}
