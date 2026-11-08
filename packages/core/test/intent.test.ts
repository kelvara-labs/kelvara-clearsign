// Real recorded RPC/state positive cases; explicit synthetic mutations exercise trust boundaries.
import { describe, expect, it } from "vitest";
import { analyzeSession, buildIntentContext, validateIntentContext, ReportBuilder, runRules, toJsonValue, TOKEN_2022_PROGRAM, MEMO_PROGRAM, type IntentContext, type RuleState, type DecodedInstruction, type ResolvedInstruction, type SquadsMessage } from "../src/index.js";
import type { Address } from "@solana/kit";
import { decoder, json, replay, sessionOf, squadsAccounts, type Recording } from "./rules-helpers.js";
import { addIntentSourceEvidence } from "../src/analyze/intent.js";
import { requestCase, poisonManifest } from "./address-helpers.js";

const devnet = poisonManifest.cases.find((c) => c.kind === "poisoning" && c.network === "devnet")!;
async function recorded(name: string) {
  const r = json<Recording>(`packages/core/test/fixtures/analyze/${name}.json`);
  const session = await sessionOf(r.inputs.transactions);
  const result = await analyzeSession(session, { decoder, squadsAccounts, rpc: replay(r).rpc, wallet: r.inputs.wallet, simulate: r.inputs.simulate });
  return { ...result, session };
}
function context(session: Awaited<ReturnType<typeof sessionOf>>, state: RuleState, decoded = decoder.decodeSession(session)) {
  const report = new ReportBuilder(session).build();
  return buildIntentContext({session, state, decoded, report, decoder});
}

describe("evidence-bound intent", () => {
  it("binds recorded governance authority, stays deterministic and leaves report digest untouched", async () => {
    const {session, state, report, intentContext: c} = await recorded("admin-local");
    expect(c.candidates[0]?.kind).toBe("authority");
    expect(c.candidates[0]?.question).toContain("proposed future");
    expect(c.candidates[0]?.question).toContain("program.upgrade");
    expect(c.complex).toBe(true);
    const digest = report.digest;
    for (let i = 0; i < 3; i++) expect(buildIntentContext({session, state, report, decoded: decoder.decodeSession(session), decoder})).toEqual(c);
    expect(report.digest).toBe(digest);
    expect(validateIntentContext(c, report.session.transactions.map((t) => t.messageHash))).toEqual(c);
    for (const candidate of c.candidates) for (const reason of candidate.reasons) {
      expect(reason.claimIds.every((id) => report.claims.some((claim) => claim.id === id))).toBe(true);
      expect(reason.evidenceIds.every((id) => report.evidence.some((e) => e.id === id))).toBe(true);
    }
    expect(c.candidates.some((candidate) => candidate.kind === "fees")).toBe(false);
  });

  it("uses real trap state to lead with token controls above purchase amounts", async () => {
    const {intentContext: c} = await recorded("trap-local");
    expect(c.candidates[0]?.kind).toBe("token-risk");
    expect(c.candidates.some((x) => x.reasons.some((r) => /permanent delegate/i.test(r.text)))).toBe(true);
    expect(c.complex).toBe(true);
  });

  it("retains full real poisoning comparison addresses and exact 0.5 SOL", async () => {
    const {session, state} = await requestCase(devnet);
    const {report, intentContext: c} = await analyzeSession(session, {decoder, state});
    expect(report.alert.level).toBe("L4");
    expect(c.candidates[0]?.comparison).toEqual({proposed: devnet.recipient, previous: devnet.lookalikeOf, ...devnet.match});
    expect(c.candidates.find((x) => x.kind === "transfer")?.question).toContain(`0.5 SOL to ${devnet.recipient}`);
    expect(c.candidates.find((x) => x.kind === "transfer")?.reasons[0]?.text).toContain("0 successful outgoing");
  });

  it("counts successful exact outgoing transactions, deduplicates signatures, includes tiny outgoing payments, excludes failed/incoming/lookalikes and states partial window", async () => {
    const {session, state} = await requestCase(devnet);
    const h = structuredClone(state.history!);
    const real = h.outgoing.find((t) => t.to === devnet.lookalikeOf)!;
    expect(real).toBeDefined(); // positive payment is recorded RPC provenance
    const decoded = decoder.decodeSession(session);
    const transfer = decoded.flat().find((ix) => ix.name === "transferSol")!;
    transfer.accounts.find((a) => a.name === "destination")!.address = real.to as Address;
    const initial = context(session, {...state, history: h}, decoded);
    const count = initial.candidates.find((x) => x.kind === "transfer")!.reasons[0]!.text.match(/(\d+) successful outgoing/)![1];
    expect(Number(count)).toBeGreaterThan(0);
    // Synthetic mutations of real records, never represented as new RPC fixtures.
    h.outgoing.push(structuredClone(real), {...real, signature: "dust-unit", amount: 1n}, {...real, signature: "failed-unit"}, {...real, signature: "incoming-unit", from: real.to, to: h.wallet, amount: 1n}, {...real, signature: "lookalike-unit", to: devnet.recipient});
    for (const sig of ["dust-unit", "failed-unit", "incoming-unit", "lookalike-unit"]) {
      h.signatures.push({...h.signatures[0]!, signature: sig, err: sig === "failed-unit" ? {InstructionError: [0, "unit"]} : null});
      h.read.push(sig);
    }
    h.reach = "cap";
    h.counterparties[devnet.recipient]!.complete = false;
    const c = context(session, {...state, history: h}, decoded);
    expect(c.historyNote).toContain("partial");
    expect(c.candidates.find((x) => x.kind === "transfer")!.reasons[0]!.text).toContain(`${Number(count) + 1} successful outgoing`);
    expect(c.historyNote).toContain("does not establish safety");
  });

  it("counts only dated transfers inside the inclusive window and marks missing timestamps uncertain", async () => {
    const {session, state} = await requestCase(devnet);
    const h = structuredClone(state.history!);
    const real = h.outgoing.find((t) => t.to === devnet.lookalikeOf)!;
    const decoded = decoder.decodeSession(session);
    decoded.flat().find((ix) => ix.name === "transferSol")!.accounts.find((a) => a.name === "destination")!.address = real.to as Address;
    const get = () => context(session, {...state, history: h}, decoded);
    const count = (c: IntentContext) => Number(c.candidates.find((x) => x.kind === "transfer")!.reasons[0]!.text.match(/(\d+) successful outgoing/)![1]);
    const baseline = count(get());
    // Explicit synthetic mutations of a real payment; no invented RPC provenance.
    const times = [h.since - 1, h.now + 1, h.since, h.now, null, Number.NaN];
    times.forEach((blockTime, i) => {
      const signature = `timestamp-unit-${i}`;
      h.outgoing.push({...real, signature, blockTime, amount: 1n});
      h.signatures.push({...h.signatures[0]!, signature, blockTime, err: null});
      h.read.push(signature);
    });
    const c = get();
    expect(count(c)).toBe(baseline + 2); // only exact since/now boundaries qualify
    expect(c.historyNote).toContain("partial");
    expect(c.historyNote).toContain("undated activity remains unknown");
    expect(c.historyNote).toContain("Undated transfers are excluded");
    expect(c.candidates.find((x) => x.kind === "transfer")!.reasons[0]!.text).toContain("(partial)");
    expect(validateIntentContext(c, c.messageHashes)).toEqual(c);
  });

  it("keeps all u64 transfer precision and routine transfers offline from AI", async () => {
    const {session, state} = await requestCase(devnet);
    const decoded = decoder.decodeSession(session);
    const ix = decoded.flat().find((ix) => ix.name === "transferSol")!;
    ix.args = {...ix.args, amount: 18446744073709551615n}; // synthetic boundary mutation
    const c = context(session, {wallet: state.wallet}, [[ix]]);
    expect(c.complex).toBe(false);
    expect(c.candidates[0]!.question).toContain("18446744073.709551615 SOL");
    expect(c.historyNote).toContain("unknown");
  });

  it("recognizes actual pinned Token2022 setTransferFee ABI; memo text alone cannot establish fees", async () => {
    const {session, state} = await requestCase(devnet);
    const account = session.transactions[0]!.accounts.find((a) => a.address)!;
    // Synthetic ABI unit instruction using recorded accounts; not claimed as an executed transaction.
    const data = new Uint8Array(12); data[0] = 26; data[1] = 5;
    new DataView(data.buffer).setUint16(2, 75, true); new DataView(data.buffer).setBigUint64(4, 2000000n, true);
    const raw: ResolvedInstruction = {index: 0, programIdIndex: 0, programAddress: TOKEN_2022_PROGRAM as Address, accounts: [account, account], data};
    const fee = decoder.decodeInstruction(raw);
    expect(fee.status).toBe("named"); expect(fee.name).toBe("setTransferFee");
    const c = context(session, state, [[fee]]);
    expect(c.candidates.find((x) => x.kind === "fees")?.reasons[0]?.text).toContain("75 basis points, maximum 2000000 base units");
    const memo = decoder.decodeInstruction({...raw, programAddress: MEMO_PROGRAM as Address, data: new TextEncoder().encode("Q4 fee update")});
    const m = context(session, {}, [[memo]]);
    expect(m.candidates[0]?.kind).toBe("memo"); expect(m.complex).toBe(false);
    expect(m.candidates.some((x) => x.kind === "fees")).toBe(false);
    const unknown: DecodedInstruction = {...fee, status: "unknown", name: null, args: null, decoder: "none"};
    const u = context(session, state, [[memo, unknown]]);
    expect(u.candidates[0]?.kind).toBe("unknown"); expect(u.complex).toBe(true);
  });

  it("decodes stored Squads fee proposals and never lets the same fee label hide authority", async () => {
    const {session, state, report} = await recorded("admin-local");
    const changed = structuredClone(state);
    const vault = Object.values(changed.squads!).find((a) => a.name === "VaultTransaction")!;
    const old = vault.data.message as SquadsMessage;
    const mint = old.accountKeys.find((a) => a !== TOKEN_2022_PROGRAM)!;
    const data = new Uint8Array(12); data[0] = 26; data[1] = 5;
    new DataView(data.buffer).setUint16(2, 75, true); new DataView(data.buffer).setBigUint64(4, 2000000n, true);
    // Explicit synthetic replacement in real recorded state; S17 owns live positive fee provenance.
    vault.data.message = {numSigners: 1, numWritableSigners: 0, numWritableNonSigners: 1, accountKeys: [old.accountKeys[0]!, mint, TOKEN_2022_PROGRAM], instructions: [{programIdIndex: 2, accountIndexes: new Uint8Array([1, 0]), data}], addressTableLookups: []} satisfies SquadsMessage;
    const decoded = decoder.decodeSession(session);
    // Same synthetic signed-memo mutation for both governance cases; underlying authority fixture is real.
    const memo = decoder.decodeInstruction({index: decoded[0]!.length, programIdIndex: 0, programAddress: MEMO_PROGRAM as Address, accounts: [], data: new TextEncoder().encode("Q4 fee update")});
    decoded[0]!.push(memo);
    const build = (state: RuleState) => {
      const builder = new ReportBuilder(session);
      const ctx = runRules({session, decoded, state, decoder, report: builder});
      addIntentSourceEvidence(ctx);
      return builder.build();
    };
    const feeReport = build(changed);
    const fees = buildIntentContext({session, decoded, state: changed, report: feeReport, decoder});
    expect(fees.candidates.some((x) => x.kind === "authority")).toBe(false);
    const candidate = fees.candidates.find((x) => x.kind === "fees")!;
    expect(candidate.question).toContain("approve this proposed future");
    expect(candidate.reasons[0]!.text).toContain("75 basis points");
    expect(candidate.reasons[0]!.text).toContain("Approval alone does not execute");
    expect(candidate.reasons[0]!.evidenceIds.length).toBeGreaterThan(0);
    const attackReport = build(state);
    expect(attackReport.claims.some((c) => c.ruleId === "intent.label_mismatch")).toBe(true);
    expect(feeReport.claims.some((c) => c.ruleId === "intent.label_mismatch")).toBe(false);
    expect(report.digest).not.toBe(attackReport.digest);
    const attack = buildIntentContext({session, decoded, state, report: attackReport, decoder});
    expect(attack.candidates[0]?.kind).toBe("authority");
    expect(attack.candidates.some((x) => x.kind === "fees")).toBe(false);
  });

  it("retains real S17 fetched fee-proposal state and decoded inner instruction as report evidence", async () => {
    const recorded = json<{approvalWire: string; state: RuleState; approvalInstruction: unknown}>("packages/core/test/fixtures/intent/fee-proposal-state.json");
    const state = structuredClone(recorded.state);
    for (const account of Object.values(state.squads!)) for (const field of ["index", "transactionIndex", "staleTransactionIndex"]) {
      const value = account.data[field];
      if (typeof value === "string") account.data[field] = BigInt(value);
    }
    const stored = state.squads!["2UQxNHydgszFLemenEB7zNgLkF5r8ombYtQtGYxdrPKC"]!;
    const message = stored.data.message as SquadsMessage;
    // JSON serialization of genuine Uint8Array state; restore bytes without altering values.
    for (const ix of message.instructions) {
      ix.accountIndexes = Uint8Array.from(Object.values(ix.accountIndexes));
      ix.data = Uint8Array.from(Object.values(ix.data));
    }
    const session = await sessionOf([recorded.approvalWire]);
    const {report, intentContext: c} = await analyzeSession(session, {decoder, state});
    expect(c.messageHashes).toEqual(report.session.transactions.map((t) => t.messageHash));
    expect(report.evidence.find((e) => e.type === "instruction" && e.instructionPath?.length === 1)?.data).toEqual(recorded.approvalInstruction);
    const fee = c.candidates.find((x) => x.kind === "fees")!;
    expect(fee).toBeDefined();
    expect(fee.reasons[0]!.text).toContain("75 basis points, maximum 2000000 base units");
    const source = report.evidence.find((e) => e.type === "account" && e.address === "2UQxNHydgszFLemenEB7zNgLkF5r8ombYtQtGYxdrPKC")!;
    expect(source).toBeDefined();
    expect(source.data).toEqual({name: stored.name, data: toJsonValue(stored.data)});
    expect(fee.reasons[0]!.evidenceIds).toContain(source.id);
    const inner = report.evidence.find((e) => e.type === "instruction" && e.instructionPath?.length === 2 && e.data && typeof e.data === "object" && !Array.isArray(e.data) && e.data.name === "setTransferFee")!;
    expect(inner).toBeDefined();
    expect(fee.reasons[0]!.evidenceIds).toContain(inner.id);
    expect(report.claims.some((claim) => claim.kind === "Fact" && claim.evidenceIds.includes(source.id) && claim.evidenceIds.includes(inner.id))).toBe(true);
    expect((await analyzeSession(session, {decoder, state})).report.digest).toBe(report.digest);
    // A previously-built approval-only report cannot stand in for the missing stored snapshot.
    const missingSource = {...report, evidence: report.evidence.filter((e) => e.id !== source.id)};
    const unavailable = buildIntentContext({session, state, decoded: decoder.decodeSession(session), report: missingSource, decoder});
    expect(unavailable.candidates.some((x) => x.kind === "fees")).toBe(false);
    expect(unavailable.candidates.some((x) => x.kind === "unknown")).toBe(true);
  });

  it("rejects malformed shapes, caps, duplicate ids, invalid comparisons and stale hash binding", async () => {
    const {intentContext: c} = await recorded("admin-local");
    const hashes = c.messageHashes;
    const mutations: ((v: IntentContext) => unknown)[] = [
      (v) => ({...v, extra: true}), (v) => ({...v, complex: false}), (v) => ({...v, fallbackId: "missing"}),
      (v) => ({...v, candidates: [...v.candidates, v.candidates[0]]}),
      (v) => ({...v, candidates: Array(9).fill(v.candidates[0])}),
      (v) => ({...v, historyNote: "x".repeat(601)}),
      (v) => ({...v, messageHashes: Array(65).fill(hashes[0])}),
      (v) => { v.candidates[0]!.reasons = Array(7).fill(v.candidates[0]!.reasons[0]); return v; },
      (v) => { Object.assign(v.candidates[0]!, {extra: true}); return v; },
      (v) => { Object.assign(v.candidates[0]!.reasons[0]!, {extra: true}); return v; },
      (v) => { v.fallbackId = v.candidates.find((x) => x.priority < 4)!.id; return v; },
      (v) => { v.candidates[0]!.question = "x".repeat(301); return v; },
      (v) => { v.candidates[0]!.reasons[0]!.text = "x".repeat(601); return v; },
      (v) => { v.candidates[0]!.reasons[0]!.evidenceIds = ["not-evidence"]; return v; },
      (v) => { v.candidates[0]!.comparison = {proposed: devnet.recipient, previous: devnet.lookalikeOf!, prefix: 0, suffix: 0}; return v; },
      (v) => { v.candidates[0]!.reasons.push(v.candidates[0]!.reasons[0]!); return v; }
    ];
    for (const mutate of mutations) expect(validateIntentContext(mutate(structuredClone(c)), hashes)).toBeNull();
    expect(validateIntentContext(c, [...hashes].reverse().concat(hashes))).toBeNull();
    expect(validateIntentContext(null, hashes)).toBeNull();
  });
  it("treats real wallet transfers carrying ComputeBudget settings as routine; unknown programs and undecodable budget data stay complex", async () => {
    const BUDGET = "ComputeBudget111111111111111111111111111111";
    let checked = 0;
    for (const c of poisonManifest.cases.filter((x) => x.kind === "first-send")) {
      const {session, state} = await requestCase(c);
      const decoded = decoder.decodeSession(session);
      const flat = decoded.flat();
      if (!flat.some((ix) => ix.programAddress === BUDGET) || flat.length !== 3 || flat[2]!.name !== "transferSol") continue;
      const base = context(session, state, decoded);
      expect(base.complex).toBe(false);
      expect(base.candidates[0]?.kind).toBe("transfer");
      expect(base.fallbackId).toBe(base.candidates[0]!.id);
      expect(base.candidates.some((x) => x.kind === "unknown")).toBe(false);
      const withUnknown = structuredClone(decoded);
      withUnknown[0]!.push({...withUnknown[0]![0]!, index: 99, programAddress: "Vote111111111111111111111111111111111111111" as Address, programName: null, data: new Uint8Array([7, 7])});
      expect(context(session, state, withUnknown).complex).toBe(true);
      const badBudget = structuredClone(decoded);
      badBudget[0]![0]!.data = new Uint8Array([0, 1, 2]);
      expect(context(session, state, badBudget).complex).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
