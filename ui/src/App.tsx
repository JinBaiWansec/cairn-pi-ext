// App — 顶栏 + 左(画布+FindingsBar):右(活动流) 可拖拽分栏（S6：默认 55:45，4px 视觉/16px 命中，
// 比例写 localStorage cairn-split）+ 抽屉
import { useRef, useState } from "react";
import { ActivityPane } from "./components/ActivityPane";
import { CodeDrawer } from "./components/CodeDrawer";
import { FindingsBar } from "./components/FindingsBar";
import { TopBar } from "./components/TopBar";
import { TopologyCanvas } from "./components/TopologyCanvas";

const KEY = "cairn-split";
const clamp = (n: number) => Math.min(70, Math.max(30, n));
const initial = (): number => {
  const v = parseInt(localStorage.getItem(KEY) ?? "", 10);
  return Number.isFinite(v) ? clamp(v) : 55;
};

export function App() {
  const [split, setSplit] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const splitRef = useRef(split);
  splitRef.current = split;
  const mainRef = useRef<HTMLDivElement>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !mainRef.current) return;
    const rect = mainRef.current.getBoundingClientRect();
    const pct = clamp(((e.clientX - rect.left) / rect.width) * 100);
    setSplit(pct);
    localStorage.setItem(KEY, String(Math.round(pct)));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-ink">
      <TopBar />
      <div ref={mainRef} className="flex min-h-0 flex-1">
        <div style={{ width: `${split}%` }} className="flex min-w-0 flex-col">
          <div className="min-h-0 flex-1">
            <TopologyCanvas />
          </div>
          <FindingsBar />
        </div>
        <div
          className={`flex w-4 shrink-0 cursor-col-resize items-stretch justify-center ${dragging ? "select-none" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整分栏比例"
        >
          <div className={`splitter w-1 ${dragging ? "active" : ""}`} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <ActivityPane />
        </div>
      </div>
      <CodeDrawer />
    </div>
  );
}
