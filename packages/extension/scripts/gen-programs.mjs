// Writes src/options/programs-data.json from the bundled registry; run by `pnpm build` so new programs appear automatically.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgramList } from "./programs-list.mjs";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/options/programs-data.json");
const list = buildProgramList();
writeFileSync(out, JSON.stringify(list, null, 1) + "\n");
console.log(`programs -> ${list.length} entries`);
