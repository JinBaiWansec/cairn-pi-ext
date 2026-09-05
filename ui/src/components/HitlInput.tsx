// HitlInput — 💡 Hint 输入（S15 四态机 idle/sending/sent/error；S25 文字标签；S20 32px；
// S14 划选文本为空 → 发送钮 disabled；POST /api/ops add_hint）
import { useState } from "react";
import { postOp } from "../api";
import { useUiStore } from "../store/ui";

type SendState = "idle" | "sending" | "sent" | "error";

export function HitlInput() {
  const draft = useUiStore((s) => s.hintDraft);
  const setDraft = useUiStore((s) => s.setHintDraft);
  const [state, setState] = useState<SendState>("idle");
  const [msg, setMsg] = useState("");

  const send = async () => {
    const text = draft.trim();
    if (!text || state === "sending") return;
    setState("sending");
    try {
      await postOp("add_hint", { text });
      setDraft("");
      setMsg("✓ 已下发");
      setState("sent");
      window.setTimeout(() => setState((s) => (s === "sent" ? "idle" : s)), 2000);
    } catch (e) {
      setMsg(`发送失败 · ${(e as Error).message}`);
      setState("error");
    }
  };

  return (
    <div className="shrink-0 border-t border-border bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="emoji shrink-0" aria-hidden>
          💡
        </span>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
          placeholder="下发 Hint（Enter 发送）"
          readOnly={state === "sending"}
          aria-label="Hint 输入"
          className="min-h-8 flex-1 rounded border border-border bg-bg px-2 text-[12px] text-ink focus-visible:outline-2 focus-visible:outline-stblue"
        />
        <button
          type="button"
          disabled={!draft.trim() || state === "sending"}
          onClick={() => void send()}
          className="min-h-8 shrink-0 cursor-pointer rounded border border-stblue/60 px-3 text-[12px] text-ink transition-colors duration-150 hover:border-stblue disabled:cursor-not-allowed disabled:opacity-55"
        >
          {state === "sending" ? "发送中…" : "下发 Hint"}
        </button>
      </div>
      {state === "sent" && <div className="mt-1 text-[12px] text-stgreen">{msg}</div>}
      {state === "error" && (
        <div className="mt-1 text-[12px] text-stred">
          {msg}
          <button type="button" className="ml-2 min-h-8 text-stblue hover:underline" onClick={() => void send()}>
            重试
          </button>
        </div>
      )}
    </div>
  );
}
