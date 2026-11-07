// Rules (M2): one file per rule, run in this order; later rules may depend on earlier claims.
// E7: durable nonce, outsider-staged nonce and Squads approve/execute/threshold/time lock/unknown/config.
import { durableNonceRule } from "./lifetime-durable-nonce.js";
import { nonceStagedByOutsiderRule } from "./nonce-staged-by-outsider.js";
import { squadsApproveAndExecuteRule } from "./squads-approve-and-execute.js";
import { squadsConfigChangeRule } from "./squads-config-change.js";
import { squadsThresholdMetRule } from "./squads-threshold-met-in-session.js";
import { squadsUnknownProposalRule } from "./squads-unknown-proposal.js";
import { squadsZeroTimelockRule } from "./squads-zero-timelock-execution.js";
import type { Decoder } from "../decode/decoder.js";
import type { DecodedInstruction } from "../decode/types.js";
import type { Session } from "../ingest/types.js";
import type { ReportBuilder } from "../report/builder.js";
import type { Rule, RuleContext, RuleState } from "./types.js";

export const RULES: readonly Rule[] = [
  durableNonceRule,
  nonceStagedByOutsiderRule,
  squadsApproveAndExecuteRule,
  squadsThresholdMetRule,
  squadsZeroTimelockRule,
  squadsUnknownProposalRule,
  squadsConfigChangeRule
];

export const RULE_IDS: readonly string[] = RULES.flatMap((r) => r.ruleIds);

export interface RunRulesInput {
  session: Session;
  /** Decoder.decodeSession(session); computed from `decoder` when omitted. */
  decoded?: DecodedInstruction[][];
  decoder?: Decoder;
  report: ReportBuilder;
  state?: RuleState;
  rules?: readonly Rule[];
}

/** Runs every rule over the session, writing claims into `report`. Returns the context (claim keys). */
export function runRules(input: RunRulesInput): RuleContext {
  const decoded = input.decoded ?? input.decoder?.decodeSession(input.session);
  if (!decoded) throw new Error("runRules needs decoded instructions or a decoder");
  const ctx: RuleContext = { session: input.session, decoded, decoder: input.decoder, report: input.report, state: input.state ?? {}, claims: new Map() };
  for (const rule of input.rules ?? RULES) rule.run(ctx);
  return ctx;
}

export { describeConfigAction } from "./squads-config-change.js";
export { proposalViews, vaultInstructions, type ProposalView, type MultisigView } from "./squads-session.js";
export { durableNonceUse, type DurableNonceUse } from "./common.js";
export type { Rule, RuleContext, RuleState, NonceFacts } from "./types.js";
