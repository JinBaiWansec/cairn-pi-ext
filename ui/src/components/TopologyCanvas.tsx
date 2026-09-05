// TopologyCanvas — React Flow 画布（55% 左栏，§6.1 增量锁定；S7 setCenter+halo；
// S13 首载 skeleton；S14 图数据失败覆盖层；S21 页面隐藏暂停动画）
import { useEffect, useMemo, useState } from "react";
import { ReactFlow, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { refreshGraph } from "../api";
import { stepDurations, useGraph } from "../store/graph";
import { FactNode } from "./nodes/FactNode";
import { GoalNode } from "./nodes/GoalNode";
import { StepNode } from "./nodes/StepNode";

const nodeTypes = { goal: GoalNode, step: StepNode, fact: FactNode };

export function TopologyCanvas() {
  const nodes = useGraph((s) => s.nodes);
  const edges = useGraph((s) => s.edges);
  const file = useGraph((s) => s.file);
  const error = useGraph((s) => s.error);
  const focusNonce = useGraph((s) => s.focusNonce);
  const [hidden, setHidden] = useState(document.hidden);
  const [inst, setInst] = useState<ReactFlowInstance | null>(null);

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const rfNodes = useMemo<Node[]>(() => {
    const g = file && useGraph.getState().branch
      ? useGraph.getState().graph
      : null;
    const durations = g ? stepDurations(useGraph.getState().branch!) : {};
    const out: Node[] = [];
    for (const n of nodes) {
      const base = { id: n.id, position: { x: n.x, y: n.y } } as const;
      if (n.kind === "goal") {
        out.push({ ...base, type: "goal", data: { goal: g?.goal ?? "" } });
      } else if (n.kind === "step") {
        const step = g?.steps.find((s) => s.id === n.id);
        if (step) out.push({ ...base, type: "step", data: { step, duration: durations[n.id] } });
      } else {
        const fact = g?.facts.find((f) => f.id === n.id);
        if (fact) out.push({ ...base, type: "fact", data: { fact } });
      }
    }
    return out;
  }, [nodes, file]);

  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => ({
        id: `${e.source}->${e.target}`,
        source: e.source,
        target: e.target,
        type: "default",
        style:
          e.kind === "fact"
            ? { stroke: "oklch(0.30 0.02 240)", strokeWidth: 1, opacity: 0.4 }
            : { stroke: "oklch(0.30 0.02 240)", strokeWidth: 1.5 },
      })),
    [edges],
  );

  // S7：focusId 变化 → setCenter 300ms（halo 由节点 useHalo 自管）
  useEffect(() => {
    if (!focusNonce || !inst) return;
    const { focusId, pos } = useGraph.getState();
    const p = focusId ? pos[focusId] : undefined;
    if (p) inst.setCenter(p.x + 110, p.y + 30, { duration: 300, zoom: 1 });
  }, [focusNonce, inst]);

  const loading = !file && !error;
  return (
    <div className={`relative h-full w-full ${hidden ? "anim-paused" : ""}`}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.3}
        proOptions={{ hideAttribution: true }}
        onInit={setInst}
      />
      {loading && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-start gap-2 p-6" aria-hidden>
          <div className="skeleton h-12 w-56" />
          <div className="skeleton mt-6 h-10 w-52" />
          <div className="skeleton mt-2 h-10 w-52" />
          <div className="skeleton mt-2 h-10 w-44" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-3 rounded border border-stred/60 bg-surface px-4 py-2">
            <span className="text-[13px] text-ink">图数据加载失败</span>
            <button
              type="button"
              className="min-h-8 rounded border border-border px-3 text-[13px] text-ink hover:border-stblue"
              onClick={() => void refreshGraph()}
            >
              重试
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
