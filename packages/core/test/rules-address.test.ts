// E9 / G3: address.poisoning (L4), address.dust_sender (L3), address.first_send (L1) on real data:
// S7's mainnet poisoning cases (dust from a lookalike right after a real transfer), the executed devnet
// poisoning scenario, and 23 real first-time transfers (none may reach L4).
import { describe, expect, it } from "vitest";
import { assessRecipient, dustReason, lookalike, markMatch, type Report } from "../src/index.js";
import { analyze, byRule } from "./rules-helpers.js";
import { fixtureOf, historyOf, poisonManifest, requestCase } from "./address-helpers.js";

const poisoning = poisonManifest.cases.filter((c) => c.kind === "poisoning");
const firstSends = poisonManifest.cases.filter((c) => c.kind === "first-send");
const devnet = poisoning.find((c) => c.network === "devnet")!;
const dustSig = (id: string): string => fixtureOf(poisoning.find((c) => c.id === id)!).dust.signature;

describe("lookalike (>= 5 shared start+end characters, >= 2 on each side)", () => {
  it("matches every real poisoning pair exactly as S7 measured it", () => {
    for (const c of poisoning) expect(lookalike(c.recipient, c.lookalikeOf!), c.id).toEqual(c.match);
  });
  it("needs both sides and five in total", () => {
    const a = devnet.lookalikeOf!; // A8yHT9…dWmu
    const swap = (s: string, i: number) => s.slice(0, i) + (s[i] === "x" ? "y" : "x") + s.slice(i + 1);
    expect(lookalike(a, a)).toBeNull();
    expect(lookalike(a, swap(a, 1))).toBeNull(); // prefix 1
    expect(lookalike(a, swap(a, a.length - 2))).toBeNull(); // suffix 1
    expect(lookalike(a, swap(swap(a, 2), a.length - 3))).toBeNull(); // 2 + 2 = 4
    expect(lookalike(a, swap(swap(a, 3), a.length - 3))).toEqual({ prefix: 3, suffix: 2 });
    expect(markMatch(devnet.recipient, { prefix: 3, suffix: 2 })).toBe("[A8y]Fk8de2QXndMebgExKhxdct6EdyAADjka1WSchGa[mu]");
  });
});

describe("history on real Helius responses", () => {
  it.each(poisoning.map((c) => [c.id, c] as const))("%s: dust from a lookalike of a real payee -> poisoning, proven", async (_id, c) => {
    const h = await historyOf(c);
    const a = assessRecipient(h, c.recipient);
    expect(a.outcome).toBe("poisoning");
    expect(a.proven).toBe(true);
    expect(a.lookalike!.of.to).toBe(c.lookalikeOf);
    expect(a.lookalike!.match).toEqual(c.match);
    expect(a.dust.map((d) => d.transfer.signature)).toContain(dustSig(c.id));
    for (const d of a.dust) expect(dustReason(d.transfer, h)).toBe(d.reason);
  });

  it("without the real payment in the transactions read, the same dust is only a dust sender", async () => {
    for (const c of poisoning) {
      const a = assessRecipient(await historyOf(c, { maxTransactions: 0 }), c.recipient);
      expect(a.outcome, c.id).toBe("dust_sender");
      expect(a.proven, c.id).toBe(true);
    }
  });

  it("an unread shared transaction makes 'never sent' unproven", async () => {
    const busy = poisoning.find((c) => c.id === "mainnet-poisoning-38fajNMm")!;
    const h = await historyOf(busy, { maxSharedTransactions: 10 });
    const a = assessRecipient(h, busy.recipient);
    expect(h.counterparties[busy.recipient]!.complete).toBe(false);
    expect(a.proven).toBe(false);
  });

  it.each(firstSends.map((c) => [c.id, c] as const))("%s: recipient had no earlier transaction -> first send", async (_id, c) => {
    const a = assessRecipient(await historyOf(c), c.recipient);
    expect(a.outcome).toBe("first_send");
    expect(a.proven).toBe(true);
    expect(a.dust).toEqual([]);
  });
});

describe("rule on executed requests", () => {
  it("devnet scenario: the executed 0.5 SOL send to the ground lookalike is L4 with both addresses marked", async () => {
    const { session, state } = await requestCase(devnet);
    const r = analyze(session, state);
    expect(r.alert.level).toBe("L4");
    const [claim] = byRule(r, "address.poisoning");
    expect(claim).toMatchObject({ kind: "Fact", level: "L4" });
    expect(claim!.statement).toContain("[A8y]Fk8de2QXndMebgExKhxdct6EdyAADjka1WSchGa[mu]");
    expect(claim!.statement).toContain("[A8y]HT9RFGdV2Wv2FUFpy8T6b2mb3PzaysvEZ34s2dW[mu]");
    const ev = (id: string) => r.evidence.find((e) => e.id === id)!;
    const evidence = claim!.evidenceIds.map(ev);
    expect(evidence.some((e) => e.type === "history" && (e.data as { signature: string }).signature === fixtureOf(devnet).dust.signature)).toBe(true);
    expect(evidence.some((e) => e.type === "history" && (e.data as { signature: string }).signature === fixtureOf(devnet).realTransfer.signature)).toBe(true);
    expect(evidence.find((e) => e.type === "derivation")!.data).toMatchObject({ recipient: devnet.recipient, lookalikeOf: devnet.lookalikeOf, prefix: 3, suffix: 2 });
    expect(byRule(r, "address.dust_sender")).toEqual([]);
    expect(byRule(r, "address.first_send")).toEqual([]);
  });

  it("devnet scenario without the real payment read: dust sender at L3, never L4", async () => {
    const { session, state } = await requestCase(devnet, { maxTransactions: 0 });
    const r = analyze(session, state);
    expect(r.alert.level).toBe("L3");
    expect(byRule(r, "address.dust_sender")).toHaveLength(1);
    expect(byRule(r, "address.poisoning")).toEqual([]);
  });

  it("no history read: the rule says nothing (missing state is never 'safe' or 'scam')", async () => {
    const { session, state } = await requestCase(devnet);
    const r = analyze(session, { ...state, history: undefined });
    expect(r.claims.filter((c) => c.ruleId?.startsWith("address."))).toEqual([]);
  });

  it("23 real first-time transfers: none reaches L4; first-send notice on each resolved recipient", async () => {
    const reports: [string, Report][] = [];
    for (const c of firstSends) {
      const { session, state } = await requestCase(c);
      reports.push([c.id, analyze(session, state)]);
    }
    let notices = 0;
    for (const [id, r] of reports) {
      expect(r.alert.level, id).not.toBe("L4");
      expect(byRule(r, "address.poisoning"), id).toEqual([]);
      expect(byRule(r, "address.dust_sender"), id).toEqual([]);
      for (const c of byRule(r, "address.first_send")) {
        expect(c).toMatchObject({ kind: "Fact", level: "L1" });
        notices++;
      }
    }
    expect(firstSends.length).toBeGreaterThanOrEqual(20);
    expect(notices).toBe(firstSends.length);
  }, 20_000);
});
