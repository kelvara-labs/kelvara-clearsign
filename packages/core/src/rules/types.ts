// Rule framework. A rule reads the decoded session (plus state read beforehand) and writes
// evidence and claims into the report builder. Rules are synchronous and never touch the network:
// the caller reads nonce accounts, their origin and Squads accounts first and passes them in
// RuleState, so the same rules run in the service worker, the CLI and the tests.
import type { DecodedInstruction } from "../decode/types.js";
import type { Decoder } from "../decode/decoder.js";
import type { SquadsAccount } from "../decode/squads.js";
import type { Session } from "../ingest/types.js";
import type { ReportBuilder } from "../report/builder.js";
import type { AccountOrigin, NonceState } from "../state/reads.js";

/** What the caller learned about one nonce account. `null` means it was looked up and not found. */
export interface NonceFacts {
  account?: NonceState | null;
  origin?: AccountOrigin | null;
  /** Network the facts were read from, for evidence. */
  source?: "rpc" | "helius";
}

/** Chain state the rules may use. Missing entries mean "not read", never "safe". */
export interface RuleState {
  /** Token names and decimals read over Helius (E26), by mint; token account -> mint for accounts the session names. Display only. */
  tokens?: Record<string, import("../state/token-meta.js").TokenMeta>;
  tokenAccountMints?: Record<string, string>;
  /** Program display names (E25) from a name list, by program id. Only names for evidence: never decoding, never a level. */
  programLabels?: { source: string; names: Record<string, string> };
  /** Connected wallet, never inferred from a fee payer or co-signer. Required for L4. */
  wallet?: string;
  /** Raw getAccountInfo results; owners and layouts are checked by rules. */
  accounts?: Record<string, import("../state/account-reader.js").AccountInfo | null>;
  /** Exact getFeeForMessage result per transaction (not an estimate). */
  fees?: Record<number, bigint>;
  /** Complete inventory from BOTH token programs. Incomplete inventories cannot prove a sweep. */
  walletInventory?: { complete: boolean; tokenAccounts: string[] };
  /** By nonce account address. */
  nonces?: Record<string, NonceFacts>;
  /** Squads v4 accounts (Multisig, Proposal, VaultTransaction) by address, owner already verified. */
  squads?: Record<string, SquadsAccount>;
  /** Wallet transfer history (readAddressRuleState) for the address rules; must be for `wallet`. */
  history?: import("../state/history.js").WalletHistory;
  /** Program accounts (readProgram) by program id: upgrade authority and ProgramData for the graph. */
  programs?: Record<string, import("../state/reads.js").ProgramState>;
  /** Old-authority history (readAuthorityHistory) by `${programId}:${authority}`, for the preview fallback. */
  authorityHistory?: Record<string, import("../state/authority-history.js").AuthorityHistory>;
  /** Simulation results by transaction index, for the preview's simulate-and-diff fallback. */
  simulations?: Record<number, import("../simulate/index.js").SimulationResult>;
}

export interface RuleContext {
  session: Session;
  /** Top-level decoded instructions per transaction, as Decoder.decodeSession returns them. */
  decoded: DecodedInstruction[][];
  report: ReportBuilder;
  state: RuleState;
  /** Decodes instructions inside Squads vault messages. Optional; without it inner calls stay Unknown. */
  decoder?: Decoder;
  /** Claim ids shared between rules, e.g. "nonce:<txIndex>". Filled in rule order. */
  claims: Map<string, string>;
}

export interface Rule {
  /** File-level id, e.g. "lifetime.durable_nonce". */
  id: string;
  /** Every ruleId this rule may put on a claim. */
  ruleIds: readonly string[];
  /** Short description, ported detector named when there is one. */
  description: string;
  run(ctx: RuleContext): void;
}
