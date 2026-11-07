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
  checkHosts, checkNoSecrets, checkNoRemoteCode, checkPermissions, checkLicenseKeyEmbedded,
  checkDependencyLicenses, licenseForbidden
} from "../src/security-checks.mjs";

const PK = "96kkANgM8egAtbFSa81PHfjNFajQNo77dpTcno2xmM1s";
const FAKE_KEY = "0f0e0d0c-1111-4222-8333-444455556666";
const bundle = (files) => new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
const goodManifest = {
  manifest_version: 3, name: "x", permissions: ["storage"],
  host_permissions: ["https://mainnet.helius-rpc.com/*", "https://devnet.helius-rpc.com/*", "http://localhost:8899/*"],
  content_scripts: [{ matches: ["<all_urls>"], js: ["hook.js"], world: "MAIN" }]
};
const clean = () => bundle({
  "manifest.json": JSON.stringify(goodManifest),
  "service-worker.js": `const u="https://mainnet.helius-rpc.com/?api-key="+k;fetch("http://localhost:8899");const PK="${PK}";`,
  "ui.js": `document.createElementNS("http://www.w3.org/2000/svg","svg");`
});

test("clean bundle passes every check", () => {
  const b = clean();
  assert.equal(checkHosts(b).status, "PASS");
  assert.equal(checkNoRemoteCode(b, goodManifest).status, "PASS");
  assert.equal(checkPermissions(goodManifest).status, "PASS");
  assert.equal(checkLicenseKeyEmbedded(b, PK).status, "PASS");
  assert.equal(checkNoSecrets(b, [FAKE_KEY]).status, "PASS");
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

test("remote code: eval, Function, string timers, remote imports and CSP fail", () => {
  for (const s of ["eval(x)", "new Function('return 1')", 'setTimeout("alert(1)",1)', 'importScripts("https://x.y/a.js")',
    'import("https://cdn.x/a.js")']) {
    assert.equal(checkNoRemoteCode(bundle({ "a.js": s }), goodManifest).status, "FAIL", s);
  }
  assert.equal(checkNoRemoteCode(bundle({ "p.html": '<script src="https://cdn.x/a.js"></script>' }), goodManifest).status, "FAIL");
  assert.equal(checkNoRemoteCode(bundle({}), { content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" } }).status, "FAIL");
  assert.equal(checkNoRemoteCode(bundle({ "a.js": "obj.evaluate(x); retrieval(y)" }), goodManifest).status, "PASS");
});

test("permissions: extra permissions and hosts fail", () => {
  assert.equal(checkPermissions({ ...goodManifest, permissions: ["storage", "tabs"] }).status, "FAIL");
  assert.equal(checkPermissions({ ...goodManifest, host_permissions: ["<all_urls>"] }).status, "FAIL");
  assert.equal(checkPermissions({ ...goodManifest, manifest_version: 2 }).status, "FAIL");
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
