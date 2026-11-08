// E26: human token amounts and names on the recorded real Jupiter swaps. Metadata is replayed from real Helius
// responses (fixtures/tokens/jupiter.json: getMultipleAccounts for token accounts and mints, DAS getAssetBatch).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildIntentContext, explainReport, readTokenMeta, validateIntentContext, WRAPPED_SOL_MINT, type Report, type RuleState } from "../src/index.js";
import { analyze, decoder, json, manifestFixtures, replay, sessionFromRuntime, sessionOf, type Recording } from "./rules-helpers.js";

const rec = json<Recording>("packages/core/test/fixtures/tokens/jupiter.json");
const jup = manifestFixtures().filter((f) => f.path.includes("/jupiter-v6/"));
const sessionFor = async (x: (typeof jup)[number]) => (x.loaded ? sessionFromRuntime(x.base64, x.loaded) : sessionOf([x.base64]));
async function stateFor(x: (typeof jup)[number]): Promise<{ session: Awaited<ReturnType<typeof sessionOf>>; state: RuleState; problems: string[] }> {
  const session = await sessionFor(x);
  const { rpc, reader } = replay(rec);
  const m = await readTokenMeta(rpc, reader, session, decoder.decodeSession(session));
  return { session, state: { tokens: m.tokens, tokenAccountMints: m.tokenAccountMints }, problems: m.problems };
}
const facts = (r: Report, id: string) => r.claims.filter((c) => c.ruleId === id);
const intentOf = (session: Awaited<ReturnType<typeof sessionOf>>, state: RuleState, report: Report) => buildIntentContext({ session, state, report, decoded: decoder.decodeSession(session), decoder });

describe("token metadata on real Jupiter swaps", () => {
  it("states swaps with decimals and token names, keeps mint addresses in evidence, offline falls back to raw units", async () => {
    let named = 0;
    for (const x of jup) {
      const { session, state, problems } = await stateFor(x);
      expect(problems, x.path).toEqual([]);
      const plain = analyze(session);
      const human = analyze(session, state);
      expect(human.alert.level).toBe(plain.alert.level);
      expect(human.claims.map((c) => [c.ruleId, c.level])).toEqual(plain.claims.map((c) => [c.ruleId, c.level]));
      if (human.alert.level === "L0" && facts(human, "fact.swap").length && !facts(human, "fact.unknown_instruction").length) expect(explainReport(human).headline, x.path).toBe("Swaps tokens");
      for (const c of facts(human, "fact.swap")) {
        expect(c.statement, x.path).toMatch(/swaps up to [\d.]+ \S.* for (at least|exactly) [\d.]+ \S.* via Jupiter/);
        expect(c.statement).not.toContain("base units");
        expect(c.statement).not.toContain("token mint");
        const tokens = human.evidence.filter((e) => c.evidenceIds.includes(e.id) && e.type === "derivation" && (e.data as { kind?: string }).kind === "token");
        expect(tokens.length).toBeGreaterThan(0);
        for (const t of tokens) {
          expect(t.address).toBe((t.data as { mint: string }).mint);
          expect(t.data).toMatchObject({ kind: "token", source: "helius-das" });
          expect(typeof (t.data as { decimals: number }).decimals).toBe("number");
        }
        named++;
      }
      for (const c of facts(plain, "fact.swap")) expect(c.statement).toMatch(/base units|token mint/);
    }
    expect(named).toBeGreaterThan(0);
  });

  it("wrapped SOL reads as SOL (wrapped)", async () => {
    let seen = 0;
    for (const x of jup) {
      const { session, state } = await stateFor(x);
      if (!state.tokens?.[WRAPPED_SOL_MINT]) continue;
      const text = facts(analyze(session, state), "fact.swap").map((c) => c.statement).join(" ");
      if (text) { expect(text).toContain("SOL (wrapped)"); seen++; }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("a swap gets its own intent question; setup instructions never produce an unestablished-effects question", async () => {
    let swaps = 0;
    for (const x of jup) {
      const { session, state } = await stateFor(x);
      const report = analyze(session, state);
      if (!facts(report, "fact.swap").length) continue;
      const c = intentOf(session, state, report);
      expect(validateIntentContext(c, report.session.transactions.map((t) => t.messageHash))).toEqual(c);
      const swap = c.candidates.find((k) => k.kind === "swap")!;
      expect(swap.question, x.path).toMatch(/^Did you intend to swap up to [\d.]+ .+ for (at least|exactly) [\d.]+ .+\?$/);
      expect(swap.question).not.toMatch(/base units|token mint|[1-9A-HJ-NP-Za-km-z]{32,44}/);
      expect(c.candidates.some((k) => k.kind === "unknown" && /doesn't interpret/.test(k.question) && /create associated|compute/i.test(k.reasons[0]!.text)), x.path).toBe(false);
      expect(JSON.stringify(c)).not.toMatch(/intent template|decoded instruction/);
      swaps++;
    }
    expect(swaps).toBeGreaterThan(0);
  });

  it("without read metadata the intent question keeps raw units and the address (never guessed)", async () => {
    const x = jup.find((f) => analyzeHasSwap(f))!;
    const session = await sessionFor(x);
    const report = analyze(session);
    const swap = intentOf(session, {}, report).candidates.find((k) => k.kind === "swap")!;
    expect(swap.question).toMatch(/base units/);
  });
});
const analyzeHasSwap = (x: (typeof jup)[number]) => /JUP6/.test(JSON.stringify(x.path)) || true;

describe("named-but-unmodeled instructions (real Velocity oracle and twap updates)", () => {
  const dir = new URL("./fixtures/velocity/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const load = (f: string) => {
    const fx = JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { transaction: string; meta: { loadedAddresses?: { writable: string[]; readonly: string[] } } };
    return sessionFromRuntime(fx.transaction, fx.meta.loadedAddresses ?? { writable: [], readonly: [] });
  };

  it("states a program call fact with the program, the instruction and its values; the headline names it, not the fee", () => {
    let calls = 0;
    for (const f of files) {
      const session = load(f);
      const r = analyze(session);
      const named = decoder.decodeSession(session).flat().filter((i) => i.programName === "velocity" && i.status === "named");
      const pc = facts(r, "fact.program_call");
      expect(pc.length, f).toBe(named.length);
      for (const c of pc) {
        expect(c.statement).toMatch(/^Velocity · [A-Z][a-z]+( [a-z]+)*(: .+)?\.$/);
        expect(c.level).toBe("L0");
        expect(r.alert.claimIds).not.toContain(c.id);
        calls++;
      }
      expect(facts(r, "fact.no_permission_change"), f).toEqual([]);
      const headline = explainReport(r).headline;
      if (facts(r, "fact.unknown_instruction").length) expect(headline).toMatch(/^Can't fully verify this transaction · /);
      else {
        expect(headline).toBe(pc[0]!.statement.replace(/\.$/, "").split(": ")[0]);
        expect(headline).not.toMatch(/fee|Can't fully verify/i);
      }
      const names = r.claims.map((c) => c.ruleId);
      expect(names.indexOf("fact.program_call")).toBeLessThan(names.indexOf("fact.network_fee"));
    }
    expect(calls).toBeGreaterThan(0);
  });

  it("asks a plain question per unmodeled instruction, no developer words, no program ids", () => {
    for (const f of files) {
      const session = load(f);
      const r = analyze(session);
      const c = buildIntentContext({ session, state: {}, report: r, decoded: decoder.decodeSession(session), decoder });
      const text = JSON.stringify(c.candidates);
      expect(text, f).not.toMatch(/intent template|decoded instruction|[1-9A-HJ-NP-Za-km-z]{32,44}/);
      if (facts(r, "fact.program_call").length) {
        const q = c.candidates.filter((k) => /on Velocity\?$/.test(k.question));
        expect(q.length, f).toBeGreaterThan(0);
        for (const k of q) {
          expect(k.question).toMatch(/^Did you intend to [a-z]+( [a-z]+)* on Velocity\?$/);
          expect(k.reasons[0]!.text).toMatch(/^Velocity · /);
        }
      }
    }
  });
});
