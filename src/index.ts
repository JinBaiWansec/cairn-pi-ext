/**
 * index.ts — pi extension entry (PLAN.md §5).
 *
 *   /cairn run <origin> <goal>  -> start engine in background (D3), UI server
 *   /cairn abort                -> request graceful abort
 *   /cairn status               -> last log lines
 *
 * UI server (node:http, port 8377 / CAIRN_UI_PORT):
 *   GET  /        -> ui/index.html (single file, polls /graph every 2s)
 *   GET  /graph   -> fgs.json contents (fresh read per request)
 *   POST /hints   -> {"text": "..."} appended to the engine's live graph
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CairnEngine, DEFAULTS, startEngine } from "./engine.js";
import { FgsGraph } from "./graph.js";

const PORT = Number(process.env.CAIRN_UI_PORT ?? 8377);

// env overrides for verification (PLAN §9) and per-deployment tuning.
function envCfg(): typeof DEFAULTS {
  const num = (k: string, d: number) => {
    const v = process.env[k];
    return v && !Number.isNaN(Number(v)) ? Number(v) : d;
  };
  return {
    ...DEFAULTS,
    decideModel: process.env.CAIRN_DECIDE_MODEL ?? DEFAULTS.decideModel,
    executeModel: process.env.CAIRN_EXECUTE_MODEL ?? DEFAULTS.executeModel,
    maxExecutes: num("CAIRN_MAX_EXECUTES", DEFAULTS.maxExecutes),
    decideTimeoutMs: num("CAIRN_DECIDE_TIMEOUT_MS", DEFAULTS.decideTimeoutMs),
    executeTimeoutMs: num(
      "CAIRN_EXECUTE_TIMEOUT_MS",
      DEFAULTS.executeTimeoutMs,
    ),
    concludeTimeoutMs: num(
      "CAIRN_CONCLUDE_TIMEOUT_MS",
      DEFAULTS.concludeTimeoutMs,
    ),
    dormancyMs: num("CAIRN_DORMANCY_MS", DEFAULTS.dormancyMs),
  };
}
const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "ui");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Serve a GET path from the ui/ directory (e.g. /cytoscape.min.js). */
function serveStatic(url: string, res: ServerResponse): boolean {
  const p = resolve(join(UI_DIR, url));
  if (!p.startsWith(UI_DIR) || !existsSync(p) || !statSync(p).isFile())
    return false;
  res.writeHead(200, {
    "content-type": MIME[extname(p)] ?? "application/octet-stream",
  });
  res.end(readFileSync(p));
  return true;
}

let uiServer: Server | null = null;
let uiPort = PORT;
const logRing: string[] = [];
/** Engine lifecycle state exposed to the UI via GET /status. */
const engineState = { running: false, reason: null as string | null };

function uiUrl(): string {
  return `http://127.0.0.1:${uiPort}/`;
}

function rememberLog(line: string): void {
  logRing.push(line);
  if (logRing.length > 50) logRing.shift();
  console.log(line);
}

export function setUiWorkspace(p: string): void {
  uiWorkspace = p;
}

export function closeUiServer(): void {
  if (!uiServer) return;
  uiServer.close();
  uiServer = null;
  rememberLog("[cairn] ui server stopped");
}

export function ensureUiServer(graph: FgsGraph): void {
  if (uiServer) return;
  uiServer = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    try {
      if (req.method === "GET" && (url === "/" || url === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(join(UI_DIR, "index.html"), "utf8"));
      } else if (req.method === "GET" && url === "/graph") {
        const g = FgsGraph.peek(uiWorkspace);
        res.writeHead(g ? 200 : 404, { "content-type": "application/json" });
        res.end(g ? JSON.stringify(g) : "null");
      } else if (req.method === "POST" && url === "/hints") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const { text } = JSON.parse(body || "{}") as { text?: unknown };
            if (typeof text !== "string" || !text.trim())
              throw new Error('body must be {"text": "<non-empty>"}');
            graph.injectHint(text.trim());
            rememberLog(`[cairn] hint injected: ${text.slice(0, 80)}`);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(e) }));
          }
        });
      } else if (req.method === "GET" && url === "/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            running: engineState.running,
            reason: engineState.reason,
            port: uiPort,
          }),
        );
      } else if (req.method === "GET" && url === "/log") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(logRing.slice(-100)));
      } else if (req.method === "POST" && url === "/abort") {
        const eng = CairnEngine.running;
        if (eng) {
          eng.abort();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "no cairn engine running" }));
        }
      } else if (req.method === "GET" && serveStatic(url, res)) {
        // served above
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  uiServer.on("error", (e) =>
    rememberLog(`[cairn] ui server error: ${e.message} (engine unaffected)`),
  );
  uiServer.listen(PORT, () => {
    uiPort = (uiServer?.address() as { port: number }).port;
    rememberLog(`[cairn] ui server at ${uiUrl()}`);
  });
}

// workspace of the live graph: /graph peeks the file, /hints mutates the
// engine's in-memory instance (single writer, so no stale-copy race).
let uiWorkspace = "";

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
      const resumed = FgsGraph.exists(workspace);
      uiWorkspace = workspace;
      // Rebind the UI server to this run's graph instance (the previous
      // run's /hints closure would otherwise mutate a stale copy).
      closeUiServer();

      const started = startEngine(
        {
          ...envCfg(),
          workspace,
          onWidget: (lines) => ctx.ui.setWidget("cairn", lines),
          onLog: rememberLog,
        },
        origin,
        goal,
      );
      ensureUiServer(started.graph);
      engineState.running = true;
      engineState.reason = null;

      ctx.ui.notify(
        resumed
          ? `cairn RESUMED (existing fgs.json) | graph: ${uiUrl()}`
          : `cairn started | graph: ${uiUrl()}`,
        "info",
      );

      // D3: return immediately; the engine runs in the background.
      void started.done.then((reason) => {
        engineState.running = false;
        engineState.reason = reason;
        ctx.ui.notify(`cairn finished: reason=${reason}`, "info");
        ctx.ui.setWidget("cairn", [
          `cairn ended reason=${reason} | ui: ${uiUrl()} | logs: /cairn status`,
        ]);
        // Keep the UI server open so the final graph can be reviewed;
        // the next /cairn run rebinds it (closeUiServer above).
      });
    },
  });

  // PLAN §7: at session_start, hint that an existing workspace can resume.
  pi.on("session_start", (_event, ctx) => {
    if (FgsGraph.exists(resolve(ctx.cwd, "cairn-workspace")))
      ctx.ui.notify(
        "cairn: workspace exists — /cairn run will RESUME it",
        "info",
      );
  });
}
