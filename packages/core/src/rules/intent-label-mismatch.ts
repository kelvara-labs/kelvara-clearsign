// intent.label_mismatch: a human-readable label in the session (a Memo instruction, or the memo of
// a Squads call) says one thing while the same transaction, or the proposal it votes on, hands a
// high-damage power to a key outside the session, and the label never mentions that power.
// Fires only when a label exists. Labels are shown as written (attackers use them, PLAN section 3);
// the caller's own label (wallet method, input name) is not an intent and is not read.
import { instructionEvidence } from "./common.js";
import { grantText, outsideGrants, type OutsideGrant } from "./session-links.js";
import { arg } from "./squads-session.js";
import type { CapabilityClass } from "../report/rubrics.js";
import type { DecodedInstruction } from "../decode/types.js";
import type { Rule, RuleContext } from "./types.js";

export const RULE_ID = "intent.label_mismatch";

/** Words that, in a label, name a power of that class. Anything else does not disclose it. */
const DISCLOSES: Partial<Record<CapabilityClass, RegExp>> = {
  code_control: /upgrad|authorit|deploy|admin|owner|handover|hand over|hand-over|migrat|rotat|control/,
  admin_control: /admin|authorit|owner|governan|council|handover|hand over|hand-over|migrat|rotat|control/,
  fund_movement: /delegat|authorit|owner|withdraw|allowance|approv|sweep|transfer|move|control/,
  mint_control: /mint|authorit|control/,
  account_control: /owner|close|authorit|assign|control/,
  freeze: /freez|authorit|control/
};

/** A label that reads as words (not a UUID or an order id): at least one run of three letters. */
const describes = (text: string): boolean => /\p{L}{3,}/u.test(text.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ""));

interface Label {
  txIndex: number;
  text: string;
  ix: DecodedInstruction;
  where: string;
}

function labels(ctx: RuleContext): Label[] {
  const out: Label[] = [];
  ctx.decoded.forEach((ixs, txIndex) => {
    for (const ix of ixs) {
      if (ix.status !== "named") continue;
      const memo = arg(ix, "memo");
      if (typeof memo !== "string" || !memo.trim() || !describes(memo)) continue;
      out.push({ txIndex, text: memo, ix, where: ix.name === "memo" ? "memo" : `memo of ${ix.name}` });
    }
  });
  return out;
}

export const intentLabelMismatchRule: Rule = {
  id: RULE_ID,
  ruleIds: [RULE_ID],
  description: "A memo label that does not mention the power the labeled transaction hands out",
  run(ctx: RuleContext) {
    const found = labels(ctx);
    if (!found.length) return;
    const grants = outsideGrants(ctx).filter((g) => DISCLOSES[g.cap.class]);
    for (const txIndex of new Set(found.map((l) => l.txIndex))) {
      const here = found.filter((l) => l.txIndex === txIndex);
      const texts = [...new Set(here.map((l) => l.text))];
      const hidden: OutsideGrant[] = grants.filter((g) => g.txs.includes(txIndex) && !texts.some((t) => DISCLOSES[g.cap.class]!.test(t.toLowerCase())));
      if (!hidden.length) continue;
      ctx.report.addClaim({
        kind: "Derived",
        ruleId: RULE_ID,
        level: "L2",
        statement: `Transaction ${txIndex} is labeled ${texts.map((t) => JSON.stringify(t)).join(" and ")} (${[...new Set(here.map((l) => l.where))].join(", ")}), but it carries ${hidden.map(grantText).join("; ")}. The label does not mention that power.`,
        evidenceIds: here.map((l) => instructionEvidence(ctx, txIndex, l.ix)),
        dependsOn: [...new Set(hidden.map((g) => g.cap.claimId))],
        transactionIndices: [txIndex]
      });
    }
  }
};
