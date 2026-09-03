import { readFileSync, writeFileSync } from "node:fs";
import { createJiti } from "jiti";
const jiti = createJiti("/home/kali/work/cairn-pi-ext/package.json");
const { extractJson } = await jiti.import("/home/kali/work/cairn-pi-ext/src/protocol.ts");
let vectors;
try {
  vectors = JSON.parse(readFileSync("/tmp/vectors.json", "utf8"));
} catch (err) {
  console.error("failed to load /tmp/vectors.json:", err.message);
  process.exit(1);
}
const out = vectors.map((v) => {
  const r = extractJson(v);
  return r === null ? { none: true } : { value: r };
});
writeFileSync("/tmp/ts-results.json", JSON.stringify(out, null, 1));
console.log("ts done:", out.length);
