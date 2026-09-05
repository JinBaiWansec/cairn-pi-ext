// prebuild（D4）：清旧产物与 cytoscape 旧原型；若当前 index.html 是构建产物
// （不引用 /src/main.tsx），恢复 vite 入口模板 —— 保证可重复构建。
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const f of ["assets", "cytoscape.min.js"]) {
  rmSync(join(root, f), { recursive: true, force: true });
}

const TEMPLATE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CAIRN // Console</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const htmlPath = join(root, "index.html");
if (!existsSync(htmlPath) || !readFileSync(htmlPath, "utf8").includes("/src/main.tsx")) {
  writeFileSync(htmlPath, TEMPLATE);
}
