#!/usr/bin/env node
// pnpm selfcheck [--fast] [--only G1,G6] [--write] [--live] [--verbose] [--allow-dirty]
//   --fast         G1–G4 only
//   --only <ids>   run just these gates (comma-separated, e.g. G1,G8)
//   --write        rewrite SELFCHECK.md (verifier only; refuses on a dirty tree unless --allow-dirty)
//   --live         passed through to gates as KELVARA_LIVE=1 (G5, G8 live RPC)
//   --verbose      stream gate output to the terminal (always written to tools/selfcheck/logs/<gate>.log)
// Gate commands: exit 0 = PASS, exit 78 = PENDING (never PASS), anything else = FAIL.
// A line "SELFCHECK-SUMMARY: <text>" in a gate's output becomes the scoreboard note.
// Exit: 0 when no gate FAILs, 1 when any gate FAILs, 2 on a usage error.
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import { GATES, PENDING_EXIT } from "./gates.mjs";
import { ROOT, failNote, makeRedactor } from "./lib.mjs";

const args = process.argv.slice(2);
const KNOWN = new Set(["--fast", "--only", "--write", "--live", "--verbose", "--allow-dirty"]);
function usage(msg) { console.error(`selfcheck: ${msg}`); process.exit(2); }
for (let i = 0; i < args.length; i++) {
  if (!KNOWN.has(args[i])) usage(`unknown argument ${args[i]}`);
  if (args[i] === "--only") i++;
}
const fast = args.includes("--fast");
const write = args.includes("--write");
const live = args.includes("--live");
const verbose = args.includes("--verbose") || !!process.env.SELFCHECK_VERBOSE;
const allowDirty = args.includes("--allow-dirty");
const onlyIdx = args.indexOf("--only");
let only = null;
if (onlyIdx >= 0) {
  const v = args[onlyIdx + 1];
  if (!v || v.startsWith("--")) usage("--only needs a list such as G1,G8");
  only = new Set(v.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
  const unknown = [...only].filter((id) => !GATES.some((g) => g.id === id));
  if (unknown.length) usage(`unknown gate(s) ${unknown.join(",")}`);
}

const redact = makeRedactor();
const env = { ...process.env, FORCE_COLOR: "0", ...(live ? { KELVARA_LIVE: "1" } : {}) };
const LOGS = path.join(ROOT, "tools/selfcheck/logs");
mkdirSync(LOGS, { recursive: true });

const git = (...a) => {
  try { return execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
};
const commit = git("rev-parse", "--short", "HEAD") ?? "unknown";
const branch = git("rev-parse", "--abbrev-ref", "HEAD") ?? "unknown";
// Dirty = tracked or untracked changes other than the scoreboard itself.
const dirtyFiles = (git("status", "--porcelain", "--untracked-files=normal") ?? "")
  .split("\n").filter(Boolean).filter((l) => !/\sSELFCHECK\.md$/.test(l));
const dirty = dirtyFiles.length > 0;
if (write && dirty && !allowDirty) {
  usage(`--write refused: working tree is dirty (${dirtyFiles.length} change(s)); run on a fresh checkout or pass --allow-dirty`);
}

// Run one command in its own process group; tee redacted output to the gate log.
function runCmd(cmd, log, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    log.write(`\n$ ${cmd}\n`);
    const child = spawn(cmd, { cwd: ROOT, shell: true, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let tail = [], timedOut = false, pendingLine = "";
    const onData = (buf) => {
      const text = pendingLine + buf.toString("utf8");
      const lines = text.split("\n");
      pendingLine = lines.pop();
      for (const l of lines) emit(l);
    };
    const emit = (line) => {
      const r = redact(line);
      log.write(r + "\n");
      if (verbose) process.stdout.write(`  | ${r}\n`);
      tail.push(r);
      if (tail.length > 200) tail = tail.slice(-100);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, 5000).unref();
    }, timeoutMs);
    child.on("error", (e) => emit(`spawn error: ${e.message}`));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (pendingLine) emit(pendingLine);
      // Reap anything the command left running in its group (validators, servers).
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      log.write(`# exit ${code ?? "null"}${signal ? ` signal ${signal}` : ""}${timedOut ? " (timeout)" : ""} after ${secs}s\n`);
      resolve({ code, signal, timedOut, tail });
    });
  });
}

let running = null;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (running) { try { process.kill(-running, "SIGTERM"); } catch { /* gone */ } }
    process.exit(130);
  });
}

const rows = [];
let failed = false;
const startedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
for (const g of GATES) {
  const selected = only ? only.has(g.id) : !fast || g.fast;
  if (!selected) { rows.push({ g, status: "SKIPPED", secs: 0, note: fast ? "(--fast)" : "" }); continue; }
  const logPath = path.join(LOGS, `${g.id}.log`);
  rmSync(logPath, { force: true });
  const log = createWriteStream(logPath);
  log.write(`# ${g.id} ${g.name}  ${startedAt}  commit ${commit}${dirty ? "-dirty" : ""}  branch ${branch}${live ? "  live" : ""}\n`);
  const t0 = Date.now();
  let status = "PASS", note = "";
  for (const cmd of g.cmds) {
    const r = await runCmd(cmd, log, g.timeoutMs ?? 15 * 60_000);
    const summary = [...r.tail].reverse().map((l) => l.match(/^SELFCHECK-SUMMARY: (.*)$/)).find(Boolean);
    if (r.timedOut) { status = "FAIL"; note = `${cmd}: timeout after ${Math.round((g.timeoutMs ?? 900_000) / 1000)}s`; break; }
    if (r.code === PENDING_EXIT) { status = "PENDING"; note = summary ? `(milestone ${g.milestone}) ${summary[1]}` : `(milestone ${g.milestone})`; break; }
    if (r.code !== 0) {
      status = "FAIL";
      note = `${cmd}: ${failNote(r.tail, r.code ?? r.signal)}`.slice(0, 200);
      break;
    }
    if (summary) note = summary[1];
  }
  await new Promise((res) => log.end(res));
  if (status === "FAIL") failed = true;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  rows.push({ g, status, secs, note });
  console.log(`${g.id.padEnd(4)}${g.name.padEnd(13)}${status.padEnd(9)}${String(secs).padStart(6)}s  ${note}`.trimEnd());
  if (status === "FAIL") console.log(`    log: ${path.relative(ROOT, logPath)}`);
}

const board = [
  `Kelvara selfcheck  ${startedAt}  commit ${commit}${dirty ? "-dirty" : ""}${fast ? "  (--fast)" : ""}${live ? "  (--live)" : ""}`,
  ...rows.map(({ g, status, secs, note }) =>
    `${g.id.padEnd(4)}${g.name.padEnd(13)}${status.padEnd(9)}${status === "SKIPPED" ? "" : `${secs}s`}  ${note}`.trimEnd())
];
console.log("\n" + board.join("\n"));
writeFileSync(path.join(LOGS, "summary.json"), JSON.stringify({
  startedAt, commit, branch, dirty, fast, live,
  gates: rows.map(({ g, status, secs, note }) => ({ id: g.id, name: g.name, status, secs: Number(secs), note }))
}, null, 2) + "\n");
if (write) {
  writeFileSync(path.join(ROOT, "SELFCHECK.md"), redact("```\n" + board.join("\n") + "\n```\n"));
  console.log("wrote SELFCHECK.md");
}
process.exit(failed ? 1 : 0);
