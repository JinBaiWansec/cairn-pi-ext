/**
 * serve.mjs — keep-alive UI server for the curl smoke (test/smoke-curl.sh).
 * Creates a fresh FgsGraph in a temp workspace, starts ensureUiServer on 8377,
 * stays alive until SIGTERM. Run: node test/serve.mjs
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { FgsGraph } = await jiti.import("../src/graph.ts");
const { ensureUiServer, setUiWorkspace } = await jiti.import(
  "../src/index.ts",
);

const wsDir = mkdtempSync(join(tmpdir(), "cairn-serve-"));
const g = FgsGraph.create(wsDir, "origin-text", "goal-text");
g.addStep("pre-existing step");
g.save(); // addStep does not persist; /graph peeks the file
setUiWorkspace(wsDir);
ensureUiServer(g);
console.log("READY");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1 << 30);
