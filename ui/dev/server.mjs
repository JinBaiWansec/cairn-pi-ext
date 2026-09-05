// dev/server.mjs — 静态托管 ui/ 构建产物 + mock /api/* + 假 SSE（?live=1 回放 fixture）
// 用法：node ui/dev/server.mjs  →  http://localhost:8477/?live=1
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), ".."); // ui/
const FIX = join(ROOT, "dev", "fixtures");
const PORT = 8477;
const MB = 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readAll(p) {
  return readFileSync(p, "utf8");
}

// /api/transcript：按字节 offset 切 JSONL，只返回完整行
function transcriptPage(activity, offset) {
  const files = readdirSync(FIX).filter((f) => f.startsWith(`${activity}-`) && f.endsWith(".jsonl"));
  if (files.length === 0) return null;
  const buf = readFileSync(join(FIX, files[0]));
  let start = Math.max(0, Math.min(offset | 0, buf.length));
  let end = buf.indexOf("\n", start);
  const events = [];
  while (end !== -1) {
    try {
      events.push(JSON.parse(buf.slice(start, end)));
    } catch {
      /* 半行丢弃 */
    }
    start = end + 1;
    end = buf.indexOf("\n", start);
  }
  return { events, nextOffset: end === -1 ? buf.length : end + 1, full: end === -1 ? buf.length : start };
}

const T0 = Date.now();

function statusBody() {
  return {
    running: true,
    state: "running",
    endReason: null,
    activeStepId: "s-02",
    activeBranch: "main",
    rev: "rev-3",
    budget: { executes: 3, decides: 2, maxExecutes: 8, maxDecides: 3 },
    usage: { input: 9800, output: 2120, totalTokens: 11920, costTotal: 0.04 },
    elapsedMs: Date.now() - T0,
    currentActivityId: "act-002",
    env: "mock", // S10：mock 专属
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === "/api/graph") {
    try {
      return json(res, 200, JSON.parse(readAll(join(FIX, "graph.json"))));
    } catch {
      return json(res, 500, { error: "fixtures/graph.json unreadable" });
    }
  }
  if (p === "/api/status") return json(res, 200, statusBody());
  if (p === "/api/transcript") {
    const page = transcriptPage(url.searchParams.get("activity") ?? "", parseInt(url.searchParams.get("offset") ?? "0", 10));
    if (!page) return json(res, 404, { error: `unknown activity ${url.searchParams.get("activity")}` });
    const { full, ...rest } = page;
    void full;
    return json(res, 200, rest);
  }
  if (p === "/api/file") {
    const rel = normalize(url.searchParams.get("path") ?? "");
    if (rel.startsWith("..") || rel.startsWith("/")) return json(res, 400, { error: "bad path" });
    const abs = join(FIX, rel);
    try {
      const buf = readFileSync(abs);
      const size = statSync(abs).size;
      return json(res, 200, { content: size > MB ? buf.subarray(0, MB).toString() : buf.toString(), size });
    } catch {
      return json(res, 404, { error: `no such file ${rel}` });
    }
  }
  if (p === "/api/ops" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => json(res, 200, { ok: true, echo: safeJson(body) }));
    return;
  }
  if (p === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    const beat = setInterval(() => res.write(": hb\n\n"), 15000);
    if (url.searchParams.get("live") === "1") replayLive(res);
    req.on("close", () => clearInterval(beat));
    return;
  }

  // 静态（构建产物在 ui/ 根）
  const file = p === "/" ? "index.html" : p.slice(1);
  try {
    const buf = readFileSync(join(ROOT, file));
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(join(ROOT, "index.html")));
  }
});

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ?live=1：500ms 间隔回放 act-002 transcript，随后推 graph 事件（rev-3）+ status 事件
function replayLive(res) {
  const lines = [];
  for (const l of readAll(join(FIX, "act-002-execute-s-01.jsonl")).split("\n")) {
    if (!l) continue;
    try {
      lines.push(JSON.parse(l));
    } catch {
      /* 坏行跳过 */
    }
  }
  lines.forEach((ev, i) => {
    setTimeout(() => res.write(`data: ${JSON.stringify({ type: "transcript", event: ev })}\n\n`), (i + 1) * 500);
  });
  setTimeout(
    () => res.write(`data: ${JSON.stringify({ type: "graph", rev: "rev-3", branch: "main" })}\n\n`),
    (lines.length + 2) * 500,
  );
  setTimeout(() => res.write(`data: ${JSON.stringify({ type: "status", status: statusBody() })}\n\n`), (lines.length + 3) * 500);
}

server.listen(PORT, () => console.log(`cairn dev mock → http://localhost:${PORT}/?live=1`));
