// S7 fixture domains: poisoning contexts are not wire fixtures or benign first sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyPoisonFixtures } from "../../../packages/scenarios/scripts/lib/poison-verify.mjs";

const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const json = (p) => JSON.parse(readFileSync(path.join(fixtures, p), "utf8"));
const files = (dir) => readdirSync(path.join(fixtures, dir), { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? files(p) : e.name.endsWith(".json") && e.name !== "manifest.json" ? [p] : [];
});

test("G2 inventories tx only; poison positives and first-send negatives stay disjoint", () => {
  const tx = json("tx/manifest.json");
  const poison = json("poison/manifest.json");
  assert.equal(tx.count, tx.fixtures.length);
  assert.equal(poison.schema, "kelvara.fixture.poison-manifest/v1");
  assert.equal(poison.count, poison.cases.length);
  assert.deepEqual(files("tx").sort(), tx.fixtures.map((e) => e.path).sort());
  assert.deepEqual(files("poison").sort(), poison.cases.map((e) => e.path).sort());
  assert.deepEqual(verifyPoisonFixtures(), []);
  const positives = new Set();
  const negatives = new Set();
  const txByPath = new Map(tx.fixtures.map((e) => [e.path, e]));
  for (const entry of poison.cases) {
    const record = json(entry.path);
    for (const field of ["kind", "network", "user", "recipient", "expect"]) {
      assert.deepEqual(entry[field], record[field], `${entry.path}: manifest ${field}`);
    }
    if (record.kind === "poisoning") {
      assert.ok(entry.path.startsWith(`poison/${record.network}/`));
      assert.deepEqual(record.expect, { rule: "address.poisoning", level: "L4" });
      positives.add(record.dust.signature);
      if (record.request) positives.add(record.request.signature);
      assert.ok(record.realTransfer.slot <= record.dust.slot);
    } else {
      assert.equal(record.kind, "first-send");
      assert.ok(entry.path.startsWith("poison/first-send/"));
      assert.deepEqual(record.expect, {
        rule: "address.first_send", level: "L1", notL4: true,
        notRules: ["address.poisoning", "address.dust_sender"]
      });
      negatives.add(record.transfer.signature);
      const wire = json(record.request.txFixture);
      const indexed = txByPath.get(record.request.txFixture);
      assert.ok(indexed, `${entry.path}: missing from tx manifest`);
      assert.equal(wire.signature, record.transfer.signature);
      assert.equal(indexed.signature, record.transfer.signature);
      for (const tag of ["first-send", "benign"]) {
        assert.ok(wire.tags.includes(tag));
        assert.ok(indexed.tags.includes(tag));
      }
    }
    const anchors = record.kind === "poisoning"
      ? [record.realTransfer.signature, record.dust.signature, ...(record.request ? [record.request.signature] : [])]
      : [record.transfer.signature];
    for (const signature of anchors) {
      const call = record.calls.find((c) => c.method === "getTransaction" && c.params[0] === signature);
      assert.ok(call?.result, `${entry.path}: missing recorded anchor`);
      assert.equal(call.result.transaction.signatures[0], signature);
      assert.equal(call.result.meta.err, null, `${entry.path}: failed anchor is not positive evidence`);
    }
  }
  assert.ok(negatives.size >= 20);
  assert.ok(poison.cases.filter((e) => e.kind === "poisoning" && e.network === "mainnet").length >= 5);
  for (const signature of negatives) assert.ok(!positives.has(signature), `first-send classified as poison: ${signature}`);
});
