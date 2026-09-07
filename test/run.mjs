#!/usr/bin/env node
/**
 * jiti runner for test/*.ts (this Node build has no native .ts support:
 * ERR_UNKNOWN_FILE_EXTENSION).
 *
 * Usage:
 *   node test/run.mjs            # all tests
 *   node test/run.mjs <substr>   # filter by filename substring
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const dir = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);

const filter = process.argv[2];
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => !filter || f.includes(filter))
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
