/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // S23 色 token（oklch 冷色；与 styles.css :root 同源）
      colors: {
        bg: "oklch(0.16 0.01 240)",
        surface: "oklch(0.20 0.015 240)",
        border: "oklch(0.30 0.02 240)",
        ink: "oklch(0.92 0.01 240)",
        "ink-dim": "oklch(0.65 0.02 240)",
        stblue: "oklch(0.70 0.15 230)",
        stgreen: "oklch(0.75 0.16 150)",
        stamber: "oklch(0.80 0.14 80)",
        stred: "oklch(0.65 0.20 25)",
        stslate: "oklch(0.60 0.02 240)",
        goal: "oklch(0.22 0.02 240)",
      },
      // S22：UI 字体 Geist（@fontsource 本地自持）；代码/JSON 系统 mono 栈
      fontFamily: {
        sans: ["Geist", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
