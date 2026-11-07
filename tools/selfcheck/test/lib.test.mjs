// Self-tests for redaction and .env parsing used by every gate log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { failNote, makeRedactor, parseEnv } from "../src/lib.mjs";

test("redacts api-key params, JSON fields and the literal key", () => {
  const key = "0f0e0d0c-1111-4222-8333-444455556666";
  const r = makeRedactor([key]);
  assert.equal(r("GET https://mainnet.helius-rpc.com/?api-key=abc123&x=1"), "GET https://mainnet.helius-rpc.com/?api-key=REDACTED&x=1");
  assert.equal(r('{"apiKey":"zzz"}'), '{"apiKey":"REDACTED"}');
  assert.equal(r(`key is ${key}.`), "key is REDACTED.");
  assert.equal(r("api_key=q"), "api_key=REDACTED");
});

test("parses .env with quotes, comments and expansion", () => {
  const e = parseEnv('# c\nHELIUS_API_KEY="k1"\nexport A=b # note\nURL=https://x/?api-key=${HELIUS_API_KEY}\n');
  assert.deepEqual(e, { HELIUS_API_KEY: "k1", A: "b", URL: "https://x/?api-key=k1" });
});

test("FAIL note takes the gate's own verdict over an earlier expected FAIL probe (V9 G6 engine mutant)", () => {
  const tail = [
    "> node scripts/test-localnet.mjs",
    "[localnet] FAIL demo program upgrade authority is our key",
    "[G6] localnet not ready (1 localnet check(s) failed); starting a fresh one",
    "G6  localnet     FAIL     21.4  missing claim nonce.staged_by_outsider",
    " ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @kelvara/scenarios@0.0.0 test:localnet: `node scripts/test-localnet.mjs`",
    " ELIFECYCLE  Command failed with exit code 1."
  ];
  assert.equal(failNote(tail, 1), "missing claim nonce.staged_by_outsider");
});

test("FAIL note: SELFCHECK-SUMMARY first, then first error line, then last line, then exit code", () => {
  assert.equal(failNote(["G6  localnet     FAIL     1.0  x", "SELFCHECK-SUMMARY: y"], 1), "y");
  assert.equal(failNote(["ok", "Error: boom", "later"], 1), "Error: boom");
  assert.equal(failNote(["one", "two", " ELIFECYCLE  Command failed"], 1), "two");
  assert.equal(failNote([], 2), "exit 2");
});

test("FAIL note strips ANSI colour codes (V9 G3 mutant note)", () => {
  assert.equal(failNote(["\x1b[31m❯\x1b[39m test/rules-address.test.ts \x1b[2m(\x1b[22m38 tests | \x1b[31m1 failed\x1b[39m)"], 1), "❯ test/rules-address.test.ts (38 tests | 1 failed)");
});
