// ui 切片：CodeDrawer 状态（S12/S14 含 error/loading）、hintDraft、划选浮动按钮（S6.4/S17）
import { create } from "zustand";

export interface DrawerState {
  /** null = 关闭 */
  path: string | null;
  content?: string;
  /** 真实文件大小（>1MB 时 content 仅前 1MB，S14） */
  size?: number;
  /** 打开失败：状态码/错误信息（S12 错误面板） */
  error?: string;
  loading: boolean;
}

export interface SelFloat {
  text: string;
  /** 容器内坐标（px，浮动按钮组锚点） */
  x: number;
  y: number;
}

interface UiStore {
  drawer: DrawerState;
  hintDraft: string;
  selFloat: SelFloat | null;
  openDrawer: (path: string) => void;
  closeDrawer: () => void;
  setDrawerContent: (content: string, size: number) => void;
  setDrawerError: (error: string) => void;
  setHintDraft: (s: string) => void;
  setSelFloat: (v: SelFloat | null) => void;
}

export const useUiStore = create<UiStore>((set) => ({
  drawer: { path: null, loading: false },
  hintDraft: "",
  selFloat: null,
  openDrawer: (path) =>
    set({ drawer: { path, loading: true }, selFloat: null }),
  closeDrawer: () => set({ drawer: { path: null, loading: false } }),
  setDrawerContent: (content, size) =>
    set((s) => ({ drawer: { ...s.drawer, content, size, error: undefined, loading: false } })),
  setDrawerError: (error) =>
    set((s) => ({ drawer: { ...s.drawer, error, loading: false } })),
  setHintDraft: (s) => set({ hintDraft: s }),
  setSelFloat: (v) => set({ selFloat: v }),
}));
