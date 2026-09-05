// GoalNode — 深色面板 oklch(0.22 0.02 240)、边框高亮、goal 全文（§6.2）
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { GOAL } from "../../layout/pinned";
import { useGraph } from "../../store/graph";
import { useHalo } from "./useHalo";

export function GoalNode(props: NodeProps) {
  const goal = useGraph((s) => s.graph?.goal ?? (props.data as { goal: string }).goal);
  const halo = useHalo(GOAL);
  return (
    <div className={`w-56 rounded border border-stblue/60 bg-goal px-3 py-2 ${halo}`}>
      <Handle type="source" position={Position.Bottom} className="!bg-border" />
      <div className="text-[11px] uppercase tracking-wider text-ink-dim">Goal</div>
      <div className="mt-1 text-[13px] leading-snug text-ink">{goal}</div>
    </div>
  );
}
