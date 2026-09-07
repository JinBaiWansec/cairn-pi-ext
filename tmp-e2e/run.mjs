import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
await jiti.import(new URL("./e2e.ts", import.meta.url).pathname);
