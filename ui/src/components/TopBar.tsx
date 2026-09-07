// TopBar — 40px（S1）：CAIRN 标题 + Branch 下拉 + 状态区（S2/S3/S11）
// + 预算位（S4）+ Time/Tok + 连接徽章（S9/S10）+ 控制按钮（Step 7 启用：
// ⏸/🛑 → POST /api/ops，⑂/Branch → /api/branch、/api/checkout；D10 终态 disabled）
import { postBranch, postCheckout, postOp } from "../api";
import { useGraph } from "../store/graph";
import { useStatus, isStalled } from "../store/status";

function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function TopBar() {
  const status = useStatus((s) => s.status);
  const offline = useStatus((s) => s.offline);
  const conn = useStatus((s) => s.conn);
  const lastEventTs = useStatus((s) => s.lastEventTs);
  useStatus((s) => s.tick); // 5s 心跳驱动重渲染（STALLED/Time）
  const file = useGraph((s) => s.file);
  const origin = useGraph((s) => s.graph?.origin ?? "");

  const stalled = isStalled({ status, lastEventTs });
  const elapsed = status?.elapsedMs ?? 0;
  const running = status?.running === true;
  const fail = (e: unknown) => console.error("[cairn]", e);
  const op = (k: "pause" | "abort") => void postOp(k, {}).catch(fail);
  const newBranch = () => {
    const name = window.prompt("新建分支名：");
    if (name?.trim()) void postBranch(name.trim()).catch(fail);
  };

  const stateInfo = offline
    ? { dot: "bg-stslate", text: "OFFLINE", cls: "text-ink-dim" }
    : stalled
      ? { dot: "bg-stamber breathe", text: `STALLED · 无事件 ${Math.floor((Date.now() - lastEventTs) / 1000)}s+`, cls: "text-stamber" }
      : !status
        ? { dot: "bg-stslate", text: "…", cls: "text-ink-dim" }
        : status.state === "running"
          ? { dot: "bg-stblue", text: status.activeStepId ? `EXECUTING (${status.activeStepId})` : "EXECUTING", cls: "text-stblue" }
          : status.state === "parked"
            ? { dot: "bg-stamber", text: "PARKED", cls: "text-stamber" }
            : { dot: "bg-stslate", text: status.endReason ? `ENDED · ${status.endReason}` : "ENDED", cls: "text-ink-dim" };

  const budget = status?.budget;
  const nearLimit =
    (budget?.maxExecutes !== undefined && budget.executes >= budget.maxExecutes * 0.75) ||
    (budget?.maxDecides !== undefined && budget.decides >= budget.maxDecides * 0.75);

  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
      <div className="flex items-baseline gap-1 text-[14px] font-bold uppercase tracking-wide text-ink">
        Cairn
        <span className="text-ink-dim">//</span>
        <span className="max-w-40 truncate text-[12px] font-normal normal-case">{origin}</span>
      </div>

      <label className="flex items-center gap-1 text-[12px] text-ink-dim">
        Branch
        <select
          className="min-h-8 rounded border border-border bg-bg px-1 text-[12px] text-ink"
          value={file?.activeBranch ?? ""}
          disabled={!file}
          onChange={(e) => void postCheckout(e.target.value).catch(fail)}
          aria-label="当前分支"
        >
          {file?.branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name} ({b.revisions.length > 0 ? `rev-${b.revisions[b.revisions.length - 1].id.slice(4)}` : "—"})
            </option>
          ))}
        </select>
      </label>

      <div className={`flex items-center gap-1.5 text-[14px] font-bold uppercase ${stateInfo.cls}`}>
        <span className={`h-3 w-3 rounded-full ${stateInfo.dot}`} aria-hidden />
        <span>Status: {stateInfo.text}</span>
      </div>

      {budget && (
        <span className={`tnum text-[12px] ${nearLimit ? "text-stamber" : "text-ink-dim"}`}>
          Exec {budget.executes}
          {budget.maxExecutes !== undefined ? `/${budget.maxExecutes}` : ""}
          {" · "}
          Dec {budget.decides}
          {budget.maxDecides !== undefined ? `/${budget.maxDecides}` : ""}
        </span>
      )}

      <span className="tnum text-[12px] text-ink-dim">Time: {status ? fmtClock(elapsed) : "—"}</span>
      <span className="tnum text-[12px] text-ink-dim">Tok: {status ? fmtTok(status.usage.totalTokens) : "—"}</span>

      <div className="ml-auto flex items-center gap-2">
        {status?.env === "mock" && (
          <span className="rounded border border-stblue/50 px-1.5 py-0.5 text-[11px] text-stblue">MOCK</span>
        )}
        <span className="flex items-center gap-1 text-[11px]">
          {conn === "live" && (
            <>
              <span className="h-2 w-2 rounded-full bg-stgreen" aria-hidden />
              <span className="text-stgreen">LIVE</span>
            </>
          )}
          {conn === "polling" && (
            <>
              <span className="text-stamber" aria-hidden>
                ◌
              </span>
              <span className="text-stamber">轮询中</span>
            </>
          )}
          {conn === null && <span className="text-ink-dim">…</span>}
        </span>

        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={!running}
            onClick={() => op("pause")}
            title="暂停（当前活动完成后挂起）"
            className="min-h-8 rounded border border-border px-2 text-[12px] text-ink transition-colors duration-150 hover:border-stblue disabled:cursor-not-allowed disabled:opacity-55"
          >
            <span className="emoji" aria-hidden>⏸</span> 暂停
          </button>
          <button
            type="button"
            disabled={!running}
            onClick={() => op("abort")}
            className="min-h-8 rounded border border-border px-2 text-[12px] text-ink transition-colors duration-150 hover:border-stblue disabled:cursor-not-allowed disabled:opacity-55"
          >
            <span className="emoji" aria-hidden>🛑</span> 中止
          </button>
          <button
            type="button"
            disabled={!running}
            onClick={newBranch}
            className="min-h-8 rounded border border-border px-2 text-[12px] text-ink transition-colors duration-150 hover:border-stblue disabled:cursor-not-allowed disabled:opacity-55"
          >
            <span className="emoji" aria-hidden>⑂</span> 新建分支
          </button>
        </div>
      </div>
    </header>
  );
}
