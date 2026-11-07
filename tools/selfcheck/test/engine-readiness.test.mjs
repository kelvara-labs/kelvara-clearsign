import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasRealEngine } from "../src/engine-readiness.mjs";

// Source-only doubles; no transaction, address or RPC data is synthesized.
test("workspace dependency plus stub is pending; wired, mixed and unknown paths run G7", () => {
  const root = mkdtempSync(path.join(tmpdir(), "g7-readiness-"));
  const src = path.join(root, "packages/extension/src");
  const worker = `import { stubEngine } from "./sw/engine-stub.js";
import { decide } from "./sw/policy.js";
async function handleAnalyze(req, loaded) {
  return decide(req, loaded.settings, stubEngine);
}`;
  const stub = `export const stubEngine = {
  async analyze(req) { return { level: 2, claims: [], title: "Not analyzed" }; }
};`;
  try {
    mkdirSync(path.join(src, "sw"), { recursive: true });
    writeFileSync(path.join(root, "packages/extension/package.json"), JSON.stringify({ dependencies: { "@kelvara/core": "workspace:*" } }));
    writeFileSync(path.join(src, "service-worker.ts"), worker);
    writeFileSync(path.join(src, "sw/engine-stub.ts"), stub);
    assert.equal(hasRealEngine(root), false, "current stub must remain pending despite the core dependency");
    const setWorker = (source) => writeFileSync(path.join(src, "service-worker.ts"), source);
    setWorker(worker.replace("{ stubEngine }", "{ stubEngine as placeholder }").replace("loaded.settings, stubEngine)", "loaded.settings, placeholder)"));
    assert.equal(hasRealEngine(root), false, "aliased stub import is still proven stub wiring");
    setWorker(worker.replace("loaded.settings, stubEngine)", "loaded.settings, realEngine)"));
    assert.equal(hasRealEngine(root), true, "unused stub import must not hide wired engine failures");
    setWorker(worker.replace("loaded.settings, stubEngine)", "loaded.settings, enabled ? realEngine : stubEngine)"));
    assert.equal(hasRealEngine(root), true, "mixed wiring must run engine assertions");
    setWorker(`${worker}\nconst analyzeAnother = decide;\n`);
    assert.equal(hasRealEngine(root), true, "indirect decision path must not be skipped");
    setWorker(worker.replace("loaded.settings, stubEngine)", "loaded.settings, realEngine) /* decide(req, loaded.settings, stubEngine) */"));
    assert.equal(hasRealEngine(root), true, "comments cannot prove stub wiring");
    setWorker(worker.replace('import { stubEngine } from "./sw/engine-stub.js";', 'import { realEngine } from "./sw/engine.js";').replace("loaded.settings, stubEngine)", "loaded.settings, realEngine)"));
    assert.equal(hasRealEngine(root), true, "fully replaced adapter must run engine assertions");
    setWorker(worker.replace("return decide(req, loaded.settings, stubEngine);", "return realEngine.analyze(req);"));
    assert.equal(hasRealEngine(root), true, "a new path bypassing decide must run engine assertions");
    setWorker(`${worker}\nfunction broken( {`);
    assert.throws(() => hasRealEngine(root), /cannot inspect engine wiring/, "invalid source must fail rather than defer assertions");
    setWorker(worker);
    writeFileSync(path.join(src, "sw/engine-stub.ts"), `${stub}\ninitializeRealEngine();`);
    assert.equal(hasRealEngine(root), true, "adapter setup beyond the literal stub is unknown wiring");
    writeFileSync(path.join(src, "sw/engine-stub.ts"), stub.replace("level: 2,", "level: analyzeSession(req),"));
    assert.equal(hasRealEngine(root), true, "integration inside a stub-named adapter must run G7");
    writeFileSync(path.join(src, "sw/engine-stub.ts"), stub.replace("level: 2,", "...await realEngine.analyze(req), level: 2,"));
    assert.equal(hasRealEngine(root), true, "spread integration cannot masquerade as the L2 placeholder");
    rmSync(path.join(src, "service-worker.ts"));
    assert.throws(() => hasRealEngine(root), /ENOENT/, "unreadable source must fail, not mark pending");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
