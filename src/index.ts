/**
 * index.ts — pi extension entry (carin_plan §2.1, Step 7 重写).
 *
 *   /cairn run <origin> <goal>  -> start engine in background + UI server
 *   /cairn abort                -> request graceful abort
 *   /cairn status               -> last log lines
 *
 * UI server (node:http, 0.0.0.0:8377 / CAIRN_UI_HOST+CAIRN_UI_PORT):
 *   GET  /                      -> 302 /ext/cairn/
 *   GET  /ext/cairn/*           -> ui/ 构建产物（SPA fallback；assets/ = immutable）
 *   GET  /ext/cairn/api/graph|status|transcript|file
 *   GET  /ext/cairn/api/events  -> SSE（transcript/graph/status 三源广播，D3/D4）
 *   POST /ext/cairn/api/ops|branch|checkout
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CairnEngine,
  startEngine,
  type RunMeta,
} from "./engine.js";
import { loadConfig } from "./config.js";
import { GraphOps } from "./graphops.js";
import {
  onTranscriptEvent,
  readTranscript,
  type TranscriptEvent,
} from "./transcript.js";
import type { FGSGraph } from "./graph.js";

const HOST = process.env.CAIRN_UI_HOST ?? "0.0.0.0";
const PORT = Number(process.env.CAIRN_UI_PORT ?? 8377);
const PREFIX = "/ext/cairn";
const MB = 1024 * 1024;

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "ui");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** 带状态码的端点错误（400 参数 / 404 资源 / 409 状态冲突） */
class HttpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------- 路由件

/** /ext/cairn/<rest> → ui/ 产物；无扩展名缺失 → SPA fallback（index.html no-cache） */
function serveUi(rest: string, res: ServerResponse): void {
  const rel = decodeURIComponent(rest.replace(/^\//, ""));
  const p = resolve(join(UI_DIR, rel));
  if (!p.startsWith(UI_DIR)) {
    sendJson(res, 400, { error: "bad path" });
    return;
  }
  if (existsSync(p) && statSync(p).isFile()) {
    const headers: Record<string, string> = {
      "content-type": MIME[extname(p)] ?? "application/octet-stream",
      // hash 名产物 = immutable；index.html 等入口 = no-cache
      "cache-control": p.startsWith(join(UI_DIR, "assets") + sep)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    };
    res.writeHead(200, headers);
    res.end(readFileSync(p));
    return;
  }
  if (extname(p) !== "") {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
  });
  res.end(readFileSync(join(UI_DIR, "index.html"), "utf8"));
}

/** D8：run.json 新鲜读取 + engine 活体字段 → Status（null = 无 run.json → 404） */
function buildStatus(
  runDir: string,
  ops: GraphOps,
  engine: CairnEngine,
): Record<string, unknown> | null {
  const f = join(runDir, "run.json");
  if (!existsSync(f)) return null;
  let m: RunMeta;
  try {
    m = JSON.parse(readFileSync(f, "utf8")) as RunMeta;
  } catch (e) {
    // 半写 → 500（§7：UI setOffline 下轮自愈）
    throw new HttpError(
      500,
      `run.json unreadable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const active = ops.headGraph().steps.find((s) => s.status === "in_progress");
  return {
    running: engine.running,
    // 无活引擎时这是磁盘快照（旧 run 的遗留值可能失真）——UI 据此显示离线态
    ...(engine.running ? {} : { stale: true }),
    state: m.state,
    endReason: m.endReason,
    activeBranch: ops.data.activeBranch,
    rev: ops.activeBranch.head,
    goal: m.goal,
    ...(active ? { activeStepId: active.id } : {}),
    budget: {
      executes: m.budget.executes,
      decides: m.budget.decides,
      // 活引擎：报实时 cfg（磁盘 m.config 是上一轮 run 的旧值）；无引擎：报磁盘值
      maxExecutes: engine.running ? loadConfig().maxExecutes : m.config.maxExecutes,
    },
    usage: m.usage,
    elapsedMs: m.endedAt
      ? m.endedAt - m.startedAt
      : Date.now() - m.startedAt,
    ...(engine.currentActivityId
      ? { currentActivityId: engine.currentActivityId }
      : {}),
  };
}

/** D7 add_hint：h-N 编号逻辑（原 /hints 端点抽出） */
function addHint(ops: GraphOps, text: string): void {
  ops.applyOp("add_hint", "user", (draft: FGSGraph) => {
    const n =
      draft.hints.reduce((m, h) => Math.max(m, Number(h.id.slice(2)) || 0), 0) + 1;
    draft.hints.push({ id: `h-${n}`, text, status: "active" });
  });
}

function handleGet(
  runDir: string,
  ops: GraphOps,
  engine: CairnEngine,
  rest: string,
  q: URLSearchParams,
  res: ServerResponse,
): void {
  switch (rest) {
    case "/api/graph": {
      const f = join(runDir, "fgs.json");
      if (!existsSync(f)) throw new HttpError(404, "no fgs.json");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(readFileSync(f, "utf8"));
      return;
    }
    case "/api/status": {
      const s = buildStatus(runDir, ops, engine);
      if (!s) throw new HttpError(404, "no run.json (never run)");
      sendJson(res, 200, s);
      return;
    }
    case "/api/transcript": {
      const activity = q.get("activity");
      if (!activity) throw new HttpError(400, "missing activity");
      const offset = Number(q.get("offset") ?? 0) || 0;
      let page: { events: TranscriptEvent[]; nextOffset: number };
      try {
        page = readTranscript(runDir, activity, offset);
      } catch (e) {
        throw new HttpError(404, e instanceof Error ? e.message : String(e));
      }
      sendJson(res, 200, page);
      return;
    }
    case "/api/file": {
      const rel = q.get("path");
      if (!rel) throw new HttpError(400, "missing path");
      const p = resolve(runDir, rel);
      const notes = join(runDir, "notes") + sep;
      if (!p.startsWith(notes))
        throw new HttpError(400, "path outside notes/");
      if (!existsSync(p)) throw new HttpError(404, "no such file");
      const buf = readFileSync(p);
      const offset = Number(q.get("offset") ?? 0) || 0;
      sendJson(res, 200, {
        content: buf.subarray(offset, offset + MB).toString("utf8"),
        size: buf.length,
      });
      return;
    }
    case "/api/events": {
      // D4：连接池 + 心跳（25s）；新连接不发历史（UI onopen 自对账）
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "connection": "keep-alive",
        "cache-control": "no-cache",
      });
      res.flushHeaders(); // Node 24：writeHead 不主动发头，首帧/心跳前必须显式 flush
      const clients = sseClients!;
      clients.add(res);
      res.on("close", () => clients.delete(res));
      return;
    }
    default:
      throw new HttpError(404, `no route ${rest}`);
  }
}

/** D4：SSE 连接池（handleGet 内引用；startCairnServer 注入） */
let sseClients: Set<ServerResponse> | null = null;

function handlePost(
  ops: GraphOps,
  engine: CairnEngine,
  rest: string,
  req: import("node:http").IncomingMessage,
  res: ServerResponse,
): void {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      switch (rest) {
        case "/api/ops": {
          const op = parsed.op;
          const args = (parsed.args ?? {}) as Record<string, unknown>;
          if (op === "add_hint") {
            const text = args.text;
            if (typeof text !== "string" || !text.trim())
              throw new HttpError(400, "args.text must be non-empty");
            addHint(ops, text.trim());
          } else if (op === "abort" || op === "pause" || op === "resume") {
            if (!engine.running)
              throw new HttpError(409, "no cairn engine running");
            engine[op]();
          } else {
            throw new HttpError(400, `unknown op ${String(op)}`);
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        case "/api/branch": {
          const name = parsed.name;
          if (typeof name !== "string" || !name.trim())
            throw new HttpError(400, "name required");
          try {
            ops.forkBranch(
              name.trim(),
              parsed.from as string | undefined,
              parsed.at as string | undefined,
            );
          } catch (e) {
            throw new HttpError(
              400,
              e instanceof Error ? e.message : String(e),
            );
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        case "/api/checkout": {
          const branch = parsed.branch;
          if (typeof branch !== "string" || !branch.trim())
            throw new HttpError(400, "branch required");
          try {
            ops.checkout(branch.trim());
          } catch (e) {
            throw new HttpError(
              400,
              e instanceof Error ? e.message : String(e),
            );
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        default:
          throw new HttpError(404, `no route ${rest}`);
      }
    } catch (e) {
      if (e instanceof HttpError) sendJson(res, e.code, { error: e.message });
      else sendJson(res, 500, { error: String(e) });
    }
  });
}

// ---------------------------------------------------------------- server

export interface CairnServerHandle {
  port: number;
  close: () => void;
}

/** 当前存活 server（/cairn run 重绑定前 close 旧实例） */
let live: CairnServerHandle | null = null;

/** D11：/cairn run 与测试共用同一装配；HTTP 层不依赖 ExtensionAPI。 */
export function startCairnServer(opts: {
  runDir: string;
  ops: GraphOps;
  engine: CairnEngine;
  port?: number;
}): Promise<CairnServerHandle> {
  const { runDir, ops, engine } = opts;
  const clients = new Set<ServerResponse>();
  sseClients = clients;

  // D4：写失败 = 慢消费者，直接丢弃该连接（无背压队列）
  const broadcast = (frame: unknown): void => {
    const data = `data: ${JSON.stringify(frame)}\n\n`;
    for (const r of clients) {
      try {
        r.write(data);
      } catch {
        clients.delete(r);
      }
    }
  };
  // D3：三源订阅
  onTranscriptEvent((ev: TranscriptEvent) =>
    broadcast({ type: "transcript", event: ev }),
  );
  ops.onGraphChange((rev, branch) => broadcast({ type: "graph", rev, branch }));
  engine.onStatus(() => {
    const s = buildStatus(runDir, ops, engine);
    if (s) broadcast({ type: "status", status: s });
  });
  const heartbeat = setInterval(() => {
    for (const r of clients) {
      try {
        r.write(": ping\n\n");
      } catch {
        clients.delete(r);
      }
    }
  }, 25_000);

  const server: Server = createServer((req, res) => {
    const raw = req.url ?? "/";
    const path = raw.split("?")[0];
    try {
      if (path === "/") {
        res.writeHead(302, { location: `${PREFIX}/` });
        res.end();
        return;
      }
      if (!path.startsWith(PREFIX)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const rest = path.slice(PREFIX.length);
      if (rest.startsWith("/api/")) {
        if (req.method === "GET") {
          handleGet(
            runDir,
            ops,
            engine,
            rest,
            new URLSearchParams(raw.split("?")[1] ?? ""),
            res,
          );
          return;
        }
        if (req.method === "POST") {
          return handlePost(ops, engine, rest, req, res);
        }
        res.writeHead(405);
        res.end();
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return;
      }
      serveUi(rest, res);
    } catch (e) {
      sendJson(
        res,
        e instanceof HttpError ? e.code : 500,
        { error: e instanceof Error ? e.message : String(e) },
      );
    }
  });
  server.on("error", (e) =>
    rememberLog(`[cairn] ui server error: ${e.message} (engine unaffected)`),
  );

  const close = (): void => {
    clearInterval(heartbeat);
    for (const r of clients) r.end();
    clients.clear();
    server.close();
    server.closeAllConnections(); // SSE 长连接不得拖住进程退出
    if (live === handle) live = null;
    rememberLog("[cairn] ui server stopped");
  };

  const handle: CairnServerHandle = { port: 0, close };
  return new Promise((ok, err) => {
    server.once("error", (e: NodeJS.ErrnoException) =>
      err(
        e.code === "EADDRINUSE"
          ? new Error(
              `cairn UI 端口 ${opts.port ?? PORT} 被占用（另一个 pi 会话的扩展先绑定了）——本会话 /cairn 命令仍可用，但 UI/API 不可用`,
            )
          : e,
      ),
    );
    server.listen(opts.port ?? PORT, HOST, () => {
      handle.port = (server.address() as { port: number }).port;
      ok(handle);
    });
  });
}

// ---------------------------------------------------------------- 命令层

const logRing: string[] = [];

function rememberLog(line: string): void {
  logRing.push(line);
  if (logRing.length > 50) logRing.shift();
  console.log(line);
}

function uiUrl(): string {
  return `http://127.0.0.1:${live?.port ?? PORT}${PREFIX}/`;
}

export default function cairnExtension(pi: ExtensionAPI): void {
  pi.registerCommand("cairn", {
    description:
      "FGS pentest engine. /cairn run <origin> <goal> | /cairn abort | /cairn status",
    handler: async (args: string, ctx) => {
      // quote-aware tokenization: pi passes the raw command string (no shell)
      const tokens: string[] = [];
      {
        let cur = "",
          q: string | null = null;
        for (const c of args) {
          if (q) {
            if (c === q) q = null;
            else cur += c;
          } else if (c === '"' || c === "'") q = c;
          else if (c === " " || c === "\t") {
            if (cur) {
              tokens.push(cur);
              cur = "";
            }
          } else cur += c;
        }
        if (cur) tokens.push(cur);
      }
      const [sub, ...rest] = tokens;

      if (sub !== "run" && sub !== "abort" && sub !== "status" && sub) {
        ctx.ui.notify(
          `unknown subcommand "${sub}" (run <origin> <goal> | abort | status)`,
          "warning",
        );
        return;
      }

      if (sub === "abort") {
        const eng = CairnEngine.running;
        if (!eng) {
          ctx.ui.notify("no cairn engine running", "info");
          return;
        }
        eng.abort();
        ctx.ui.notify(
          "cairn abort requested (current sub-session stops at next event)",
          "info",
        );
        return;
      }

      if (sub === "status") {
        const lines = logRing.slice(-15);
        ctx.ui.setWidget(
          "cairn",
          lines.length ? lines : ["cairn: no logs yet"],
        );
        return;
      }

      if (sub !== "run") {
        ctx.ui.notify("usage: /cairn run <origin> <goal>", "warning");
        return;
      }

      const origin = rest[0];
      const goal = rest.slice(1).join(" ");
      if (!origin || !goal) {
        ctx.ui.notify("usage: /cairn run <origin> <goal>", "warning");
        return;
      }
      if (CairnEngine.running) {
        ctx.ui.notify(
          "cairn engine already running (use /cairn abort first)",
          "warning",
        );
        return;
      }

      const workspace = resolve(ctx.cwd, "cairn-workspace");
      const resumed = GraphOps.exists(workspace);
      live?.close(); // 重绑定（旧 run 的 ops 闭包不得存活）

      let started;
      try {
        started = startEngine(
          {
            runDir: workspace,
            cfg: loadConfig(),
            onWidget: (lines) => ctx.ui.setWidget("cairn", lines),
            onLog: rememberLog,
            onBanner: (text) => ctx.ui.notify(text, "warning"),
          },
          origin,
          goal,
        );
      } catch (e) {
        ctx.ui.notify(
          `cairn start failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
        return;
      }
      try {
        live = await startCairnServer({
          runDir: workspace,
          ops: started.ops,
          engine: started.engine,
        });
      } catch (e) {
        rememberLog(
          `[cairn] ui server failed: ${e instanceof Error ? e.message : String(e)} (engine unaffected)`,
        );
      }

      ctx.ui.notify(
        resumed
          ? `cairn RESUMED | workspace: ${workspace} | console: ${uiUrl()}`
          : `cairn started | workspace: ${workspace} | console: ${uiUrl()}`,
        "info",
      );

      // D3: return immediately; the engine runs in the background.
      void started.done.then((reason) => {
        ctx.ui.notify(`cairn finished: reason=${reason}`, "info");
        ctx.ui.setWidget("cairn", [
          `cairn ended reason=${reason} | ui: ${uiUrl()} | logs: /cairn status`,
        ]);
        // Keep the UI server open so the final graph can be reviewed;
        // the next /cairn run rebinds it (live?.close() above).
      });
    },
  });

  // PLAN §7: at session_start, hint that an existing workspace can resume.
  pi.on("session_start", (_event, ctx) => {
    const ws = resolve(ctx.cwd, "cairn-workspace");
    if (!GraphOps.exists(ws)) return;
    ctx.ui.notify(
      "cairn: workspace exists — /cairn run will RESUME it",
      "info",
    );
    // UI 常开：无活 server 时先挂「离线快照」模式（磁盘 fgs/run.json + status.stale=true），
    // 避免两次 run 之间 8377 无人监听、UI 看起来像被新建
    if (!live) {
      startCairnServer({
        runDir: ws,
        ops: GraphOps.load(ws),
        // SAFETY: 离线快照桩——HTTP 层只读 engine.running（false）/currentActivityId（undefined），订阅类方法 no-op
        engine: {
          running: false,
          onTranscriptEvent: () => {},
          onStatus: () => {},
        } as unknown as CairnEngine,
      })
        .then((h) => {
          if (live) h.close(); // /cairn run 抢先绑定过 → 弃掉本实例
          else {
            live = h;
            rememberLog(
              `[cairn] ui attached (offline snapshot): port ${h.port}`,
            );
          }
        })
        .catch((e) =>
          rememberLog(
            `[cairn] ui attach failed: ${e instanceof Error ? e.message : e}`,
          ),
        );
    }
  });
}
