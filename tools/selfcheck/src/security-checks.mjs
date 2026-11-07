// G10 checks as pure functions over a bundle (Map<path, Buffer>). The CLI wrapper is security.mjs.
// Each returns { status: "PASS"|"FAIL", detail, findings[] }.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

// Hosts the extension may name. PLAN.md: Helius RPC and APIs, plus localhost for localnet.
export const ALLOWED_HOSTS = new Set([
  "mainnet.helius-rpc.com", "devnet.helius-rpc.com",
  "api.helius.xyz", "api-mainnet.helius.xyz", "api-devnet.helius.xyz",
  "localhost", "127.0.0.1"
]);
// XML namespace URIs are identifiers, never fetched.
const NAMESPACE_URIS = [/^https?:\/\/www\.w3\.org\/(1999\/xhtml|2000\/svg|1998\/Math\/MathML|1999\/xlink|XML\/1998\/namespace|2000\/xmlns\/?)$/];
const TEXT_EXT = /\.(m?js|cjs|json|html?|css|map|txt|md|svg|webmanifest)$/i;
// Bare domains (no scheme) with common TLDs, e.g. "api.coingecko.com" in a string concatenation.
const BARE_DOMAIN = /(?<![\w.@/-])((?:[a-z0-9-]+\.)+(?:com|io|xyz|org|net|ai|dev|app|so|co|fi|finance|gg|me|sh|cloud|tech))(?![\w-])/gi;
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>)\\]+/gi;

export const MAX_PERMISSIONS = new Set(["storage"]);
export const ALLOWED_HOST_PERMISSIONS = new Set([
  "https://mainnet.helius-rpc.com/*", "https://devnet.helius-rpc.com/*",
  "https://api.helius.xyz/*", "https://api-mainnet.helius.xyz/*", "https://api-devnet.helius.xyz/*",
  "http://localhost:8899/*", "http://127.0.0.1:8899/*"
]);

const textFiles = (bundle) => [...bundle].filter(([name]) => TEXT_EXT.test(name)).map(([name, buf]) => [name, buf.toString("utf8")]);
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } };
const result = (findings, okDetail) => findings.length
  ? { status: "FAIL", detail: findings.slice(0, 5).join("; ") + (findings.length > 5 ? ` (+${findings.length - 5} more)` : ""), findings }
  : { status: "PASS", detail: okDetail, findings };

export function checkHosts(bundle) {
  const bad = new Map();
  for (const [name, text] of textFiles(bundle)) {
    for (const m of text.matchAll(URL_RE)) {
      const u = m[0].replace(/[.,;]+$/, "");
      if (NAMESPACE_URIS.some((re) => re.test(u))) continue;
      const h = hostOf(u);
      if (!h || ALLOWED_HOSTS.has(h)) continue;
      bad.set(h, bad.get(h) ?? `${h} in ${name}`);
    }
    for (const m of text.matchAll(BARE_DOMAIN)) {
      const h = m[1].toLowerCase();
      if (ALLOWED_HOSTS.has(h) || h === "www.w3.org") continue;
      bad.set(h, bad.get(h) ?? `${h} in ${name}`);
    }
  }
  return result([...bad.values()], "only Helius and localhost");
}

const FORBIDDEN_FILES = [/(^|\/)\.env(\.|$)/, /\.keypair\.json$/, /(^|\/)\.keys\//, /(^|\/)id\.json$/, /\.pem$/];
export function checkNoSecrets(bundle, secrets = []) {
  const f = [];
  for (const name of bundle.keys()) if (FORBIDDEN_FILES.some((re) => re.test(name))) f.push(`secret-like file ${name}`);
  for (const [name, buf] of bundle) {
    const text = buf.toString("latin1");
    for (const s of secrets) if (s && text.includes(s)) f.push(`HELIUS_API_KEY value in ${name}`);
    if (/api[-_]?key=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) f.push(`api-key=<uuid> in ${name}`);
    if (/["']?HELIUS_API_KEY["']?\s*[:=]\s*["'][0-9a-f-]{36}["']/i.test(text)) f.push(`HELIUS_API_KEY literal in ${name}`);
  }
  return result(f, secrets.length ? "no key (checked against .env value and patterns)" : "no key (pattern check; .env not present)");
}

const REMOTE_CODE = [
  [/(?<![\w$.])eval\s*\(/, "eval("],
  [/\bnew\s+Function\s*\(/, "new Function("],
  [/(?<![\w$.])Function\s*\(\s*["'`]/, "Function(string)"],
  [/\bset(?:Timeout|Interval)\s*\(\s*["'`]/, "setTimeout/setInterval(string)"],
  [/\bimportScripts\s*\(\s*["'`](?:https?:)?\/\//, "importScripts(remote)"],
  [/\bimport\s*\(\s*["'`](?:https?:)?\/\//, "import(remote)"],
  [/<script[^>]+src\s*=\s*["'](?:https?:)?\/\//i, "<script src=remote>"]
];
export function checkNoRemoteCode(bundle, manifest) {
  const f = [];
  for (const [name, text] of textFiles(bundle)) {
    if (name.endsWith(".map")) continue;
    for (const [re, label] of REMOTE_CODE) if (re.test(text)) f.push(`${label} in ${name}`);
  }
  const csp = manifest?.content_security_policy;
  const cspText = typeof csp === "string" ? csp : Object.values(csp ?? {}).join(" ");
  if (/'unsafe-eval'/.test(cspText)) f.push("CSP allows 'unsafe-eval'");
  if (/script-src[^;]*(https?:|\*)/.test(cspText)) f.push("CSP allows remote script sources");
  return result(f, "no eval, no remote code");
}

export function checkPermissions(manifest) {
  if (!manifest) return { status: "FAIL", detail: "manifest.json missing", findings: [] };
  const f = [];
  if (manifest.manifest_version !== 3) f.push(`manifest_version ${manifest.manifest_version} (need 3)`);
  for (const p of manifest.permissions ?? []) if (!MAX_PERMISSIONS.has(p)) f.push(`permission ${p}`);
  for (const p of manifest.optional_permissions ?? []) f.push(`optional permission ${p}`);
  for (const h of [...(manifest.host_permissions ?? []), ...(manifest.optional_host_permissions ?? [])]) {
    if (!ALLOWED_HOST_PERMISSIONS.has(h)) f.push(`host permission ${h}`);
  }
  const ec = manifest.externally_connectable;
  if (ec && (ec.ids?.includes("*") || (ec.matches ?? []).some((m) => m.includes("<all_urls>") || /^\*:\/\/\*\//.test(m)))) {
    f.push("externally_connectable is open to all");
  }
  if (manifest.update_url) f.push("update_url set (remote updates)");
  return result(f, `permissions [${(manifest.permissions ?? []).join(",")}], ${(manifest.host_permissions ?? []).length} host(s)`);
}

// Product license: the extension verifies offline against the public key in config/.
export function checkLicenseKeyEmbedded(bundle, publicKey) {
  if (!publicKey) return { status: "FAIL", detail: "config/license-public-key.txt missing", findings: [] };
  for (const [, text] of textFiles(bundle)) if (text.includes(publicKey)) return { status: "PASS", detail: "license public key embedded", findings: [] };
  return { status: "FAIL", detail: "license public key from config/license-public-key.txt not found in bundle", findings: [] };
}

// Dependency licenses, read offline from node_modules. No AGPL, BUSL or MPL in core or extension.
const FORBIDDEN_LICENSE = /\b(AGPL|BUSL|BSL-1\.1|MPL|SSPL|GPL)/i;
function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return null;
}
export function licenseForbidden(spdx) {
  if (!spdx) return true;
  const alternatives = spdx.replace(/[()]/g, "").split(/\s+OR\s+/i);
  return alternatives.every((a) => FORBIDDEN_LICENSE.test(a) && !/LGPL/i.test(a)) || /UNLICENSED/i.test(spdx) && alternatives.length === 1;
}
function resolveDep(fromDir, dep) {
  let cur = fromDir;
  for (;;) {
    const cand = path.basename(cur) === "node_modules" ? path.join(cur, dep) : path.join(cur, "node_modules", dep);
    if (existsSync(path.join(cand, "package.json"))) return realpathSync(cand);
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
export function checkDependencyLicenses(root, packageDirs, licensesMd, waivers = {}) {
  const f = [], seen = new Map();
  const direct = new Set();
  const queue = [];
  for (const dir of packageDirs) {
    const pj = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8"));
    for (const d of Object.keys(pj.dependencies ?? {})) {
      direct.add(d);
      queue.push([path.join(root, dir), d, dir]);
    }
  }
  while (queue.length) {
    const [from, dep, via] = queue.shift();
    const at = resolveDep(from, dep);
    if (!at) { f.push(`${dep} (from ${via}) not installed`); continue; }
    if (seen.has(at)) continue;
    const pj = JSON.parse(readFileSync(path.join(at, "package.json"), "utf8"));
    if (pj.name?.startsWith("@kelvara/")) { seen.set(at, "workspace"); queue.push(...Object.keys(pj.dependencies ?? {}).map((d) => [at, d, pj.name])); continue; }
    const lic = licenseOf(pj);
    seen.set(at, lic);
    const id = `${pj.name}@${pj.version}`;
    if (licenseForbidden(lic) && !waivers[pj.name]) f.push(`${id} license ${lic ?? "UNKNOWN"} (via ${via})`);
    for (const d of Object.keys(pj.dependencies ?? {})) queue.push([at, d, pj.name]);
  }
  for (const d of direct) {
    if (d.startsWith("@kelvara/")) continue;
    if (!licensesMd.includes(d)) f.push(`${d} missing from LICENSES.md`);
  }
  return result(f, `${seen.size} packages, ${direct.size} direct, none AGPL/BUSL/MPL`);
}
