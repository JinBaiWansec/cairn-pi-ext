// useHalo — S7 定位反馈：focusId 命中时挂 .halo（2 次脉冲，1.3s 后摘除）
import { useEffect, useState } from "react";
import { useGraph } from "../../store/graph";

export function useHalo(id: string): string {
  const nonce = useGraph((s) => (s.focusId === id ? s.focusNonce : 0));
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!nonce) return;
    setOn(true);
    const t = window.setTimeout(() => setOn(false), 1300);
    return () => window.clearTimeout(t);
  }, [nonce]);
  return on ? "halo" : "";
}
