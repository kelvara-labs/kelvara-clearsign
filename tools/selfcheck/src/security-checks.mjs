// G10 checks as pure functions over a bundle (Map<path, Buffer>). The CLI wrapper is security.mjs.
// Each returns { status: "PASS"|"FAIL", detail, findings[] }.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { findSinkTargets, findHtmlSinkTargets } from "./host-sinks.mjs";

// Hosts the extension may name. PLAN.md: Helius RPC and APIs, plus localhost for localnet.
export const ALLOWED_HOSTS = new Set([
  "mainnet.helius-rpc.com", "devnet.helius-rpc.com",
  "api.helius.xyz", "api-mainnet.helius-rpc.com",
  "localhost", "127.0.0.1", "[::1]"
]);
// A host built at runtime (`https://${net}.helius-rpc.com`) passes only if its static tail is a Helius domain.
const DYNAMIC_HOST_OK = /^[^/?#]*\$\{[^}]*\}[^/?#]*\.helius-rpc\.com(:\d+)?$/i;
// Minified code reads like domains ("n.wallet", "window.top", "console.info"): skip bare matches whose first
// label is a short identifier or a JS/browser global. Real hosts with a scheme are always checked.
const JS_GLOBALS = new Set(["window", "self", "globalthis", "document", "console", "location", "navigator", "chrome",
  "this", "top", "parent", "frames", "math", "json", "object", "reflect", "promise", "symbol", "array", "number",
  "string", "crypto", "performance", "history", "event", "module", "exports", "process", "require", "error", "date"]);
const looksLikeCode = (h) => { const first = h.split(".")[0]; return first.length <= 2 || JS_GLOBALS.has(first); };
// Manifest match patterns that are not network hosts: the hook must run on any dApp (coordinator, X1).
export const ALLOWED_CONTENT_MATCHES = new Set(["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]);
function manifestForHostScan(text) {
  try {
    const m = JSON.parse(text);
    for (const cs of m.content_scripts ?? []) { delete cs.matches; delete cs.exclude_matches; }
    for (const war of m.web_accessible_resources ?? []) delete war.matches;
    return JSON.stringify(m);
  } catch { return text; }
}
// XML namespace URIs are identifiers, never fetched.
const NAMESPACE_URIS = [/^https?:\/\/www\.w3\.org\/(1999\/xhtml|2000\/svg|1998\/Math\/MathML|1999\/xlink|XML\/1998\/namespace|2000\/xmlns\/?)$/];
const TEXT_EXT = /\.(m?js|cjs|json|html?|css|map|txt|md|svg|webmanifest)$/i;
// Bare domains (no scheme) with common TLDs, e.g. "api.coingecko.com" in a string concatenation.
const BARE_DOMAIN = /(?<![\w.@/-])((?:[a-z0-9-]+\.)+(?:com|io|xyz|org|net|ai|dev|app|so|co|fi|finance|gg|me|sh|cloud|tech|info|biz|site|online|link|top|ws|to|ly|cc|tv|us|uk|de|network|exchange|money|wallet|trade|fun|pro|live|run|page|workers\.dev|vercel\.app))(?![\w-])/gi;
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>)\\]+/gi;

export const MAX_PERMISSIONS = new Set(["storage"]);
export const ALLOWED_HOST_PERMISSIONS = new Set([
  "https://mainnet.helius-rpc.com/*", "https://devnet.helius-rpc.com/*",
  "https://api.helius.xyz/*", "https://api-mainnet.helius-rpc.com/*",
  "http://localhost:8899/*", "http://127.0.0.1:8899/*"
]);

const textFiles = (bundle) => [...bundle].filter(([name]) => TEXT_EXT.test(name)).map(([name, buf]) => [name, buf.toString("utf8")]);
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } };
const result = (findings, okDetail) => findings.length
  ? { status: "FAIL", detail: findings.slice(0, 5).join("; ") + (findings.length > 5 ? ` (+${findings.length - 5} more)` : ""), findings }
  : { status: "PASS", detail: okDetail, findings };

// Inert strings (V10): a non-Helius host may appear in the bundle only as an audited entry of
// tools/selfcheck/inert-hosts.json: { string (exact occurrence), file (bundle file), reason (one line) }. No wildcards,
// no patterns. The allowlist never covers a network target: any host that reaches a sink (host-sinks.mjs) FAILs.
export function validateInertEntries(entries) {
  const bad = [];
  for (const [i, e] of (entries ?? []).entries()) {
    const where = `inert-hosts.json entry ${i}`;
    if (!e || typeof e.string !== "string" || typeof e.file !== "string" || typeof e.reason !== "string") { bad.push(`${where}: needs string, file, reason`); continue; }
    if (!e.reason.trim() || e.reason.includes("\n")) bad.push(`${where}: reason must be one non-empty line`);
    if (/[*?]|^\/.*\/$/.test(e.file) || e.string.includes("*")) bad.push(`${where}: wildcards are not allowed`);
    if (e.string.length < 8) bad.push(`${where}: string too short to be an exact occurrence`);
  }
  return bad;
}
const fileMatches = (name, file) => name === file || name.endsWith(`/${file}`);
const isJs = (name) => /\.(m?js|cjs)$/i.test(name);
const dynamicOk = (auth) => DYNAMIC_HOST_OK.test(auth);

/** Host strings in a file: [{ host, str, dynamic }] (str = the exact occurrence an allowlist entry must equal). */
function hostOccurrences(text) {
  const out = [];
  for (const m of text.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;]+$/, "");
    if (NAMESPACE_URIS.some((re) => re.test(u))) continue;
    const auth = u.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0].replace(/^[^@]*@/, "");
    if (auth.includes("${")) { if (!dynamicOk(auth)) out.push({ host: auth, str: u, dynamic: true }); continue; }
    const h = hostOf(u);
    if (h && ALLOWED_HOSTS.has(h)) continue;
    out.push({ host: h ?? auth, str: u, dynamic: false });
  }
  for (const m of text.matchAll(BARE_DOMAIN)) {
    const h = m[1].toLowerCase();
    if (ALLOWED_HOSTS.has(h) || h === "www.w3.org" || looksLikeCode(h)) continue;
    const tail = text.slice(m.index + m[1].length).match(/^[^\s"'`<>)\\,]*/)[0];
    out.push({ host: h, str: m[1] + tail, dynamic: false });
  }
  return out;
}

export function checkHosts(bundle, inert = []) {
  const bad = new Map();
  const flag = (key, msg) => { if (!bad.has(key)) bad.set(key, msg); };
  for (const msg of validateInertEntries(inert)) flag(msg, msg);
  const used = new Set();
  let sinks = 0, allowed = 0;
  for (const [name, raw] of textFiles(bundle)) {
    const text = /(^|\/)manifest\.json$/.test(name) ? manifestForHostScan(raw) : raw;
    // 1. Every non-Helius host string needs an audited inert entry.
    for (const o of hostOccurrences(text)) {
      const entry = inert.findIndex((e) => e && e.string === o.str && fileMatches(name, e.file));
      if (entry >= 0) { used.add(entry); allowed++; continue; }
      flag(`${o.str}|${name}`, o.dynamic ? `dynamic host ${o.host} in ${name} ("${o.str}")` : `${o.host} in ${name} ("${o.str}" not in inert-hosts.json)`);
    }
    // 2. Network targets: nothing but Helius/localhost may reach a sink, allowlisted or not.
    const targets = isJs(name) ? findSinkTargets(text, name) : /\.html?$/i.test(name) ? findHtmlSinkTargets(text) : [];
    sinks += targets.length;
    for (const t of targets) for (const h of t.hosts) {
      if (h.dynamic ? dynamicOk(h.host) : ALLOWED_HOSTS.has(h.host)) continue;
      if (NAMESPACE_URIS.some((re) => re.test(h.url))) continue;
      flag(`sink|${h.host}|${name}`, `${h.dynamic ? "dynamic host " : ""}${h.host} reaches ${t.sink} in ${name}:${t.line} (network target; inert allowlist does not apply)`);
    }
  }
  const unused = inert.map((e, i) => (used.has(i) ? null : e?.string)).filter(Boolean);
  const note = unused.length ? `; ${unused.length} inert entr${unused.length === 1 ? "y" : "ies"} not seen (stale?)` : "";
  return result([...bad.values()], `only Helius and localhost reach ${sinks} network sink(s); ${allowed} audited inert string occurrence(s)${note}`);
}

const FORBIDDEN_FILES = [/(^|\/)\.env(\.|$)/, /\.keypair\.json$/, /(^|\/)\.keys\//, /(^|\/)id\.json$/, /\.pem$/];
// Forms a key can take in a bundle: as is, without dashes, upper-case, URL-encoded, hex, base64 (all three
// alignments, so a key embedded inside a longer base64 string is still found) and reversed.
export function secretVariants(secret) {
  const v = new Set([secret, secret.replace(/-/g, ""), secret.toUpperCase(), encodeURIComponent(secret),
    Buffer.from(secret).toString("hex"), [...secret].reverse().join("")]);
  for (let pad = 0; pad < 3; pad++) {
    const b64 = Buffer.concat([Buffer.alloc(pad), Buffer.from(secret)]).toString("base64");
    // drop the chars touched by padding at either end; keep the stable middle (>= 16 chars for a uuid)
    const start = pad ? Math.ceil((pad * 8) / 6) + 1 : 0;
    const mid = b64.slice(start, b64.length - 4);
    if (mid.length >= 16) { v.add(mid); v.add(mid.replace(/\+/g, "-").replace(/\//g, "_")); }
  }
  return [...v].filter((x) => x.length >= 8);
}
export function checkNoSecrets(bundle, secrets = [], rawArchive = null) {
  const f = [];
  for (const name of bundle.keys()) if (FORBIDDEN_FILES.some((re) => re.test(name))) f.push(`secret-like file ${name}`);
  const variants = secrets.filter(Boolean).flatMap(secretVariants);
  const hay = [...bundle];
  if (rawArchive) hay.push(["<zip archive bytes>", rawArchive]);
  for (const [name, buf] of hay) {
    const text = buf.toString("latin1");
    const lower = text.toLowerCase();
    if (variants.some((s) => text.includes(s) || lower.includes(s.toLowerCase()))) f.push(`HELIUS_API_KEY value (or an encoding of it) in ${name}`);
    if (/api[-_]?key=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) f.push(`api-key=<uuid> in ${name}`);
    if (/["']?HELIUS_API_KEY["']?\s*[:=]\s*["'][0-9a-f-]{36}["']/i.test(text)) f.push(`HELIUS_API_KEY literal in ${name}`);
  }
  return result([...new Set(f)], secrets.length ? "no key (checked against .env value, its encodings and patterns)" : "no key (pattern check; .env not present)");
}

const REMOTE_CODE = [
  [/(?<![\w$.])eval\s*\(/, "eval("],
  [/\bnew\s+Function\s*\(/, "new Function("],
  [/(?<![\w$.])Function\s*\(\s*["'`]/, "Function(string)"],
  [/\bset(?:Timeout|Interval)\s*\(\s*["'`]/, "setTimeout/setInterval(string)"],
  [/\bimportScripts\s*\(\s*["'`](?:https?:)?\/\//, "importScripts(remote)"],
  [/\bimport\s*\(\s*["'`](?:https?:)?\/\//, "import(remote)"],
  [/<script[^>]+src\s*=\s*["'](?:https?:)?\/\//i, "<script src=remote>"],
  [/\bconstructor\.constructor\s*\(/, "constructor.constructor("],
  [/\bexecuteScript\s*\(\s*\{[^}]*\bcode\s*:/, "executeScript({code})"],
  [/\bWebAssembly\.(?:instantiate|compile)Streaming\s*\(\s*fetch\s*\(\s*["'`](?:https?:)?\/\//, "remote wasm"]
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
  const connect = cspText.match(/connect-src([^;]*)/);
  if (connect) for (const src of connect[1].trim().split(/\s+/)) {
    if (!src || src.startsWith("'")) continue;
    const h = src === "*" ? "*" : hostOf(/^[a-z]+:\/\//i.test(src) ? src.replace("*.", "x.") : `https://${src}`);
    if (src === "*" || !h || !(ALLOWED_HOSTS.has(h) || /\.helius-rpc\.com$/.test(h) && src.includes("*."))) f.push(`CSP connect-src allows ${src}`);
  }
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
  for (const cs of manifest.content_scripts ?? []) {
    for (const m of cs.matches ?? []) if (!ALLOWED_CONTENT_MATCHES.has(m)) f.push(`content_scripts match ${m}`);
  }
  for (const war of manifest.web_accessible_resources ?? []) {
    for (const m of war.matches ?? []) if (!ALLOWED_CONTENT_MATCHES.has(m)) f.push(`web_accessible_resources match ${m}`);
  }
  const ec = manifest.externally_connectable;
  if (ec && (ec.ids?.includes("*") || (ec.matches ?? []).some((m) => m.includes("<all_urls>") || /^\*:\/\/\*\//.test(m)))) {
    f.push("externally_connectable is open to all");
  }
  if (manifest.update_url) f.push("update_url set (remote updates)");
  return result(f, `permissions [${(manifest.permissions ?? []).join(",")}], ${(manifest.host_permissions ?? []).length} host(s)`);
}

// Content scripts (main-world hook and isolated bridge) never talk to the network: the service worker does,
// so all traffic goes through host_permissions and the Helius adapter.
const NETWORK_API = [
  [/(?<![\w$.])fetch\s*\(/, "fetch("], [/\bXMLHttpRequest\b/, "XMLHttpRequest"], [/\bnew\s+WebSocket\b/, "WebSocket"],
  [/\bsendBeacon\s*\(/, "sendBeacon("], [/\bnew\s+EventSource\b/, "EventSource"], [/\bRTCPeerConnection\b/, "RTCPeerConnection"]
];
export function checkContentScriptsOffline(bundle, manifest) {
  const f = [], files = new Set();
  for (const cs of manifest?.content_scripts ?? []) for (const js of cs.js ?? []) files.add(js.replace(/^\.?\//, ""));
  for (const name of files) {
    const buf = bundle.get(name) ?? [...bundle].find(([n]) => n.endsWith(`/${name}`))?.[1];
    if (!buf) { f.push(`content script ${name} missing from bundle`); continue; }
    const text = buf.toString("utf8");
    for (const [re, label] of NETWORK_API) if (re.test(text)) f.push(`${label} in content script ${name}`);
  }
  return result(f, `${files.size} content script(s) make no network calls`);
}

// No page control over settings (V6). A web page has no chrome.* API, so it can reach the extension only through
// externally_connectable / onMessageExternal / onConnectExternal, or through a content script that writes storage.
// None of these may exist: the hold-skipping settings (passThrough) stay unreachable from any page.
export function checkNoPageControl(bundle, manifest) {
  const f = [];
  if (manifest && "externally_connectable" in manifest) f.push("manifest declares externally_connectable");
  for (const [name, text] of textFiles(bundle)) {
    if (/\bon(Message|Connect)External\b/.test(text)) f.push(`onMessageExternal/onConnectExternal in ${name}`);
  }
  const cs = new Set();
  for (const c of manifest?.content_scripts ?? []) for (const js of c.js ?? []) cs.add(js.replace(/^\.?\//, ""));
  for (const name of cs) {
    const buf = bundle.get(name) ?? [...bundle].find(([n]) => n.endsWith(`/${name}`))?.[1];
    if (buf && /\bstorage\s*\.\s*(local|sync|session|managed)\b|\bstorage\b\s*\]/.test(buf.toString("utf8"))) f.push(`content script ${name} touches chrome.storage`);
  }
  return result(f, `no externally_connectable, no external listeners, ${cs.size} content script(s) never touch storage`);
}

// Settings that skip the hold (passThrough) may be read only by the service worker policy: no options UI field,
// no message handler, no other writer. Source files (Map<relPath, text>) under packages/extension/src, tests excluded.
export const PASS_THROUGH_READERS = new Set(["sw/settings.ts", "sw/policy.ts"]);
export function checkPassThroughUnwritable(srcFiles) {
  const f = [];
  for (const [name, text] of srcFiles) {
    if (!/passThrough/.test(text)) continue;
    if (!PASS_THROUGH_READERS.has(name)) f.push(`passThrough referenced in packages/extension/src/${name} (only ${[...PASS_THROUGH_READERS].join(", ")} may read it; a new reader or any writer needs verifier review)`);
    else if (/\.set\s*\([^)]*passThrough|passThrough\s*=(?!=)/.test(text)) f.push(`passThrough written in packages/extension/src/${name}`);
  }
  return result(f, `passThrough read only by ${[...PASS_THROUGH_READERS].join(", ")}; nothing writes it`);
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
