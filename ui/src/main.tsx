// main.tsx — 入口（S22 Geist 400/500/700 本地自持；React Flow 基础样式；启动 API/SSE）
import { createRoot } from "react-dom/client";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/700.css";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { start } from "./api";
import { App } from "./App";
import { useActivity } from "./store/activity";
import { useGraph } from "./store/graph";
import { useStatus } from "./store/status";
import { useUiStore } from "./store/ui";

// dev 调试钩子（验收截图/CDP 探查用；体积影响可忽略）
// SAFETY: window 无 __cairn 声明，运行时保证为全局对象
(window as unknown as Record<string, unknown>).__cairn = { useUiStore, useActivity, useGraph, useStatus };

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
start();
