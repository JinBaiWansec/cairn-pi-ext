// store/activity.ts — 活动列表、当前活动、逐活动事件缓冲（§5 四切片之一）
import { create } from "zustand";
import type { ActivityKind, TranscriptEvent } from "../types";

export interface ActState {
  kind: ActivityKind | null;
  stepId: string | null;
  events: TranscriptEvent[];
  nextOffset: number; // /api/transcript 字节水位
  loaded: boolean; // 至少成功拉过一次
  loading: boolean;
  loadError: string | null; // S14：流内嵌红行「事件流中断 · [重试]」
  pendingText: string; // §6.3 打字机缓冲（text_delta 累积，assistant 定稿清空）
  seen: Set<string>; // 去重（SSE 与 fetch/轮询可能重复投递同一事件）
}

interface ActivityStore {
  acts: Record<string, ActState>;
  order: string[]; // act 编号升序
  current: string | null;
  ensure(id: string, kind?: ActivityKind, stepId?: string): void;
  append(id: string, ev: TranscriptEvent): void;
  setCurrent(id: string | null): void;
  setOffset(id: string, off: number, loaded?: boolean): void;
  setLoading(id: string, b: boolean): void;
  setLoadError(id: string, e: string | null): void;
}

const num = (id: string) => parseInt(id.slice(4), 10) || 0;

const fresh = (): ActState => ({
  kind: null,
  stepId: null,
  events: [],
  nextOffset: 0,
  loaded: false,
  loading: false,
  loadError: null,
  pendingText: "",
  seen: new Set(),
});

export function dedupeKey(ev: TranscriptEvent): string {
  const body = (ev.delta ?? ev.text ?? ev.output ?? "") as string;
  return `${ev.ts}|${ev.type}|${ev.turn ?? ""}|${ev.toolCallId ?? ""}|${body.slice(0, 32)}`;
}

export const useActivity = create<ActivityStore>((set) => ({
  acts: {},
  order: [],
  current: null,
  ensure: (id, kind, stepId) =>
    set((s) => {
      const acts = { ...s.acts };
      const cur = acts[id] ?? fresh();
      if (kind && cur.kind === null) cur.kind = kind;
      if (stepId && cur.stepId === null) cur.stepId = stepId;
      acts[id] = cur;
      const order = s.order.includes(id) ? s.order : [...s.order, id].sort((a, b) => num(a) - num(b));
      return { acts, order };
    }),
  append: (id, ev) =>
    set((s) => {
      const cur = s.acts[id] ?? fresh();
      const key = dedupeKey(ev);
      if (cur.seen.has(key)) return s;
      const seen = new Set(cur.seen);
      seen.add(key);
      if (seen.size > 800) seen.clear(); // ring，防长会话膨胀
      const events = [...cur.events, ev];
      const pendingText =
        ev.type === "text_delta"
          ? cur.pendingText + (ev.delta ?? "")
          : ev.type === "assistant"
            ? ""
            : cur.pendingText;
      const acts = { ...s.acts, [id]: { ...cur, events, pendingText, seen, kind: cur.kind ?? ev.kind, stepId: cur.stepId ?? ev.stepId ?? null } };
      return { acts };
    }),
  setCurrent: (id) => set({ current: id }),
  setOffset: (id, off, loaded) =>
    set((s) => {
      const cur = s.acts[id] ?? fresh();
      return { acts: { ...s.acts, [id]: { ...cur, nextOffset: off, loaded: loaded ?? cur.loaded } } };
    }),
  setLoading: (id, b) =>
    set((s) => {
      const cur = s.acts[id] ?? fresh();
      return { acts: { ...s.acts, [id]: { ...cur, loading: b } } };
    }),
  setLoadError: (id, e) =>
    set((s) => {
      const cur = s.acts[id] ?? fresh();
      return { acts: { ...s.acts, [id]: { ...cur, loadError: e } } };
    }),
}));
