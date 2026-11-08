// M4 / E14: one-call analysis. Reads the chain state the rules need (over an injected RpcClient: Helius or
// localnet), simulates each transaction, runs the rules and the capability graph, sets the report's
// "what simulation shows" section and returns a validated report. Without an RpcClient it runs the rules
// on the session alone (nothing read means "not read", never "safe"). Shared by the CLI and the extension;
// no Node imports, so it stays service-worker safe.
import { addIntentSourceEvidence, buildIntentContext, type IntentContext } from "./intent.js";
import { getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import type { Decoder } from "../decode/decoder.js";
import type { DecodedInstruction } from "../decode/types.js";
import { UPGRADEABLE_LOADER_PROGRAM } from "../decode/builtin.js";
import { SQUADS_V4_PROGRAM } from "../decode/squads.js";
import type { AuthorityMap } from "../graph/authority-map.js";
import type { Session } from "../ingest/types.js";
import { ReportBuilder } from "../report/builder.js";
import type { Report } from "../report/schema.js";
import { validateReport } from "../report/validate.js";
import type { RpcClient } from "../rpc/client.js";
import { createRpcAccountReader, type RpcAccountReader } from "../rpc/methods.js";
import { readAddressRuleState } from "../rules/address-history.js";
import { runRules } from "../rules/index.js";
import { lamportsText, tokenText } from "../util/amounts.js";
import { readTokenRuleState } from "../rules/read-token-state.js";
import type { RuleState } from "../rules/types.js";
import { simulateSessionTransaction, type SimulationResult } from "../simulate/index.js";
import { readAuthorityHistory } from "../state/authority-history.js";
import { findAccountOrigin, readNonceAccount, readProgram, readSquadsAccount, type SquadsAccountDecoder } from "../state/reads.js";

export interface AnalyzeOptions {
  decoder: Decoder;
  /** Helius or localnet client. Omitted or null: offline, rules on the session alone. */
  rpc?: RpcClient | null;
  /** Decodes Squads v4 accounts (Multisig, Proposal, VaultTransaction); without it they are not read. */
  squadsAccounts?: SquadsAccountDecoder;
  /** Authority maps for the capability preview. */
  authorityMaps?: readonly AuthorityMap[];
  /** Connected wallet. Never inferred; the wallet-bound rules (token traps, sweep, address history) need it. */
  wallet?: string;
  /** Simulate each transaction (default true when online). */
  simulate?: boolean;
  /** Read Helius history: the wallet's transfers and old-authority calls (default true when online). */
  history?: boolean;
  /** Read the wallet's full token inventory and exact fees (sweep proof). Default false. */
  inventory?: boolean;
  /** Base state merged under what is read (e.g. recorded facts). */
  state?: RuleState;
}

/** One state read, for the CLI's log and for tests. A failed read leaves the fact "not read". */
export interface ReadNote {
  what: string;
  address: string | null;
  ok: boolean;
  detail?: string;
}

export interface AnalyzeResult {
  report: Report;
  intentContext: IntentContext;
  state: RuleState;
  reads: ReadNote[];
}

const ADVANCE_NONCE_TAG = 4;
const SQUADS_STATE_ACCOUNTS = ["multisig", "proposal", "transaction"];

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Nonce accounts used by AdvanceNonceAccount as the first instruction of a transaction. */
function nonceAccounts(decoded: DecodedInstruction[][]): string[] {
  const out = new Set<string>();
  for (const ixs of decoded) {
    const first = ixs[0];
    if (first?.programAddress === "11111111111111111111111111111111" && first.data[0] === ADVANCE_NONCE_TAG && first.data.length >= 4) {
      const a = first.accounts[0]?.address;
      if (a) out.add(a);
    }
  }
  return [...out];
}

function squadsStateAccounts(decoded: DecodedInstruction[][]): string[] {
  const out = new Set<string>();
  for (const ixs of decoded)
    for (const ix of ixs) {
      if (ix.programAddress !== SQUADS_V4_PROGRAM || ix.status !== "named") continue;
      for (const a of ix.accounts) if (a.address && a.name && SQUADS_STATE_ACCOUNTS.includes(a.name)) out.add(a.address);
    }
  return [...out];
}

/** Squads v4 transaction PDA: ["multisig", multisig, "transaction", index u64 LE]. */
export async function squadsTransactionPda(multisig: string, index: bigint): Promise<string> {
  const le = new Uint8Array(8);
  new DataView(le.buffer).setBigUint64(0, index, true);
  const enc = new TextEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: SQUADS_V4_PROGRAM as Address,
    seeds: [enc.encode("multisig"), getAddressEncoder().encode(multisig as Address), enc.encode("transaction"), le]
  });
  return pda;
}

const bigintOf = (v: unknown): bigint | null => (typeof v === "bigint" ? v : typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);

/** The Program account whose ProgramData is `programData` (loader Program layout: tag 2 + 32-byte key). */
async function programOfProgramData(reader: RpcAccountReader, programData: string): Promise<string | null> {
  const res = await reader.rpc.call<{ pubkey: string }[] | { value: { pubkey: string }[] }>("getProgramAccounts", [
    UPGRADEABLE_LOADER_PROGRAM,
    { encoding: "base64", dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: 36 }, { memcmp: { offset: 4, bytes: programData } }] }
  ]);
  const list = Array.isArray(res) ? res : res?.value ?? [];
  return list.length === 1 ? list[0]!.pubkey : null;
}

function rulesPass(session: Session, decoded: DecodedInstruction[][], opts: AnalyzeOptions, state: RuleState): ReportBuilder {
  const report = new ReportBuilder(session);
  runRules({ session, decoded, decoder: opts.decoder, report, state, authorityMaps: opts.authorityMaps });
  return report;
}

/** Short, factual "what simulation shows" line per transaction, each backed by a simulation evidence. */
export function addSimulationSummary(report: ReportBuilder, sims: Record<number, SimulationResult>, txCount: number): void {
  const idx = Object.keys(sims).map(Number).sort((a, b) => a - b);
  if (!idx.length) return;
  const lines: string[] = [];
  const evidenceIds: string[] = [];
  let failed = 0;
  for (const t of idx) {
    const s = sims[t]!;
    const parts: string[] = [];
    if (!s.ok) {
      failed++;
      parts.push(`fails (${JSON.stringify(s.err)})`);
    } else {
      for (const c of s.solChanges) parts.push(`${c.address} ${lamportsText(c.delta)}`);
      for (const c of s.tokenChanges) parts.push(`${c.owner} ${tokenText(c.delta, c.decimals)} of mint ${c.mint}`);
      for (const c of s.stateChanges) parts.push(`${c.field} of ${c.address}: ${c.before ?? "none"} -> ${c.after ?? "none"}`);
      if (!parts.length) parts.push("no balance or authority changes in the accounts read");
      if (s.accountsOmitted.length) parts.push(`${s.accountsOmitted.length} accounts not read (changes unknown)`);
    }
    const head = `Transaction ${t}${txCount > 1 ? ` of ${txCount}` : ""}`;
    const assume = s.blockhashReplaced ? " (simulated with a replaced blockhash)" : "";
    const line = `${head}${assume}: ${parts.join("; ")}`;
    lines.push(line);
    evidenceIds.push(
      report.addEvidence({
        type: "simulation",
        source: "simulation",
        transactionIndex: t,
        summary: `Simulation shows: ${line}`,
        data: {
          ok: s.ok,
          err: s.err === undefined ? null : s.err,
          unitsConsumed: s.unitsConsumed,
          blockhashReplaced: s.blockhashReplaced,
          solChanges: s.solChanges,
          tokenChanges: s.tokenChanges,
          stateChanges: s.stateChanges,
          accountsOmitted: s.accountsOmitted
        }
      })
    );
  }
  const status = failed === idx.length ? "failed" : "ok";
  const missing = txCount - idx.length;
  report.setSimulation({
    status,
    summary: `Simulation shows: ${lines.join(" | ")}${missing > 0 ? ` | ${missing} transaction(s) not simulated` : ""}`,
    evidenceIds
  });
}

/** Read state, simulate, run rules and the capability graph, and return a validated report. */
export async function analyzeSession(session: Session, opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const decoded = opts.decoder.decodeSession(session);
  const reads: ReadNote[] = [];
  let state: RuleState = { ...(opts.state ?? {}) };
  if (opts.wallet) state.wallet = opts.wallet;
  const rpc = opts.rpc ?? null;

  if (rpc) {
    const reader = createRpcAccountReader(rpc);
    const note = async <T>(what: string, address: string | null, fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        const v = await fn();
        reads.push({ what, address, ok: true });
        return v;
      } catch (e) {
        reads.push({ what, address, ok: false, detail: errText(e) });
        return undefined;
      }
    };

    // Nonces and who funded them.
    for (const n of nonceAccounts(decoded)) {
      const account = await note("nonce", n, () => readNonceAccount(reader, n));
      const origin = account ? await note("nonce origin", n, () => findAccountOrigin(rpc, n, { maxPages: 3 })) : undefined;
      state.nonces = { ...state.nonces, [n]: { ...(account !== undefined ? { account } : {}), ...(origin !== undefined ? { origin } : {}), source: rpc.network === "localnet" ? "rpc" : "helius" } };
    }

    // Squads accounts named by the session (owner and layout checked by readSquadsAccount).
    if (opts.squadsAccounts) {
      for (const a of squadsStateAccounts(decoded)) {
        const acc = await note("squads account", a, () => readSquadsAccount(reader, opts.squadsAccounts!, a));
        if (acc) state.squads = { ...state.squads, [a]: { name: acc.name, data: acc.data } };
      }
      // A vote names the proposal only; its transaction account is the PDA of (multisig, index).
      for (const [a, acc] of Object.entries(state.squads ?? {})) {
        if (acc.name !== "Proposal") continue;
        const index = bigintOf(acc.data.transactionIndex ?? acc.data.transaction_index);
        const multisig = acc.data.multisig ? String(acc.data.multisig) : null;
        if (index === null || !multisig) continue;
        const pda = await note("squads transaction pda", a, () => squadsTransactionPda(multisig, index));
        if (!pda || state.squads?.[pda]) continue;
        const tx = await note("squads account", pda, () => readSquadsAccount(reader, opts.squadsAccounts!, pda));
        if (tx) state.squads = { ...state.squads, [pda]: { name: tx.name, data: tx.data } };
      }
    }

    // Token accounts and mints the session touches (wallet-bound rules), then the wallet's history.
    if (state.wallet) {
      const wallet = state.wallet;
      const tok = await note("token state", wallet, () => readTokenRuleState(reader, session, wallet, { inventory: opts.inventory === true }));
      if (tok) state = { ...state, accounts: { ...state.accounts, ...tok.accounts }, fees: { ...state.fees, ...tok.fees }, ...(tok.walletInventory ? { walletInventory: tok.walletInventory } : {}) };
      if (opts.history !== false) {
        const withHistory = await note("wallet history", wallet, () => readAddressRuleState(rpc, session, decoded, state));
        if (withHistory) state = withHistory;
      }
    }

    // Simulation (sigVerify off; a failed simulation is reported, not hidden).
    if (opts.simulate !== false) {
      const sims: Record<number, SimulationResult> = {};
      for (const tx of session.transactions) {
        const s = await note("simulation", null, () => simulateSessionTransaction(rpc, tx, { reader }));
        if (s) sims[tx.index] = s;
      }
      state.simulations = { ...state.simulations, ...sims };
    }

    // Pass 1 tells which programs and old authorities the capability graph needs.
    const first = rulesPass(session, decoded, opts, state);
    const programs = { ...state.programs };
    const history = { ...state.authorityHistory };
    const maps = new Set((opts.authorityMaps ?? []).map((m) => m.programId));
    for (const cap of first.listCapabilities()) {
      let programId = cap.programId;
      if (!programId && cap.capability === "program.upgrade" && cap.target) {
        const target = cap.target;
        if (Object.values(programs).some((p) => p.program === target || p.programData === target)) continue;
        const acc = await note("upgrade target", target, () => reader.getAccountInfo(target as Address, { dataSlice: { offset: 0, length: 4 } }));
        if (acc && acc.owner === UPGRADEABLE_LOADER_PROGRAM && acc.data[0] === 2) programId = target;
        else if (acc && acc.owner === UPGRADEABLE_LOADER_PROGRAM && acc.data[0] === 3) programId = (await note("program of ProgramData", target, () => programOfProgramData(reader, target))) ?? null;
      }
      if (programId && !programs[programId]) {
        const p = await note("program", programId, () => readProgram(reader, programId!));
        if (p) programs[programId] = p;
      }
      // Old-authority history only where no authority map or curated list covers the program.
      if (opts.history !== false && cap.direction === "revoked" && cap.holder && programId && !maps.has(programId)) {
        const key = `${programId}:${cap.holder}`;
        if (!history[key] && programs[programId]?.loader === UPGRADEABLE_LOADER_PROGRAM) {
          const h = await note("authority history", cap.holder, () => readAuthorityHistory(rpc, { authority: cap.holder!, programId: programId! }));
          if (h) history[key] = h;
        }
      }
    }
    state = { ...state, programs, authorityHistory: history };
  }

  const report = rulesPass(session, decoded, opts, state);
  addIntentSourceEvidence({ session, decoded, state, decoder: opts.decoder, report, claims: new Map() });
  if (state.simulations) addSimulationSummary(report, state.simulations, session.transactions.length);
  const built = report.build();
  const v = validateReport(built);
  if (!v.ok) throw new Error(`engine produced an invalid report: ${v.problems.join("; ")}`);
  return { report: built, state, reads, intentContext: buildIntentContext({ session, decoded, state, report: built, decoder: opts.decoder }) };
}
