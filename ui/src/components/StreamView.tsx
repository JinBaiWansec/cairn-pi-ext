// StreamView — 打字机流（§6.3 rAF 合帧 ≤200 字符/帧；S11 活动级收束行；S14 流中断红行+重试；
// S17 划选浮钮（S25 文字标签/S20 32px/S14 disabled）；S19 「↓ 回到底部」含未读数；S28 prompt 折叠）
import { useEffect, useRef, useState } from "react";
import { fetchTranscriptFrom } from "../api";
import { useActivity } from "../store/activity";
import { useUiStore } from "../store/ui";
import type { TranscriptEvent } from "../types";
import { ToolCard } from "./ToolCard";

const EMPTY: TranscriptEvent[] = [];

const FLOAT_BTN =
  "flex min-h-8 cursor-pointer items-center gap-1 rounded border border-border bg-surface px-2 text-[12px] text-ink transition-colors duration-150 hover:border-stblue focus-visible:outline-2 focus-visible:outline-stblue active:opacity-80 disabled:cursor-not-allowed disabled:opacity-55";

function PromptLine({ ev }: { ev: TranscriptEvent }) {
  return (
    <details className="my-1 text-[12px] text-ink-dim">
      <summary className="min-h-8 cursor-pointer select-none hover:text-ink">prompt（首行，默认收起）</summary>
      {ev.systemPrompt && <pre className="whitespace-pre-wrap break-all font-mono text-[11px]">{ev.systemPrompt}</pre>}
      {ev.userPrompt && <pre className="whitespace-pre-wrap break-all font-mono text-[11px]">{ev.userPrompt}</pre>}
    </details>
  );
}

function EndLine({ ev }: { ev: TranscriptEvent }) {
  const bad = ev.reason === "error" || ev.reason === "stream_broken";
  return (
    <div className={`py-1 text-center text-[12px] ${bad ? "text-stred" : "text-ink-dim"}`}>
      — 活动结束 · {ev.reason ?? "unknown"} · turn {ev.turn ?? "?"} —
    </div>
  );
}

export function StreamView({ id }: { id: string }) {
  const events = useActivity((s) => s.acts[id]?.events ?? EMPTY);
  const pending = useActivity((s) => s.acts[id]?.pendingText ?? "");
  const loadError = useActivity((s) => s.acts[id]?.loadError);
  const selFloat = useUiStore((s) => s.selFloat);
  const setSelFloat = useUiStore((s) => s.setSelFloat);
  const setHintDraft = useUiStore((s) => s.setHintDraft);
  const [typed, setTyped] = useState("");
  const offsetRef = useRef(0);
  const prevPending = useRef("");

  // §6.3 打字机：rAF 消费 store 缓冲，每帧 ≤200 字符
  useEffect(() => {
    if (!pending) return;
    let raf = 0;
    const step = () => {
      const buf = useActivity.getState().acts[id]?.pendingText ?? "";
      const chunk = buf.slice(offsetRef.current, offsetRef.current + 200);
      if (chunk) {
        offsetRef.current += chunk.length;
        setTyped((t) => t + chunk);
      }
      if (buf.length > offsetRef.current) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [pending, id]);

  // assistant 定稿：flush 剩余缓冲（store 已清空 pendingText）
  useEffect(() => {
    if (prevPending.current && !pending) {
      setTyped((t) => t + prevPending.current.slice(offsetRef.current));
      offsetRef.current = 0;
    }
    prevPending.current = pending;
  }, [pending]);

  // 自动滚底 + 未读计数（S19）
  const boxRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const lastSeen = useRef(0);
  useEffect(() => {
    const el = boxRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
    if (follow) lastSeen.current = events.length;
  }, [events, typed, follow]);
  const unread = follow ? 0 : Math.max(0, events.length - lastSeen.current);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    setSelFloat(null); // S14：滚动后坐标失效 → 浮钮消失
  };

  // §6.4 划选即注水
  const onMouseUp = () => {
    const sel = window.getSelection();
    const text = sel?.toString() ?? "";
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    const box = boxRef.current;
    if (!text || !range || !box || !box.contains(range.commonAncestorContainer)) {
      setSelFloat(null);
      return;
    }
    const r = range.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    setSelFloat({ text, x: r.right - b.left + box.scrollLeft - 8, y: r.top - b.top + box.scrollTop });
  };

  const fillDraft = (prefix: string) => {
    const sel = useUiStore.getState().selFloat;
    if (!sel) return;
    setHintDraft(prefix + sel.text);
    setSelFloat(null);
    window.getSelection()?.removeAllRanges();
  };

  // tool_call / tool_result 按 toolCallId 配对（§6.3）
  const items: Array<{ ev: TranscriptEvent; toolResult?: TranscriptEvent }> = [];
  for (const ev of events) {
    if (ev.type === "tool_call") {
      items.push({ ev });
    } else if (ev.type === "tool_result") {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.ev.type === "tool_call" && !it.toolResult && it.ev.toolCallId === ev.toolCallId) {
          it.toolResult = ev;
          break;
        }
      }
    } else {
      items.push({ ev });
    }
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={boxRef}
        onScroll={onScroll}
        onMouseUp={onMouseUp}
        className="h-full overflow-y-auto px-3 py-2 text-[12px] leading-5 text-ink"
      >
        {items.map((it, i) => {
          const ev = it.ev;
          if (ev.type === "text_delta") return null;
          if (ev.type === "tool_call") return <ToolCard key={i} call={ev} result={it.toolResult} />;
          if (ev.type === "prompt") return <PromptLine key={i} ev={ev} />;
          if (ev.type === "assistant")
            return (
              <p key={i} className="whitespace-pre-wrap break-words">
                {ev.text}
              </p>
            );
          if (ev.type === "error")
            return (
              <div key={i} className="my-1 text-stred">
                ✗ {ev.error ?? "error"}
              </div>
            );
          if (ev.type === "end") return <EndLine key={i} ev={ev} />;
          return null;
        })}
        {typed && (
          <div className="whitespace-pre-wrap break-words">
            {typed}
            <span className="caret" aria-hidden />
          </div>
        )}
        {loadError && (
          <div className="mt-1 flex items-center gap-2 text-[12px] text-stred">
            事件流中断 · {loadError}
            <button
              type="button"
              className="min-h-8 rounded border border-stred/50 px-2 hover:border-stred"
              onClick={() => void fetchTranscriptFrom(id)}
            >
              重试
            </button>
          </div>
        )}
      </div>

      {/* S17 划选浮动按钮组（S25 文字标签，S14 disabled） */}
      {selFloat && (
        <div className="absolute z-10 flex items-center gap-1" style={{ left: selFloat.x, top: selFloat.y - 36 }}>
          <button type="button" disabled={!selFloat.text} className={FLOAT_BTN} onClick={() => fillDraft("")}>
            <span className="emoji" aria-hidden>💡</span> 下发 Hint
          </button>
          <button type="button" disabled={!selFloat.text} className={FLOAT_BTN} onClick={() => fillDraft("【FACT 标记】")}>
            <span className="emoji" aria-hidden>📌</span> 标记 Fact
          </button>
        </div>
      )}

      {/* S19 回到底部（键盘可达） */}
      {!follow && (
        <button
          type="button"
          className="absolute bottom-3 right-3 z-10 flex min-h-8 items-center gap-1 rounded border border-border bg-surface px-2 text-[12px] text-ink hover:border-stblue focus-visible:outline-2 focus-visible:outline-stblue"
          onClick={() => {
            const el = boxRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            setFollow(true);
          }}
        >
          ↓{unread > 0 ? ` ${unread}` : ""} 回到底部
        </button>
      )}
    </div>
  );
}
