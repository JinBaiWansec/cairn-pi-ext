// ToolCard — 工具调用卡（§5：bash: $cmd + 输出预览 + spill 链接；S26 单层 1px border 无嵌套 shadow）
import { useUiStore } from "../store/ui";
import type { TranscriptEvent } from "../types";

export function ToolCard({ call, result }: { call: TranscriptEvent; result?: TranscriptEvent }) {
  const openDrawer = useUiStore((s) => s.openDrawer);
  const cmd = call.args && typeof call.args.command === "string" ? (call.args.command as string) : null;
  const out = result?.output ?? "";
  const lines = out.split("\n");
  const preview = lines.slice(0, 4).join("\n");
  const failed = result?.ok === false;
  return (
    <div className={`my-1 rounded border px-2 py-1.5 ${failed ? "border-stred/50" : "border-border"}`}>
      <div className="flex min-h-8 items-center gap-2 text-[12px]">
        <span className="emoji" aria-hidden>⚙</span>
        <span className="shrink-0 font-medium text-ink">{call.name ?? "tool"}</span>
        {cmd && <code className="truncate font-mono text-[12px] text-ink-dim">$ {cmd}</code>}
        {!result && <span className="animate-pulse text-[11px] text-ink-dim">运行中…</span>}
        {failed && <span className="text-[11px] text-stred">failed</span>}
      </div>
      {result && out && (
        <pre className="mt-1 max-h-24 overflow-hidden whitespace-pre-wrap break-all font-mono text-[11px] leading-4 text-ink-dim">
          {preview}
          {out.length > preview.length ? "\n…" : ""}
        </pre>
      )}
      {result?.spillPath && (
        <button
          type="button"
          className="mt-1 min-h-8 text-[12px] text-stblue hover:underline"
          onClick={() => openDrawer(result.spillPath as string)}
        >
          … 完整输出: {result.spillPath}
        </button>
      )}
    </div>
  );
}
