// StepNode — 状态色码（S2 全局单表）：pending=slate / in_progress=蓝+呼吸灯 /
// done=绿+耗时 / dropped=灰+删除线+lastOutcome 缩略（S8 徽章 ×N + hover 全文）
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { FGSStep } from "../../types";
import { useHalo } from "./useHalo";

const BORDER: Record<FGSStep["status"], string> = {
  pending: "border-stslate",
  in_progress: "border-stblue",
  done: "border-stgreen",
  dropped: "border-border",
};

export function StepNode(props: NodeProps) {
  const { step, duration } = props.data as { step: FGSStep; duration?: number };
  const halo = useHalo(props.id);
  const dropped = step.status === "dropped";
  return (
    <div
      className={`w-52 rounded border bg-surface px-3 py-2 ${BORDER[step.status]} ${
        dropped ? "opacity-70" : ""
      } ${halo}`}
      title={dropped ? (step.lastOutcome ?? "") : undefined}
    >
      <Handle type="target" position={Position.Top} className="!bg-border" />
      <Handle type="source" position={Position.Bottom} className="!bg-border" />
      <div className="flex items-center gap-1">
        <span className="text-[11px] tabular-nums text-ink-dim">{step.id}</span>
        {step.status === "in_progress" && (
          <span className="breathe h-2 w-2 rounded-full bg-stblue" aria-hidden />
        )}
        {step.status === "done" && <span className="text-[11px] text-stgreen">✓</span>}
        {step.status === "done" && duration !== undefined && (
          <span className="text-[11px] tabular-nums text-ink-dim">{(duration / 1000).toFixed(1)}s</span>
        )}
        {step.attempts > 1 && <span className="text-[11px] tabular-nums text-stslate">×{step.attempts}</span>}
        <span className="ml-auto text-[11px] uppercase text-ink-dim">{step.status}</span>
      </div>
      <div className={`mt-1 text-[13px] leading-snug text-ink ${dropped ? "line-through" : ""}`}>
        {step.text}
      </div>
      {dropped && step.lastOutcome && (
        <div className="mt-1 truncate text-[11px] text-ink-dim">{step.lastOutcome}</div>
      )}
    </div>
  );
}
