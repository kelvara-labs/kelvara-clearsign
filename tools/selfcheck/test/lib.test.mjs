// Self-tests for redaction and .env parsing used by every gate log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRedactor, parseEnv } from "../src/lib.mjs";

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
