// store/graph.ts — 图数据切片：fgs.json 根 + head 快照 + 节点/边（pinned 布局）
// + 锁定坐标 Map（S27 activeBranch 读取；§6.2 done 耗时由 revision 状态迁移推断）
import { create } from "zustand";
import { layoutPinned, type LaidEdge, type LaidNode, type PosMap } from "../layout/pinned";
import type { FGSBranch, FGSFile, FGSGraph, FGSStep } from "../types";

interface GraphStore {
  file: FGSFile | null;
  branch: FGSBranch | null; // activeBranch
  graph: FGSGraph | null; // head 快照
  nodes: LaidNode[];
  edges: LaidEdge[];
  pos: PosMap;
  error: string | null; // S14：画布覆盖层「图数据加载失败 · [重试]」
  focusId: string | null; // S7 定位反馈
  focusNonce: number;
  applyFile(file: FGSFile): void;
  setError(e: string | null): void;
  focus(id: string): void;
}

export const useGraph = create<GraphStore>((set, get) => ({
  file: null,
  branch: null,
  graph: null,
  nodes: [],
  edges: [],
  pos: {},
  error: null,
  focusId: null,
  focusNonce: 0,
  applyFile: (file) => {
    const branch = file.branches.find((b) => b.name === file.activeBranch) ?? file.branches[0];
    const head = branch?.revisions[branch.revisions.length - 1];
    if (!branch || !head) return;
    const g = head.graph;
    const { nodes, edges, pos } = layoutPinned(g.goal, g.steps, g.facts, branch.revisions, get().pos);
    set({ file, branch, graph: g, nodes, edges, pos, error: null });
  },
  setError: (e) => set({ error: e }),
  focus: (id) => set((s) => ({ focusId: id, focusNonce: s.focusNonce + 1 })),
}));

// §6.2 done=绿+耗时：FGSStep 无时间字段，从 revision 快照的状态迁移推断
//（首次 in_progress → 首次 done 的 ts 差）。
export function stepDurations(branch: FGSBranch): Record<string, number> {
  const start: Record<string, number> = {};
  const out: Record<string, number> = {};
  for (const r of branch.revisions) {
    for (const s of r.graph.steps) {
      if (s.status === "in_progress" && start[s.id] === undefined) start[s.id] = r.ts;
      if (s.status === "done" && start[s.id] !== undefined && out[s.id] === undefined) {
        out[s.id] = r.ts - start[s.id];
      }
    }
  }
  return out;
}

export function formatMs(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

export function stepById(steps: FGSStep[], id: string): FGSStep | undefined {
  return steps.find((s) => s.id === id);
}
