#!/usr/bin/env node
/**
 * jiti runner for test/*.ts (this Node build has no native .ts support:
 * ERR_UNKNOWN_FILE_EXTENSION).
 *
 * Usage:
 *   node test/run.mjs             # all tests EXCEPT model-dependent ones
 *   node test/run.mjs subagent    # explicit filter (subagent hits local LLM, ~1 min)
 *
 * Model-dependent (excluded by default):
 *   subagent.test.ts  — runs a real qwen/qwen-27b sub-session
 *   engine.test.ts    — real-model smoke (decide via qwen/qwen-27b)
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const dir = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);

const NO_MODEL = ["subagent.test.ts", "engine.test.ts"]; // hit local LLM — need explicit filter
const filter = process.argv[2];
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => (filter ? f.includes(filter) : !NO_MODEL.includes(f)))
  .sort();

let failed = 0;
for (const f of files) {
  const t0 = Date.now();
  try {
    await jiti.import(join(dir, f));
    console.log(`PASS ${f} (${Date.now() - t0}ms)`);
  } catch (err) {
    failed++;
    console.log(
      `FAIL ${f} (${Date.now() - t0}ms): ${String(err?.message ?? err).split("\n")[0]}`,
    );
  }
}
console.log(`${files.length - failed}/${files.length} passed`);
process.exit(failed ? 1 : 0);
