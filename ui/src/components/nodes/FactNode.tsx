// FactNode — 常规亮底；degraded=琥珀描边+角标；superseded=opacity-40+删除线；
// 点击开抽屉（spill_path，§6.2/§6.5）
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useUiStore } from "../../store/ui";
import type { FGSFact } from "../../types";
import { useHalo } from "./useHalo";

export function FactNode(props: NodeProps) {
  const { fact } = props.data as { fact: FGSFact };
  const openDrawer = useUiStore((s) => s.openDrawer);
  const halo = useHalo(props.id);
  const degraded = fact.quality === "degraded";
  const sup = fact.superseded;
  return (
    <button
      type="button"
      className={`w-48 rounded border px-3 py-2 text-left ${
        degraded ? "border-stamber" : "border-border"
      } ${sup ? "opacity-40" : ""} ${halo} bg-[oklch(0.95_0.01_240)] text-[oklch(0.20_0.02_240)]`}
      onClick={() => openDrawer(fact.spill_path)}
      title={fact.spill_path}
    >
      <Handle type="target" position={Position.Top} className="!bg-border" />
      <div className="flex items-center gap-1">
        <span className="text-[11px] tabular-nums">{fact.id}</span>
        {degraded && <span className="ml-auto text-[11px] text-stamber">degraded</span>}
      </div>
      <div className={`mt-1 text-[13px] leading-snug ${sup ? "line-through" : ""}`}>
        {fact.description}
      </div>
    </button>
  );
}
