import { expect, it } from "vitest";
import { analyze, byRule, DRIFT_1, DRIFT_2, driftTx, recording, sessionOf, stateFrom } from "./rules-helpers.js";

it("authority.transfer names Drift updateAdmin inside the real proposed vault message", async () => {
  const r = analyze(await sessionOf([driftTx(DRIFT_1), driftTx(DRIFT_2)]));
  const claims = byRule(r, "authority.transfer");
  expect(claims.some((c) => c.statement.includes("updateAdmin") && c.level === "L3")).toBe(true);
  expect(r.capabilities.granted.some((c) => c.class === "admin_control")).toBe(true);
  const transfer = recording("localnet.json").inputs.transfer.wireBase64;
  expect(byRule(analyze(await sessionOf([transfer])), "authority.transfer")).toEqual([]);
});

it("authority.transfer reads the loader SetAuthority inside the real stored localnet proposal", async () => {
  const local = recording("localnet.json");
  const state = await stateFrom(local, { squads: [local.inputs.multisig, local.inputs.proposal, local.inputs.vaultTransaction] });
  const r = analyze(await sessionOf([local.inputs.approval.wireBase64]), state);
  expect(byRule(r, "authority.transfer").some((c) => c.statement.includes("setAuthority") && c.level === "L3")).toBe(true);
  expect(r.capabilities.granted.some((c) => c.class === "code_control")).toBe(true);
});
