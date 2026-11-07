// Rules (M2): one file per rule, run in this order; later rules may depend on earlier claims.
// E7: durable nonce, outsider-staged nonce and Squads approve/execute/threshold/time lock/unknown/config.
import { token2022PermanentDelegateRule } from "./token2022-permanent-delegate.js";
import { tokenFreezeAuthorityRule } from "./token-freeze-authority.js";
import { token2022TransferHookRule } from "./token2022-transfer-hook.js";
import { token2022DefaultFrozenRule } from "./token2022-default-frozen.js";
import { token2022NonTransferableRule } from "./token2022-non-transferable.js";
import { tokenDelegateGrantedRule } from "./token-delegate-granted.js";
import { tokenDelegateRevokedRule } from "./token-delegate-revoked.js";
import { systemAssignTakeoverRule } from "./system-assign-takeover.js";
import { tokenOwnerTakeoverRule } from "./token-owner-takeover.js";
import { walletSweepRule } from "./wallet-sweep.js";
import { addressHistoryRule } from "./address-history.js";
import { authorityTransferRule } from "./authority-transfer.js";
import { durableNonceRule } from "./lifetime-durable-nonce.js";
import { nonceStagedByOutsiderRule } from "./nonce-staged-by-outsider.js";
import { squadsApproveAndExecuteRule } from "./squads-approve-and-execute.js";
import { squadsConfigChangeRule } from "./squads-config-change.js";
import { squadsThresholdMetRule } from "./squads-threshold-met-in-session.js";
import { squadsUnknownProposalRule } from "./squads-unknown-proposal.js";
import { squadsZeroTimelockRule } from "./squads-zero-timelock-execution.js";
import type { Decoder } from "../decode/decoder.js";
import { GRAPH_RULE_IDS, runCapabilityGraph } from "../graph/preview.js";
import type { AuthorityMap } from "../graph/authority-map.js";
import type { DecodedInstruction } from "../decode/types.js";
import type { Session } from "../ingest/types.js";
import type { ReportBuilder } from "../report/builder.js";
import type { Rule, RuleContext, RuleState } from "./types.js";

export const RULES: readonly Rule[] = [
  authorityTransferRule,
  durableNonceRule,
  nonceStagedByOutsiderRule,
  squadsApproveAndExecuteRule,
  squadsThresholdMetRule,
  squadsZeroTimelockRule,
  squadsUnknownProposalRule,
  squadsConfigChangeRule,
  tokenDelegateGrantedRule,
  tokenDelegateRevokedRule,
  token2022PermanentDelegateRule,
  tokenFreezeAuthorityRule,
  token2022TransferHookRule,
  token2022DefaultFrozenRule,
  token2022NonTransferableRule,
  systemAssignTakeoverRule,
  tokenOwnerTakeoverRule,
  walletSweepRule,
  addressHistoryRule
];

/** Every ruleId a claim may carry: the rules' plus the capability graph's (preview, recovery paths). */
export const RULE_IDS: readonly string[] = RULES.flatMap((r) => r.ruleIds);
export const ALL_RULE_IDS: readonly string[] = [...RULE_IDS, ...GRAPH_RULE_IDS];

export interface RunRulesInput {
  session: Session;
  /** Decoder.decodeSession(session); computed from `decoder` when omitted. */
  decoded?: DecodedInstruction[][];
  decoder?: Decoder;
  report: ReportBuilder;
  state?: RuleState;
  rules?: readonly Rule[];
  /** Authority maps for the capability preview. The graph runs after the rules unless `graph: false`. */
  authorityMaps?: readonly AuthorityMap[];
  graph?: boolean;
}

/** Runs every rule over the session, writing claims into `report`. Returns the context (claim keys). */
export function runRules(input: RunRulesInput): RuleContext {
  const decoded = input.decoded ?? input.decoder?.decodeSession(input.session);
  if (!decoded) throw new Error("runRules needs decoded instructions or a decoder");
  const ctx: RuleContext = { session: input.session, decoded, decoder: input.decoder, report: input.report, state: input.state ?? {}, claims: new Map() };
  for (const rule of input.rules ?? RULES) rule.run(ctx);
  if (input.graph !== false) runCapabilityGraph(ctx, { maps: input.authorityMaps });
  return ctx;
}

export { readTokenRuleState } from "./read-token-state.js";
export { readAddressRuleState, requestTransfers, assessRecipient, type RequestTransfer, type RecipientAssessment } from "./address-history.js";
export { describeConfigAction } from "./squads-config-change.js";
export { proposalViews, vaultInstructions, type ProposalView, type MultisigView } from "./squads-session.js";
export { durableNonceUse, type DurableNonceUse } from "./common.js";
export type { Rule, RuleContext, RuleState, NonceFacts } from "./types.js";
