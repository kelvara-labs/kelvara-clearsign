// G8 checks as pure functions over a replay report (the JSON printed by `kelvara replay --json`).
// The report schema belongs to the engine; ruleIds are pinned (engine announcement, M4).

export const DRIFT_SIGNATURES = [
  // BlockSec: create and approve
  "2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H",
  // BlockSec: approve and execute (AdvanceNonceAccount, proposalApprove, vaultTransactionExecute, UpdateAdmin)
  "4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1"
];

// PLAN.md G8: critical, with durable-nonce, approve-and-execute and UpdateAdmin claims.
// ruleIds pinned by the engine. The UpdateAdmin claim is authority.transfer and must name the Drift v2
// instruction updateAdmin (decoded from the vault transaction message) somewhere in the claim.
export const REQUIRED_CLAIMS = [
  { name: "durable-nonce", ruleId: "lifetime.durable_nonce" },
  { name: "approve-and-execute", ruleId: "squads.approve_and_execute" },
  { name: "UpdateAdmin", ruleId: "authority.transfer", mentions: /update[-_ ]?admin/i }
];

const LEVEL_KEYS = ["level", "severity", "risk", "rank", "verdict", "rating"];
const CONTAINERS = ["", "session", "summary", "result", "report"];

export function findLevel(report) {
  for (const c of CONTAINERS) {
    const obj = c ? report?.[c] : report;
    if (!obj || typeof obj !== "object") continue;
    for (const k of LEVEL_KEYS) {
      const v = obj[k];
      if (typeof v === "string" || typeof v === "number") return { path: c ? `${c}.${k}` : k, value: String(v) };
      if (v && typeof v === "object") for (const kk of LEVEL_KEYS) {
        if (typeof v[kk] === "string") return { path: `${c ? c + "." : ""}${k}.${kk}`, value: v[kk] };
      }
    }
  }
  return null;
}

export function collectClaims(node, out = []) {
  if (Array.isArray(node)) { for (const x of node) collectClaims(x, out); return out; }
  if (node && typeof node === "object") {
    if (typeof node.ruleId === "string") out.push(node);
    for (const v of Object.values(node)) collectClaims(v, out);
  }
  return out;
}

export function evaluateReplay(report) {
  const problems = [];
  if (!report || typeof report !== "object") return { status: "FAIL", detail: "no JSON report" };
  const level = findLevel(report);
  if (!level) problems.push("no level/severity field found");
  else if (!/^(critical|L4)$/i.test(level.value)) problems.push(`${level.path}=${level.value}, need critical`);
  // When the report carries an alert (kelvara.cli.result/v1: report.alert {label, claimIds}), it must agree
  // with the top-level level and each required claim must be one of the claims that raise it.
  const alert = report?.report?.alert ?? report?.alert;
  const alertIds = Array.isArray(alert?.claimIds) ? alert.claimIds : null;
  if (alert && typeof alert.label === "string" && !/^critical$/i.test(alert.label)) problems.push(`alert.label=${alert.label}, need Critical`);
  const claims = collectClaims(report);
  const found = [];
  for (const req of REQUIRED_CLAIMS) {
    const byRule = claims.filter((c) => c.ruleId === req.ruleId);
    const matching = req.mentions ? byRule.filter((c) => req.mentions.test(JSON.stringify(c))) : byRule;
    const hit = alertIds ? matching.find((c) => alertIds.includes(c.id)) : matching[0];
    if (!hit && matching.length && alertIds) problems.push(`claim ${req.ruleId} is not among alert.claimIds`);
    else if (hit) found.push(`${req.name}=${hit.ruleId}`);
    else if (byRule.length) problems.push(`claim ${req.ruleId} does not name ${req.mentions.source}`);
    else problems.push(`missing claim ${req.name} (${req.ruleId})`);
  }
  if (problems.length) return { status: "FAIL", detail: problems.join("; ") };
  return { status: "PASS", detail: `${level.value}; ${found.join(", ")}` };
}

// The CLI may print log lines before the report; take the last parseable top-level JSON value.
export function parseReportOutput(stdout) {
  const t = stdout.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const lines = t.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^[{[]/.test(lines[i])) continue;
    try { return JSON.parse(lines.slice(i).join("\n")); } catch { /* try next */ }
  }
  return null;
}

// Drift fixture (scenarios layout, fixtures/tx/drift-replay/<signature>.json): the stored bytes must hash
// to the stored sha256 and carry the expected signature.
export function checkTxFixture(fixture, signature, sha256hex) {
  if (!fixture || typeof fixture !== "object") return { status: "FAIL", detail: `${signature.slice(0, 8)}…: unreadable` };
  const p = [];
  if (fixture.signature !== signature) p.push("signature mismatch");
  if (fixture.network !== "mainnet") p.push(`network ${fixture.network}`);
  if (typeof fixture.transaction !== "string" || !fixture.transaction) p.push("no transaction bytes");
  else if (sha256hex(fixture.transaction) !== fixture.sha256) p.push("sha256 does not match bytes");
  return p.length ? { status: "FAIL", detail: `${signature.slice(0, 8)}…: ${p.join(", ")}` } : { status: "PASS", detail: `${signature.slice(0, 8)}… ok` };
}

// Devnet scenarios (G8 --live). The scenario scripts serve an attacker page by default and refuse to overwrite a
// setup, so G8 runs each one headless through the scenarios owner's own live test: run(kind, ['--reset',
// '--attack']) and its on-chain assertions (packages/scenarios/e2e-devnet/demo-devnet.test.mjs), one test per
// scenario, selected by name. Spends devnet SOL: run once per --live gate run, never in a loop.
export const DEVNET_TEST_FILE = "e2e-devnet/demo-devnet.test.mjs";
export function devnetCommand(script) {
  const kind = { "scenario:admin-devnet": "admin", "scenario:trap-devnet": "trap" }[script];
  if (!kind) throw new Error(`unknown devnet scenario ${script}`);
  return { cmd: process.execPath, args: ["--test", "--test-concurrency=1", `--test-name-pattern=^${kind}-devnet:`, DEVNET_TEST_FILE], cwdRel: "packages/scenarios" };
}

// node --test output: the run passes only if exactly one test ran and it passed (a name filter that matches
// nothing would otherwise exit 0 with "tests 0").
export function evaluateDevnetRun(status, output) {
  const num = (k) => Number((output.match(new RegExp(`^\\S*\\s*${k} (\\d+)`, "m")) ?? [])[1] ?? NaN);
  const tests = num("tests"), passed = num("pass"), failed = num("fail");
  if (status !== 0 || failed > 0) return { status: "FAIL", detail: `exit ${status}, ${Number.isNaN(failed) ? "?" : failed} failed` };
  if (tests !== 1 || passed !== 1) return { status: "FAIL", detail: `expected 1 passing test, got tests=${tests} pass=${passed}` };
  return { status: "PASS", detail: "1/1 live devnet test passed" };
}
