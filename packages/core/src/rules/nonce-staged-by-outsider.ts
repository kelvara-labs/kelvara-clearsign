// nonce.staged_by_outsider: the durable nonce this transaction advances was created and funded by
// a key that is neither the nonce authority nor a signer in the session. Someone else prepared a
// never-expiring signature slot for the signer: the setup of the Drift attack (April 2026) and of
// the admin-local scenario. Port of Helius Watchtower src/detectors/nonceAuthority.ts (MIT): there
// the monitor sees the outsider create a nonce for a privileged key; here the signer sees it at
// signing time, from the nonce account's oldest transaction (state/findAccountOrigin).
import { durableNonceUse, instructionEvidence, sessionSigners, short } from "./common.js";
import { SQUADS_PRIVILEGED } from "./lifetime-durable-nonce.js";
import type { Rule, RuleContext } from "./types.js";

export const RULE_ID = "nonce.staged_by_outsider";

export const nonceStagedByOutsiderRule: Rule = {
  id: RULE_ID,
  ruleIds: [RULE_ID],
  description: "Durable nonce funded by a key outside the session (Watchtower nonceAuthority.ts)",
  run(ctx: RuleContext) {
    const signers = sessionSigners(ctx);
    for (const tx of ctx.session.transactions) {
      const use = durableNonceUse(ctx, tx.index);
      if (!use) continue;
      const nonceClaim = ctx.claims.get(`nonce:${tx.index}`);
      const dependsOn = nonceClaim ? [nonceClaim] : [];
      const facts = use.nonceAccount ? ctx.state.nonces?.[use.nonceAccount] : undefined;
      const origin = facts?.origin;
      if (!use.nonceAccount || !origin) {
        // Fail closed: an unchecked funder is reported, never assumed safe.
        ctx.report.addClaim({
          kind: "Unknown",
          statement: `Who created nonce account ${short(use.nonceAccount)} was ${origin === null ? "not found in its history" : "not checked"}, so it is unknown whether an outsider prepared this never-expiring transaction.`,
          evidenceIds: [instructionEvidence(ctx, tx.index, use.ix)],
          dependsOn,
          ruleId: RULE_ID,
          level: "L1"
        });
        continue;
      }
      const authority = facts?.account?.authority ?? use.authority;
      const outsider = origin.funder !== authority && origin.funder !== use.authority && !signers.has(origin.funder);
      if (!outsider) continue;
      const evidence = [
        instructionEvidence(ctx, tx.index, use.ix),
        ctx.report.addEvidence({
          type: "history",
          source: facts?.source ?? "rpc",
          summary: `oldest transaction of nonce account ${use.nonceAccount}: funded by ${origin.funder} (${origin.method})`,
          address: use.nonceAccount,
          data: { ...origin }
        })
      ];
      if (facts?.account) {
        evidence.push(
          ctx.report.addEvidence({
            type: "account",
            source: facts.source ?? "rpc",
            summary: `nonce account ${use.nonceAccount}: authority ${facts.account.authority}`,
            address: use.nonceAccount,
            data: { ...facts.account }
          })
        );
      }
      const privileged = ctx.decoded[tx.index]!.some((ix) => ix.status === "named" && SQUADS_PRIVILEGED.has(ix.name!));
      ctx.report.addClaim({
        kind: origin.complete ? "Fact" : "Conditional",
        statement: `Nonce account ${short(use.nonceAccount)} was created and funded by ${short(origin.funder)}, who is not its authority ${short(authority)} and does not sign this session: someone else set up the never-expiring slot this signature fills${privileged ? ", for a multisig vote" : ""}.`,
        evidenceIds: evidence,
        dependsOn,
        ruleId: RULE_ID,
        assumptions: origin.complete ? [] : ["the account's history walk stopped early; the oldest transaction found is taken as its creation"],
        level: privileged ? "L3" : "L2"
      });
    }
  }
};
