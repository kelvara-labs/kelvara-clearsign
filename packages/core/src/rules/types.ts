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
  /** By nonce account address. */
  nonces?: Record<string, NonceFacts>;
  /** Squads v4 accounts (Multisig, Proposal, VaultTransaction) by address, owner already verified. */
  squads?: Record<string, SquadsAccount>;
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
