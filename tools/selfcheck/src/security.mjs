#!/usr/bin/env node
// G10 security: nothing leaves the browser except Helius RPC and APIs.
// Inputs (PENDING until they exist):
//   dist/kelvara-signguard.zip          the release zip (what ships; checked for keys, hosts, eval, permissions)
//   packages/extension/dist/            the unpacked build with manifest.json (checked when the zip is absent)
// Always runs: dependency licenses of packages/core and packages/extension, read offline from node_modules.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT, finish, pass, fail, pending, secretValues } from "./lib.mjs";
import { readZip } from "./zip.mjs";
import {
  checkHosts, checkNoSecrets, checkNoRemoteCode, checkPermissions, checkLicenseKeyEmbedded, checkDependencyLicenses
} from "./security-checks.mjs";

const ZIP = path.join(ROOT, "dist/kelvara-signguard.zip");
const UNPACKED = path.join(ROOT, "packages/extension/dist");

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
let bundle = null, source = null;
if (existsSync(ZIP)) {
  try { bundle = readZip(readFileSync(ZIP)); source = "zip"; }
  catch (e) { checks.push(fail("release zip", `unreadable: ${e.message}`)); }
} else if (existsSync(path.join(UNPACKED, "manifest.json"))) {
  bundle = readDir(UNPACKED); source = "unpacked";
}

if (bundle) {
  const manifest = findManifest(bundle);
  checks.push(asCheck("hosts", checkHosts(bundle), "hosts ok"));
  checks.push(asCheck("no eval/remote code", checkNoRemoteCode(bundle, manifest), "no eval"));
  checks.push(asCheck("permissions", checkPermissions(manifest), "min perms"));
  const pk = existsSync(path.join(ROOT, "config/license-public-key.txt"))
    ? readFileSync(path.join(ROOT, "config/license-public-key.txt"), "utf8").trim() : null;
  checks.push(asCheck("license key offline", checkLicenseKeyEmbedded(bundle, pk), "license offline"));
  if (source === "zip") checks.push(asCheck("no API key in zip", checkNoSecrets(bundle, secretValues()), "no key in zip"));
  else checks.push(pending("no API key in zip", "dist/kelvara-signguard.zip not built (unpacked build checked)"));
} else if (!checks.length) {
  checks.push(pending("extension bundle", "neither dist/kelvara-signguard.zip nor packages/extension/dist/manifest.json exists"));
}

const waiversPath = path.join(ROOT, "tools/selfcheck/license-waivers.json");
const waivers = existsSync(waiversPath) ? JSON.parse(readFileSync(waiversPath, "utf8")) : {};
const licensesMd = existsSync(path.join(ROOT, "LICENSES.md")) ? readFileSync(path.join(ROOT, "LICENSES.md"), "utf8") : "";
checks.push(asCheck("dependency licenses", checkDependencyLicenses(ROOT, ["packages/core", "packages/extension"], licensesMd, waivers), "licenses ok"));

finish("G10", checks);
