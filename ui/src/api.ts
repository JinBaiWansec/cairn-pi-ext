// api.ts — fetch 封装 + SSE 客户端（D3 自动 base；onerror 指数退避 1/2/4/8s 重连；
// SSE 断线降级 3s 轮询兜底；S21 页面隐藏降频；S9 连接态写 status 切片）
import { useActivity } from "./store/activity";
import { useGraph } from "./store/graph";
import { useStatus } from "./store/status";
import type { FileContent, FGSFile, SseEvent, Status, TranscriptPage } from "./types";

// D3：双部署路径——dev 根路径 / 子路径 /ext/cairn/*
export const API_BASE = location.pathname.startsWith("/ext/cairn") ? "/ext/cairn/api" : "/api";

async function j<T>(p: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API_BASE + p, init);
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

export const getGraph = (): Promise<FGSFile> => j("/graph");
export const getStatus = (): Promise<Status> => j("/status");
export const getTranscript = (activity: string, offset: number): Promise<TranscriptPage> =>
  j(`/transcript?activity=${encodeURIComponent(activity)}&offset=${offset}`);
export const getFile = (path: string): Promise<FileContent> =>
  j(`/file?path=${encodeURIComponent(path)}`);
export const postOp = (op: string, args: Record<string, unknown>): Promise<{ ok: boolean }> =>
  j("/ops", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, args }),
  });

// ── 刷新入口（组件重试按钮也走这里）─────────────────────────────
export function refreshGraph(): Promise<void> {
  return getGraph()
    .then((f) => useGraph.getState().applyFile(f))
    .catch((e: Error) => useGraph.getState().setError(e.message));
}

export function refreshStatus(): Promise<void> {
  return getStatus()
    .then((s) => useStatus.getState().apply(s))
    .catch(() => useStatus.getState().setOffline(true));
}

export function fetchTranscriptFrom(id: string, offset?: number): Promise<void> {
  const st = useActivity.getState().acts[id];
  const off = offset ?? st?.nextOffset ?? 0;
  useActivity.getState().setLoading(id, true);
  return getTranscript(id, off)
    .then((page: TranscriptPage) => {
      const a = useActivity.getState();
      for (const ev of page.events) {
        useStatus.getState().touch();
        a.append(id, ev);
      }
      a.setOffset(id, page.nextOffset, true);
      a.setLoadError(id, null);
    })
    .catch((e: Error) => useActivity.getState().setLoadError(id, e.message))
    .finally(() => useActivity.getState().setLoading(id, false));
}

// ── SSE 分派 ────────────────────────────────────────────────
function dispatch(ev: SseEvent): void {
  if (ev.type === "transcript") {
    useStatus.getState().touch();
    const a = useActivity.getState();
    a.ensure(ev.event.activityId, ev.event.kind, ev.event.stepId);
    a.append(ev.event.activityId, ev.event);
  } else if (ev.type === "graph") {
    void refreshGraph();
  } else {
    useStatus.getState().apply(ev.status);
  }
}

// ── 轮询兜底（3s）────────────────────────────────────────────
let pollTimer: number | null = null;

function pollTick(): void {
  void refreshStatus();
  void refreshGraph();
  const a = useActivity.getState();
  const cur = a.current ?? a.order[a.order.length - 1];
  if (cur && a.acts[cur]) void fetchTranscriptFrom(cur);
}

function setPolling(on: boolean): void {
  if (on && pollTimer === null) {
    pollTimer = window.setInterval(pollTick, 3000);
    pollTick();
  }
  if (!on && pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── SSE 连接（指数退避重连）────────────────────────────────────
let es: EventSource | null = null;
let retryTimer: number | null = null;
let backoff = 1000;

function openEs(): void {
  es?.close();
  const q = location.search.includes("live=1") ? "?live=1" : "";
  es = new EventSource(API_BASE + "/events" + q);
  es.onopen = () => {
    backoff = 1000;
    useStatus.getState().setConn("live");
    setPolling(false); // 重连成功 → 对账
    void refreshGraph();
    void refreshStatus();
  };
  es.onmessage = (m) => {
    try {
      dispatch(JSON.parse(m.data) as SseEvent);
    } catch {
      /* 坏帧丢弃 */
    }
  };
  es.onerror = () => {
    es?.close();
    es = null;
    useStatus.getState().setConn("polling");
    setPolling(true);
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (retryTimer !== null) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    if (!document.hidden) openEs();
  }, backoff);
  backoff = Math.min(backoff * 2, 8000);
}

// S21：页面隐藏 → 断 SSE、停轮询（降频）；visible → 重连
function onVisibility(): void {
  if (document.hidden) {
    es?.close();
    es = null;
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    setPolling(false);
  } else {
    openEs();
  }
}

// ── 启动（main.tsx 调一次）────────────────────────────────────
export function start(): void {
  void refreshGraph();
  void refreshStatus().then(() => {
    const cur = useStatus.getState().status?.currentActivityId;
    if (cur) {
      useActivity.getState().ensure(cur);
      void fetchTranscriptFrom(cur, 0);
    }
  });
  // S3：5s 心跳驱动 STALLED/elapsed 重渲染
  window.setInterval(() => useStatus.getState().tickNow(), 5000);
  openEs();
  document.addEventListener("visibilitychange", onVisibility);
}
