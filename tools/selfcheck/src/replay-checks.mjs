// G8 checks as pure functions over a replay report (the JSON printed by `kelvara replay --json`).
// The report schema belongs to the engine; these checks read it defensively and should be pinned
// to exact ruleIds once the engine publishes them (see REQUIRED_CLAIMS).

export const DRIFT_SIGNATURES = [
  // BlockSec: create and approve
  "2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H",
  // BlockSec: approve and execute (AdvanceNonceAccount, proposalApprove, vaultTransactionExecute, UpdateAdmin)
  "4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1"
];

// PLAN.md G8: critical, with durable-nonce, approve-and-execute and UpdateAdmin claims.
// Each matcher is tried on the claim's ruleId first, then on the whole claim.
export const REQUIRED_CLAIMS = [
  { name: "durable-nonce", re: /durable[-_ ]?nonce|advance[-_ ]?nonce/i },
  { name: "approve-and-execute", re: /approve[-_ ]?(and[-_ ]?)?execute|approve[\s\S]{0,200}execute/i },
  { name: "UpdateAdmin", re: /update[-_ ]?admin/i }
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
  const claims = collectClaims(report);
  const found = [];
  for (const req of REQUIRED_CLAIMS) {
    const hit = claims.find((c) => req.re.test(c.ruleId)) ?? claims.find((c) => req.re.test(JSON.stringify(c)));
    if (hit) found.push(`${req.name}=${hit.ruleId}`);
    else problems.push(`missing claim ${req.name}`);
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
