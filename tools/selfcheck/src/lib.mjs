// Shared helpers for the selfcheck runner and the composite gates (G8, G10).
// No dependencies: node built-ins only, so the gates run before `pnpm install` finishes anything else.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const PENDING_EXIT = 78;

// .env lives only in the main checkout. From any worktree it is <git-common-dir>/../.env.
export function envFilePath(cwd = ROOT) {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return path.resolve(common, "..", ".env");
  } catch {
    return path.join(cwd, ".env");
  }
}

// Parse KEY=VALUE lines; supports quotes, comments and ${VAR} expansion. Never logs values.
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    v = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => out[k] ?? process.env[k] ?? "");
    out[m[1]] = v;
  }
  return out;
}

export function loadEnv(cwd = ROOT) {
  const file = envFilePath(cwd);
  if (!existsSync(file)) return {};
  try { return parseEnv(readFileSync(file, "utf8")); } catch { return {}; }
}

// Values that must never reach a log, a report or SELFCHECK.md.
export function secretValues(env = loadEnv()) {
  const vals = new Set();
  for (const k of ["HELIUS_API_KEY"]) {
    const v = env[k] ?? process.env[k];
    if (v && v.length >= 8) vals.add(v);
  }
  return [...vals];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function makeRedactor(secrets = secretValues()) {
  const literal = secrets.length ? new RegExp(secrets.map(escapeRe).join("|"), "g") : null;
  return (s) => {
    let r = String(s)
      .replace(/(api[-_]?key=)[^&\s"'<>]+/gi, "$1REDACTED")
      .replace(/("api[-_]?key"\s*:\s*")[^"]+/gi, "$1REDACTED");
    if (literal) r = r.replace(literal, "REDACTED");
    return r;
  };
}

// Composite gate result: FAIL beats PENDING beats PASS. Prints one SELFCHECK-SUMMARY line.
export function finish(gate, checks) {
  for (const c of checks) {
    const tag = c.status.padEnd(7);
    console.log(`${gate} ${tag} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  }
  const fails = checks.filter((c) => c.status === "FAIL");
  const pend = checks.filter((c) => c.status === "PENDING");
  if (fails.length) {
    console.log(`SELFCHECK-SUMMARY: ${fails.map((c) => `${c.name}: ${c.detail}`).join("; ")}`.slice(0, 400));
    process.exit(1);
  }
  if (pend.length) {
    console.log(`SELFCHECK-SUMMARY: waiting on ${pend.map((c) => c.name).join(", ")}`);
    process.exit(PENDING_EXIT);
  }
  console.log(`SELFCHECK-SUMMARY: ${checks.map((c) => c.summary ?? c.name).join(", ")}`);
  process.exit(0);
}

export const pass = (name, detail = "", summary) => ({ name, status: "PASS", detail, summary });
export const fail = (name, detail) => ({ name, status: "FAIL", detail });
export const pending = (name, detail) => ({ name, status: "PENDING", detail });

// One-line FAIL note from the tail of a failed gate command. Prefer, in order: a SELFCHECK-SUMMARY line, the
// gate's own scoreboard line ("G6  localnet     FAIL     21.4  missing claim x"), the first error-looking line,
// the last meaningful line. A gate runner may log an expected "FAIL" probe before its verdict (G6 reports a
// post-attack localnet, then resets it), so the runner's own verdict line must win over the first match.
export function failNote(rawTail, code) {
  // eslint-disable-next-line no-control-regex -- strips ANSI colour codes
  const tail = rawTail.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  const summary = [...tail].reverse().map((l) => l.match(/^SELFCHECK-SUMMARY: (.*)$/)).find(Boolean);
  if (summary) return summary[1];
  const verdict = [...tail].reverse().map((l) => l.match(/^G\d+\s+\S+\s+FAIL\s+[\d.]+s?\s+(.*)$/)).find(Boolean);
  if (verdict) return verdict[1].trim();
  const noise = /ELIFECYCLE|ERR_PNPM_RECURSIVE|^\s*$|^> |^\s*at |^# exit/;
  const meaningful = tail.filter((l) => !noise.test(l));
  const firstError = meaningful.find((l) => /\berror\b|✖|FAIL|Error:/i.test(l));
  return firstError?.trim() ?? meaningful.at(-1)?.trim() ?? `exit ${code}`;
}
