// CodeDrawer — 右滑抽屉 384px（§6.5 CodeMirror 6 只读；S18 键盘闭环；S12 错误面板；S14 1MB 截断）
import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
} from "@codemirror/view";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, SearchQuery, search, setSearchQuery } from "@codemirror/search";

// §6.5：basicSetup 去 history + searchKeymap + lineNumbers（本版本 basicSetup 不可传参，官方指引：拷源码手工组装）
const CODE_EXT = [
  EditorView.editable.of(false),
  EditorState.allowMultipleSelections.of(false),
  drawSelection(),
  dropCursor(),
  highlightSpecialChars(),
  highlightActiveLine(),
  bracketMatching(),
  indentOnInput(),
  search(),
  highlightSelectionMatches(),
];
import { getFile } from "../api";
import { useUiStore } from "../store/ui";

const MB = 1024 * 1024;

export function CodeDrawer() {
  const drawer = useUiStore((s) => s.drawer);
  const closeDrawer = useUiStore((s) => s.closeDrawer);
  const setDrawerContent = useUiStore((s) => s.setDrawerContent);
  const setDrawerError = useUiStore((s) => s.setDrawerError);
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  const [jumpN, setJumpN] = useState("");
  const viewRef = useRef<EditorView | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);

  // S18：打开时焦点移入 + ESC 关闭 + 焦点还回触发元素 + Tab 焦点陷阱
  useEffect(() => {
    if (!drawer.path) return;
    lastFocus.current = (document.activeElement as HTMLElement | null) ?? null;
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const box = boxRef.current;
      if (!box) return;
      if (e.key === "Escape") {
        closeDrawer();
        lastFocus.current?.focus();
      } else if (e.key === "Tab") {
        const els = Array.from(
          box.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])'),
        ).filter((el) => !el.hasAttribute("disabled"));
        if (els.length === 0) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer.path, closeDrawer]);

  // 拉文件（S12：失败 → 错误面板；S14：>1MB 由端点截断，content 仅前 1MB）
  useEffect(() => {
    if (!drawer.path) return;
    void getFile(drawer.path)
      .then((f) => setDrawerContent(f.content, f.size))
      .catch((e: Error) => setDrawerError(e.message));
  }, [drawer.path, retry, setDrawerContent, setDrawerError]);

  // 换文件时销毁旧编辑器（内容更新走 dispatch 替换）
  useEffect(() => {
    viewRef.current?.destroy();
    viewRef.current = null;
  }, [drawer.path]);

  useEffect(() => {
    if (!drawer.path || !drawer.content || !mountRef.current) return;
    if (!viewRef.current) {
      viewRef.current = new EditorView({
        parent: mountRef.current,
        state: EditorState.create({
          doc: drawer.content,
          extensions: CODE_EXT,
        }),
      });
    } else {
      const v = viewRef.current;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: drawer.content } });
    }
  }, [drawer.path, drawer.content]);

  if (!drawer.path) return null;

  const regex = () => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "", caseSensitive: false, regexp: true })) });
    openSearchPanel(v);
  };
  const jump = () => {
    const v = viewRef.current;
    const n = parseInt(jumpN, 10);
    if (!v || !n || n < 1) return;
    const line = v.state.doc.line(Math.min(n, v.state.doc.lines));
    v.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true });
  };
  const copySel = () => {
    const v = viewRef.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    void navigator.clipboard.writeText(v.state.sliceDoc(from, to));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      ref={boxRef}
      className="drawer fixed inset-y-0 right-0 z-40 flex w-96 flex-col border-l border-border bg-surface"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drawer-title"
      tabIndex={-1}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span id="drawer-title" className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
          {drawer.path}
        </span>
        <button type="button" className="ctl min-h-8 rounded border border-border px-2 text-[12px] text-ink" onClick={closeDrawer} aria-label="关闭抽屉">
          ✕
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
        <button type="button" className="ctl min-h-8 rounded border border-border px-2 text-[12px] text-ink" onClick={regex}>
          .* 正则
        </button>
        <input
          className="min-h-8 w-16 rounded border border-border bg-bg px-2 text-[12px] tnum text-ink"
          placeholder="行号"
          value={jumpN}
          onChange={(e) => setJumpN(e.target.value)}
          aria-label="跳转行号"
        />
        <button type="button" className="ctl min-h-8 rounded border border-border px-2 text-[12px] text-ink" onClick={jump}>
          跳转
        </button>
        <button type="button" className="ctl ml-auto min-h-8 rounded border border-border px-2 text-[12px] text-ink" onClick={copySel}>
          {copied ? "✓ 已复制" : "复制选区"}
        </button>
      </div>

      {drawer.size !== undefined && drawer.size > MB && (
        <div className="shrink-0 border-b border-stamber/50 bg-stamber/10 px-3 py-1.5 text-[12px] text-stamber">
          仅显示前 1 MB · 完整分片待 Step 7（?offset=）
        </div>
      )}

      <div className="min-h-0 flex-1">
        {drawer.loading && (
          <div className="space-y-2 p-3">
            <div className="skeleton h-4 w-full" />
            <div className="skeleton h-4 w-5/6" />
            <div className="skeleton h-4 w-4/6" />
            <div className="skeleton h-4 w-3/6" />
          </div>
        )}
        {drawer.error && (
          <div className="space-y-2 p-3">
            <div className="rounded border border-stred/60 px-3 py-2 text-[12px] text-stred">{drawer.error}</div>
            <button
              type="button"
              className="ctl min-h-8 rounded border border-border px-3 text-[12px] text-ink"
              onClick={() => setRetry((n) => n + 1)}
            >
              重试
            </button>
          </div>
        )}
        {!drawer.loading && !drawer.error && drawer.content !== undefined && (
          <div ref={mountRef} className="h-full" />
        )}
      </div>
    </div>
  );
}
