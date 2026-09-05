// FindingsBar — 左栏底部双行资产栏（§5）：
// 行1 Hints（S5：三态计数 + active 点击定位 step）；行2 Findings（severity 8px 色点+文字，
// S26 禁粗左边条；点击定位对应 fact 节点）。空态教学（S12）。
import { useGraph } from "../store/graph";
import type { FGSFinding, FGSHint, FindingSeverity } from "../types";

const SEV_RANK: Record<FindingSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const SEV_DOT: Record<FindingSeverity, string> = {
  critical: "bg-stred",
  high: "bg-stamber",
  medium: "bg-stblue",
  low: "bg-stslate",
  info: "bg-stslate",
};

const SEV_TEXT: Record<FindingSeverity, string> = {
  critical: "text-stred",
  high: "text-stamber",
  medium: "text-stblue",
  low: "text-ink-dim",
  info: "text-ink-dim",
};

function factIdOf(f: FGSFinding): string | null {
  const m = /f-(\d+)/.exec(f.evidence_path);
  return m ? `f-${m[1]}` : null;
}

function HintChip({ h }: { h: FGSHint }) {
  const focus = useGraph((s) => s.focus);
  const steps = useGraph((s) => s.graph?.steps ?? []);
  const target = h.status === "active" ? steps.find((s) => s.addresses_hint === h.id) : undefined;
  const cls =
    h.status === "active"
      ? "border-stblue/60 text-ink hover:border-stblue"
      : h.status === "addressed"
        ? "border-border text-ink-dim"
        : "border-border text-ink-dim opacity-70";
  return (
    <button
      type="button"
      disabled={h.status !== "active"}
      title={h.status === "rejected" ? h.rejection_reason : h.text}
      className={`min-h-8 max-w-56 truncate rounded border px-2 text-[11px] ${cls} ${
        target ? "cursor-pointer" : "cursor-default"
      }`}
      onClick={() => target && focus(target.id)}
    >
      <span className="emoji" aria-hidden>💡</span> {h.id} {h.text}
    </button>
  );
}

export function FindingsBar() {
  const graph = useGraph((s) => s.graph);
  const focus = useGraph((s) => s.focus);
  if (!graph) return null;

  const hints = graph.hints;
  const activeN = hints.filter((h) => h.status === "active").length;
  const addressedN = hints.filter((h) => h.status === "addressed").length;
  const findings = [...graph.findings].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
  const highN = findings.filter((f) => f.severity === "high").length;
  const critN = findings.filter((f) => f.severity === "critical").length;

  return (
    <div className="shrink-0 space-y-1 border-t border-border bg-surface px-3 py-2">
      {/* 行1：Hints（S5） */}
      <div className="flex min-h-8 items-center gap-2">
        <span className="shrink-0 text-[11px] text-ink-dim">
          💡 <span className="tnum">{activeN}</span> active · <span className="tnum">{addressedN}</span> addressed
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {hints.map((h) => (
            <HintChip key={h.id} h={h} />
          ))}
        </div>
      </div>
      {/* 行2：Findings */}
      <div className="flex min-h-8 items-center gap-2">
        <span className="shrink-0 text-[11px] text-ink-dim">
          Findings:{" "}
          <span className="tnum text-stamber">{highN}</span> High ·{" "}
          <span className="tnum text-stred">{critN}</span> Critical
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto">
          {findings.length === 0 ? (
            <span className="text-[12px] text-ink-dim">尚无 Findings · 探索中</span>
          ) : (
            findings.map((f) => {
              const fid = factIdOf(f);
              return (
                <button
                  key={f.id}
                  type="button"
                  disabled={!fid}
                  title={fid ? `定位 ${fid}` : f.title}
                  className="flex min-h-8 min-w-0 items-center gap-1.5 text-[12px] text-ink hover:text-stblue disabled:cursor-default"
                  onClick={() => fid && focus(fid)}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${SEV_DOT[f.severity]}`} aria-hidden />
                  <span className={`shrink-0 text-[11px] uppercase ${SEV_TEXT[f.severity]}`}>{f.severity}</span>
                  <span className="truncate">{f.title}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
