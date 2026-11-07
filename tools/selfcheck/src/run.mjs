#!/usr/bin/env node
// pnpm selfcheck [--fast] [--only G1,G6] [--write] [--live]
//   --fast   G1–G4 only
//   --write  rewrite SELFCHECK.md (verifier only)
//   --live   passed through to gates as KELVARA_LIVE=1 (G5, G8 live RPC)
// Exit: 0 when no gate FAILs, 1 otherwise. PENDING is reported, never counted as PASS.
import { spawnSync, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GATES, PENDING_EXIT } from "./gates.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const fast = args.includes("--fast");
const write = args.includes("--write");
const live = args.includes("--live");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(",")) : null;

const redact = (s) => s.replace(/api-key=[^&\s"']+/gi, "api-key=REDACTED");
const env = { ...process.env, ...(live ? { KELVARA_LIVE: "1" } : {}) };

let commit = "unknown";
try { commit = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(); } catch { /* no git */ }

const rows = [];
let failed = false;
for (const g of GATES) {
  const selected = only ? only.has(g.id) : !fast || g.fast;
  if (!selected) { rows.push({ g, status: "SKIPPED", secs: 0, note: fast ? "(--fast)" : "" }); continue; }
  const t0 = Date.now();
  let status = "PASS", note = "";
  for (const cmd of g.cmds) {
    const r = spawnSync(cmd, { cwd: root, shell: true, env, encoding: "utf8", maxBuffer: 64 << 20 });
    const out = redact((r.stdout ?? "") + (r.stderr ?? ""));
    if (r.status === PENDING_EXIT) {
      status = "PENDING"; note = `(milestone ${g.milestone})`; break;
    }
    if (r.status !== 0) {
      status = "FAIL";
      const lines = out.trim().split("\n").filter(Boolean);
      note = `${cmd}: ${lines.slice(-1)[0] ?? `exit ${r.status}`}`.slice(0, 200);
      if (process.env.SELFCHECK_VERBOSE) console.error(out);
      break;
    }
    const summary = out.match(/^SELFCHECK-SUMMARY: (.*)$/m);
    if (summary) note = summary[1];
  }
  if (status === "FAIL") failed = true;
  rows.push({ g, status, secs: ((Date.now() - t0) / 1000).toFixed(1), note });
  console.log(`${g.id.padEnd(4)}${g.name.padEnd(13)}${status.padEnd(9)}${String(rows.at(-1).secs).padStart(6)}s  ${note}`);
}

const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const board = [
  `Kelvara selfcheck  ${now}  commit ${commit}${fast ? "  (--fast)" : ""}`,
  ...rows.map(({ g, status, secs, note }) =>
    `${g.id.padEnd(4)}${g.name.padEnd(13)}${status.padEnd(9)}${status === "SKIPPED" ? "" : `${secs}s`}  ${note}`.trimEnd())
];
console.log("\n" + board.join("\n"));
if (write) writeFileSync(path.join(root, "SELFCHECK.md"), "```\n" + board.join("\n") + "\n```\n");
process.exit(failed ? 1 : 0);
