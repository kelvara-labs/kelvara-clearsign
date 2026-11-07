// Monotonicity: adding an unrelated transaction to a session never lowers its alert level or drops a claim.
// Regression (coordinator, after E16): the Drift replay pair is L3 (authority.transfer updateAdmin -> H7Pi…),
// but with Drift's later initializeSpotMarket tx 4a5962Rd… (signed by H7Pi…, L0 alone) between them it fell
// to L2: the rules treated a signer of ANY session transaction as an insider, so the new admin "signed"
// its own grant. Insiders are now the signers of the transactions that carry or land the grant.
// Property: every attack session of the G3 corpus (level >= L2), with each benign real fixture (L0 alone)
// appended, keeps its alert level and every ruleId at its level or higher. Unrelated = the benign tx takes
// no account writable that the attack session uses (e.g. the executed S9 sweep is not unrelated to its request).
import { beforeAll, describe, expect, it } from "vitest";
import { accountFromRpc, type Report, type RuleState, type Session } from "../src/index.js";
import { poisonManifest, requestCase } from "./address-helpers.js";
import { analyze, analyzedState, DRIFT_1, DRIFT_2, driftTx, json, manifestFixtures, recording, sessionOf, stateFrom } from "./rules-helpers.js";
import { s9SweepCase } from "./sweep-helpers.js";

const BENIGN_DRIFT = "4a5962Rdqd9pkXtk9DMQ9ZYhdGb2k9gPw71GvukJgELhxbCY5gm1c1hhKdwuGefyqJ3XMvihUTDNDn3qbXnst82X";
const LEVEL = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 } as const;

/** session + more transactions, appended after it (indices of the original transactions and its state stay valid). */
function append(session: Session, more: Session): Session {
  const n = session.transactions.length;
  return {
    ...session,
    id: `${session.id}+${more.id}`,
    transactions: [...session.transactions, ...more.transactions.map((t, i) => ({ ...t, index: n + i }))],
    lookupTables: { ...session.lookupTables, ...more.lookupTables },
    complete: session.complete && more.complete
  };
}
const ruleLevels = (r: Report) => {
  const m = new Map<string, number>();
  for (const c of r.claims) if (c.ruleId) m.set(c.ruleId, Math.max(m.get(c.ruleId) ?? 0, LEVEL[c.level]));
  return m;
};

describe("monotonicity", () => {
  it("Drift pair with an unrelated Drift tx between them stays L3 with authority.transfer", async () => {
    for (const order of [[DRIFT_1, BENIGN_DRIFT, DRIFT_2], [BENIGN_DRIFT, DRIFT_1, DRIFT_2], [DRIFT_1, DRIFT_2, BENIGN_DRIFT]]) {
      const r = analyze(await sessionOf(order.map(driftTx)));
      expect(r.alert.level, order.join(" ")).toBe("L3");
      const t = r.claims.filter((c) => c.ruleId === "authority.transfer");
      expect(t.map((c) => c.level)).toEqual(["L3"]);
      expect(r.claims.filter((c) => c.ruleId === "lifetime.durable_nonce" && c.level === "L3")).toHaveLength(2);
      expect(r.claims.find((c) => c.ruleId === "squads.approve_and_execute")?.level).toBe("L3");
    }
    expect(analyze(await sessionOf([driftTx(BENIGN_DRIFT)])).alert.level).toBe("L0");
  });

  const attacks: { name: string; session: Session; state: RuleState }[] = [];
  const benign: { name: string; session: Session }[] = [];
  beforeAll(async () => {
    const MAIN = recording("mainnet.json");
    const LOCAL = recording("localnet.json");
    attacks.push({ name: "drift pair", session: await sessionOf([driftTx(DRIFT_1), driftTx(DRIFT_2)]), state: {} });
    attacks.push({ name: "drift pair + Helius state", session: await sessionOf([driftTx(DRIFT_1), driftTx(DRIFT_2)]), state: await stateFrom(MAIN, { nonces: [MAIN.inputs.nonce], squads: [MAIN.inputs.multisig] }) });
    attacks.push({ name: "admin-local approval + localnet state", session: await sessionOf([LOCAL.inputs.approval.wireBase64]), state: await stateFrom(LOCAL, { nonces: [LOCAL.inputs.nonce], squads: [LOCAL.inputs.multisig, LOCAL.inputs.proposal, LOCAL.inputs.vaultTransaction] }) });
    for (const name of ["admin-local", "trap-local", "sweep-local", "sweep-ata-local"] as const) {
      const a = await analyzedState(name);
      attacks.push({ name: `${name} analyzed`, session: await sessionOf(a.rec.inputs.transactions), state: a.state });
    }
    const s9 = await s9SweepCase();
    attacks.push({ name: "S9 sweep", session: s9.session, state: s9.state });
    const devnet = poisonManifest.cases.find((c) => c.kind === "poisoning" && c.network === "devnet")!;
    attacks.push({ name: "poison devnet send", ...(await requestCase(devnet, { maxTransactions: 10 })) });
    for (const f of json("packages/core/test/fixtures/rules/e8-localnet.json").cases) {
      attacks.push({ name: `e8 ${f.name}`, session: await sessionOf([f.transaction]), state: { wallet: f.wallet, accounts: Object.fromEntries(Object.entries(f.accounts).map(([a, r]) => [a, accountFromRpc(a, r as Parameters<typeof accountFromRpc>[1])])), fees: { 0: BigInt(f.fee) }, walletInventory: f.inventory ? { complete: true, tokenAccounts: f.inventory.map((a: { pubkey: string }) => a.pubkey) } : undefined } });
    }
    // Benign: real fixtures without lookup tables that are L0 on their own, every 4th, plus the Drift one above.
    const all = manifestFixtures().filter((f) => !f.loaded || f.loaded.writable.length + f.loaded.readonly.length === 0);
    for (const [i, f] of all.entries()) {
      if (i % 4 && !f.path.includes(BENIGN_DRIFT)) continue;
      const session = await sessionOf([f.base64]);
      if (analyze(session).alert.level === "L0") benign.push({ name: f.path, session });
    }
  }, 30_000);

  it("appending a benign real transaction never lowers an attack session's level or a rule's level", () => {
    const strong = attacks.map((a) => ({ ...a, report: analyze(a.session, a.state) })).filter((a) => LEVEL[a.report.alert.level] >= 2);
    expect(strong.length).toBeGreaterThanOrEqual(10);
    expect(benign.length).toBeGreaterThanOrEqual(15);
    const problems: string[] = [];
    let pairs = 0, related = 0;
    for (const a of strong) {
      const before = ruleLevels(a.report);
      const used = new Set([...a.session.transactions.flatMap((t) => t.accounts.map((x) => x.address)), a.state.wallet].filter(Boolean));
      for (const b of benign) {
        if (b.session.transactions.some((t) => t.accounts.some((x) => x.writable && used.has(x.address)))) {
          related++;
          continue;
        }
        pairs++;
        const r = analyze(append(a.session, b.session), a.state);
        if (LEVEL[r.alert.level] < LEVEL[a.report.alert.level]) problems.push(`${a.name} + ${b.name}: ${a.report.alert.level} -> ${r.alert.level}`);
        const after = ruleLevels(r);
        for (const [id, lvl] of before) if ((after.get(id) ?? -1) < lvl) problems.push(`${a.name} + ${b.name}: ${id} L${lvl} -> ${after.has(id) ? `L${after.get(id)}` : "gone"}`);
      }
    }
    console.log(`monotonicity: ${strong.length} attack sessions x ${benign.length} benign txs: ${pairs} unrelated pairs checked, ${related} related pairs skipped`);
    expect(pairs).toBeGreaterThan(200);
    expect([...new Set(problems)].slice(0, 30)).toEqual([]);
  }, 60_000);
});
