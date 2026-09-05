// ActivityPane — 右栏：活动 tabs + STALLED 琥珀条（S3）+ 空态教学（S12）+ 冷启动 skeleton（S13）
// + StreamView + HitlInput
import { fetchTranscriptFrom } from "../api";
import { useActivity } from "../store/activity";
import { isStalled, useStatus } from "../store/status";
import { HitlInput } from "./HitlInput";
import { StreamView } from "./StreamView";

export function ActivityPane() {
  const order = useActivity((s) => s.order);
  const current = useActivity((s) => s.current);
  const acts = useActivity((s) => s.acts);
  const setCurrent = useActivity((s) => s.setCurrent);
  const status = useStatus((s) => s.status);
  const lastEventTs = useStatus((s) => s.lastEventTs);
  useStatus((s) => s.tick);

  const id = current ?? order[order.length - 1];

  const pick = (aid: string) => {
    setCurrent(aid);
    const a = useActivity.getState().acts[aid];
    if (!a?.loaded) void fetchTranscriptFrom(aid, a ? a.nextOffset : 0);
  };

  if (!id) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="text-[13px] text-ink">暂无活动</div>
        <div className="max-w-64 text-[12px] text-ink-dim">Decide/Execute 启动后流会出现在这里</div>
        <div className="mt-2 flex w-52 flex-col gap-2" aria-hidden>
          <div className="skeleton h-3 w-full" />
          <div className="skeleton h-3 w-4/5" />
          <div className="skeleton h-3 w-3/5" />
        </div>
      </div>
    );
  }

  const act = acts[id];
  const stalled = isStalled({ status, lastEventTs });
  const coldStart = !act?.loaded && act?.loading;
  const hardFail = !act?.loaded && !act?.loading && !!act?.loadError;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-surface px-2">
        {order.map((aid) => {
          const a = acts[aid];
          const active = aid === id;
          return (
            <button
              key={aid}
              type="button"
              onClick={() => pick(aid)}
              className={`min-h-8 shrink-0 border-b-2 px-2 text-[12px] uppercase ${
                active ? "border-stblue text-ink" : "border-transparent text-ink-dim hover:text-ink"
              }`}
            >
              {aid.slice(4)} {a?.kind ?? "…"}
              {a?.stepId ? ` · ${a.stepId}` : ""}
            </button>
          );
        })}
      </div>

      {stalled && (
        <div className="shrink-0 bg-stamber/15 px-3 py-1 text-[12px] text-stamber">
          ⚠ STALLED · 60s 无事件（系统 running 但无 transcript 事件）
        </div>
      )}

      {coldStart ? (
        <div className="flex flex-1 flex-col gap-2 p-4" aria-hidden>
          <div className="skeleton h-3 w-full" />
          <div className="skeleton h-3 w-4/5" />
          <div className="skeleton h-3 w-3/5" />
        </div>
      ) : hardFail ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <div className="text-[13px] text-stred">事件流加载失败 · {act?.loadError}</div>
          <button
            type="button"
            className="min-h-8 rounded border border-stred/50 px-3 text-[12px] text-ink hover:border-stred"
            onClick={() => void fetchTranscriptFrom(id, 0)}
          >
            重试
          </button>
        </div>
      ) : (
        <>
          <StreamView key={id} id={id} />
          <HitlInput />
        </>
      )}
    </div>
  );
}
