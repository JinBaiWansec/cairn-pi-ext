// store/status.ts — 顶栏状态切片（S29 源自 RunMeta；S3 stalled 派生；S9 连接态）
import { create } from "zustand";
import type { Status } from "../types";

const STALL_MS = 60_000; // S3：running 且 60s 无任何 transcript 事件

interface StatusStore {
  status: Status | null;
  offline: boolean; // S14：/api/status 失败 → 顶栏灯灰 + OFFLINE
  conn: "live" | "polling" | null; // S9 连接徽章
  lastEventTs: number; // S3
  tick: number; // 5s 心跳（驱动 STALLED 派生重渲染）
  apply(s: Status): void;
  setOffline(o: boolean): void;
  setConn(c: "live" | "polling" | null): void;
  touch(): void;
  tickNow(): void;
}

export const useStatus = create<StatusStore>((set) => ({
  status: null,
  offline: false,
  conn: null,
  lastEventTs: Date.now(),
  tick: 0,
  apply: (s) => set({ status: s, offline: false }),
  setOffline: (o) => set({ offline: o }),
  setConn: (c) => set({ conn: c }),
  touch: () => set({ lastEventTs: Date.now() }),
  tickNow: () => set((s) => ({ tick: s.tick + 1 })),
}));

// S3 派生状态：STALLED（系统 running 但长时间无事件）
export function isStalled(st: Pick<StatusStore, "status" | "lastEventTs">): boolean {
  return st.status?.state === "running" && Date.now() - st.lastEventTs > STALL_MS;
}
