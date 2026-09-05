// pinned.ts — 增量锁定布局（纯函数，独立可测；carin_step6_plan §6.1 + D5）
// 规则：首载确定性全量布局一次并全部锁定；增量仅定位新节点（父节点右下扇区延伸）；
// 已存在节点坐标绝不动（无重排、无 fitView 重算）。
import type { FGSFact, FGSRevision, FGSStep } from "../types";

export const GOAL = "goal";
const STEP = "s-";

export interface Pos {
  x: number;
  y: number;
}
export type PosMap = Record<string, Pos>;

export interface LaidNode {
  id: string;
  kind: "goal" | "step" | "fact";
  x: number;
  y: number;
}
export interface LaidEdge {
  source: string;
  target: string;
  /** main = step 主干（贝塞尔）；fact = step→fact 细线降透明度 */
  kind: "main" | "fact";
}

export interface LayoutResult {
  nodes: LaidNode[];
  edges: LaidEdge[];
  pos: PosMap;
}

// D5：fact→step 归属近似 —— 挂到「其 created_at 时处于 in_progress 的最近 step」
//（按 revision 快照推断）；无法推断则平铺挂在 GOAL 下。
export function attributeFacts(
  facts: FGSFact[],
  revisions: FGSRevision[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of facts) {
    let snap: FGSRevision | null = null;
    for (const r of revisions) {
      if (r.ts <= f.created_at) snap = r;
      else break;
    }
    const inProgress = snap?.graph.steps.filter((s) => s.status === "in_progress") ?? [];
    out[f.id] = inProgress.length > 0 ? inProgress[inProgress.length - 1].id : GOAL;
  }
  return out;
}

/**
 * @param prev 既有坐标 Map（增量时绝不修改已存在项）
 * @returns 节点/边 + 更新后的坐标 Map
 */
export function layoutPinned(
  goal: string,
  steps: FGSStep[],
  facts: FGSFact[],
  revisions: FGSRevision[],
  prev: PosMap,
): LayoutResult {
  const parentOf = attributeFacts(facts, revisions);
  // 树：GOAL → steps；GOAL/step → facts（D5 归属；GOAL 下 facts 排末位）
  const childOrder: Record<string, string[]> = {
    [GOAL]: [...steps.map((s) => s.id), ...facts.filter((f) => parentOf[f.id] === GOAL).map((f) => f.id)],
  };
  for (const s of steps) {
    childOrder[s.id] = facts.filter((f) => parentOf[f.id] === s.id).map((f) => f.id);
  }
  const allIds = [GOAL, ...steps.map((s) => s.id), ...facts.map((f) => f.id)];
  const parentOfAll: Record<string, string> = { [GOAL]: GOAL };
  for (const s of steps) parentOfAll[s.id] = GOAL;
  for (const f of facts) parentOfAll[f.id] = parentOf[f.id];

  const pos: PosMap = { ...prev };
  if (Object.keys(prev).length === 0) {
    // 首载：树序遍历，x = 60 + depth*240，y = 90 + 全局序号*80；写满后全部锁定
    let i = 0;
    const walk = (id: string, depth: number) => {
      pos[id] = { x: 60 + depth * 240, y: 90 + i * 80 };
      i += 1;
      for (const c of childOrder[id] ?? []) walk(c, depth + 1);
    };
    walk(GOAL, 0);
  } else {
    // 增量：仅新节点。parentPos 必有（树根 GOAL 恒在；step/fact 的父先于子入图）。
    for (const id of allIds) {
      if (id in pos) continue;
      const p = pos[parentOfAll[id]];
      const childIdx = (childOrder[parentOfAll[id]] ?? []).filter((c) => c in pos).length;
      pos[id] = { x: p.x + 180 + childIdx * 36, y: p.y + 40 + childIdx * 56 };
    }
  }

  const nodes: LaidNode[] = allIds.map((id) => ({
    id,
    kind: id === GOAL ? "goal" : id.startsWith(STEP) ? "step" : "fact",
    x: pos[id].x,
    y: pos[id].y,
  }));
  const edges: LaidEdge[] = [];
  for (const id of allIds) {
    if (id === GOAL) continue;
    edges.push({
      source: parentOfAll[id],
      target: id,
      kind: id.startsWith(STEP) ? "main" : "fact",
    });
  }
  void goal;
  return { nodes, edges, pos };
}
