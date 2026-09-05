import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// D1/D2：单入口 SPA 产物直接落 ui/ 根（index.html + assets/*），base 相对 →
// dev :8477 根路径与 Step 7 /ext/cairn/* 子路径双部署通吃。
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: ".",
    emptyOutDir: false,
  },
});
