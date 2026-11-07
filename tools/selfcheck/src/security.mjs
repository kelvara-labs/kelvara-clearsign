#!/usr/bin/env node
// G10 security: nothing leaves the browser except Helius RPC and APIs.
// Inputs (PENDING until they exist); every one present is checked:
//   dist/kelvara-signguard.zip          the release zip: hosts, eval/remote code, permissions, content scripts offline,
//                                       license key embedded, and no HELIUS_API_KEY (value from .env, never printed)
//   packages/extension/dist/            the unpacked build: the same checks except the key (the dev build may prefill
//                                       it from .env; PLAN.md 1a), so "no API key in zip" stays PENDING until the zip exists
// Override for spot checks: --zip <file> and/or --dir <dir> (paths relative to the repo root or absolute).
// Always runs: dependency licenses of packages/core and packages/extension, read offline from node_modules.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT, finish, pass, fail, pending, secretValues } from "./lib.mjs";
import { readZip } from "./zip.mjs";
import {
  checkHosts, checkNoSecrets, checkContentScriptsOffline, checkNoRemoteCode, checkPermissions, checkLicenseKeyEmbedded, checkDependencyLicenses
} from "./security-checks.mjs";

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? path.resolve(ROOT, process.argv[i + 1] ?? "") : null; };
const ZIP = arg("--zip") ?? path.join(ROOT, "dist/kelvara-signguard.zip");
const UNPACKED = arg("--dir") ?? path.join(ROOT, "packages/extension/dist");

function readDir(dir) {
  const files = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.set(path.relative(dir, p).split(path.sep).join("/"), readFileSync(p));
    }
  };
  walk(dir);
  return files;
}
const findManifest = (bundle) => {
  const name = [...bundle.keys()].filter((n) => n.endsWith("manifest.json")).sort((a, b) => a.length - b.length)[0];
  if (!name) return null;
  try { return JSON.parse(bundle.get(name).toString("utf8")); } catch { return { manifest_version: "unparseable" }; }
};
const asCheck = (name, r, summary) => (r.status === "PASS" ? pass(name, r.detail, summary) : fail(name, r.detail));

const checks = [];
const pk = existsSync(path.join(ROOT, "config/license-public-key.txt"))
  ? readFileSync(path.join(ROOT, "config/license-public-key.txt"), "utf8").trim() : null;

// PENDING vs FAIL: a check for a feature that is not built yet reports PENDING with the reason; anything already
// checkable (foreign hosts, eval, permissions, network in content scripts, a Helius key anywhere) FAILs at once.
// The offline license check (X4) counts as built once packages/extension/src has a file whose path names "license".
const EXT_SRC = path.join(ROOT, "packages/extension/src");
const licenseFeatureBuilt = (() => {
  if (!existsSync(EXT_SRC)) return false;
  const walk = (d) => readdirSync(d).some((name) => {
    const p = path.join(d, name);
    return statSync(p).isDirectory() ? walk(p) : /licen[cs]e/i.test(path.relative(EXT_SRC, p));
  });
  return walk(EXT_SRC);
})();
const secrets = secretValues();

function bundleChecks(bundle, label) {
  const manifest = findManifest(bundle);
  const n = (c) => `${c} [${label}]`;
  checks.push(asCheck(n("hosts"), checkHosts(bundle), "hosts ok"));
  checks.push(asCheck(n("no eval/remote code"), checkNoRemoteCode(bundle, manifest), "no eval"));
  checks.push(asCheck(n("permissions"), checkPermissions(manifest), "min perms"));
  checks.push(asCheck(n("content scripts offline"), checkContentScriptsOffline(bundle, manifest), "cs offline"));
  const lic = checkLicenseKeyEmbedded(bundle, pk);
  if (lic.status === "FAIL" && pk && !licenseFeatureBuilt) {
    checks.push(pending(n("license key offline"), "offline license check (X4, M5) not built: no license source in packages/extension/src"));
  } else checks.push(asCheck(n("license key offline"), lic, "license offline"));
}

let sawBundle = false;
if (existsSync(ZIP)) {
  sawBundle = true;
  const raw = readFileSync(ZIP);
  let bundle = null;
  try { bundle = readZip(raw); } catch (e) { checks.push(fail("release zip", `unreadable: ${e.message}`)); }
  if (bundle) {
    bundleChecks(bundle, "zip");
    checks.push(asCheck("no API key in zip", checkNoSecrets(bundle, secrets, raw), "no key in zip"));
    if (!secrets.length) checks.push(pending("key value check", "HELIUS_API_KEY not found in the main checkout's .env; only patterns were checked"));
  }
} else {
  checks.push(pending("no API key in zip", `${path.relative(ROOT, ZIP)} not built yet (release packaging is M8)`));
}
if (existsSync(path.join(UNPACKED, "manifest.json"))) {
  sawBundle = true;
  const unpacked = readDir(UNPACKED);
  bundleChecks(unpacked, "unpacked");
  // Coordinator ruling (V3): a Helius key anywhere in dist FAILs, the unpacked build included. G1 builds without
  // --dev, so a key here means the release path bakes it in.
  checks.push(asCheck("no API key in unpacked dist", checkNoSecrets(unpacked, secrets), "no key in dist"));
}
// Anything else under dist/ (release staging, stray copies) must not carry the key either.
const DIST = path.join(ROOT, "dist");
if (existsSync(DIST) && !process.argv.includes("--zip")) {
  const other = new Map([...readDir(DIST)].filter(([n]) => !n.endsWith(".zip")));
  if (other.size) checks.push(asCheck("no API key in dist/", checkNoSecrets(other, secrets), "no key in dist/"));
}
if (!sawBundle) checks.push(pending("extension bundle", "neither the release zip nor packages/extension/dist/manifest.json exists"));

const waiversPath = path.join(ROOT, "tools/selfcheck/license-waivers.json");
const waivers = existsSync(waiversPath) ? JSON.parse(readFileSync(waiversPath, "utf8")) : {};
const licensesMd = existsSync(path.join(ROOT, "LICENSES.md")) ? readFileSync(path.join(ROOT, "LICENSES.md"), "utf8") : "";
checks.push(asCheck("dependency licenses", checkDependencyLicenses(ROOT, ["packages/core", "packages/extension"], licensesMd, waivers), "licenses ok"));

finish("G10", checks);
