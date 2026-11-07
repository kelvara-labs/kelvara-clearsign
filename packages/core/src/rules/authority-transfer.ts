import { UPGRADEABLE_LOADER_PROGRAM } from "../decode/builtin.js";
import type { CapabilityClass } from "../report/rubrics.js";
import { accountNamed, instructionEvidence, sessionSigners } from "./common.js";
import { arg, proposalViews, vaultInstructions } from "./squads-session.js";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "../state/layouts.js";
import type { DecodedInstruction } from "../decode/types.js";
import type { Rule, RuleContext } from "./types.js";

/** Include proposed instructions: these authorize a future change, not proof it executed. */
export function authorityInstructions(ctx: RuleContext): { ix: DecodedInstruction; txIndex: number; path: number[]; proposed: boolean; evidence: string[] }[] {
  const out = ctx.decoded.flatMap((ixs, txIndex) => ixs.map((ix) => ({ ix, txIndex, path: [ix.index], proposed: false, evidence: [] as string[] })));
  if (!ctx.decoder) return out;
  for (const v of proposalViews(ctx)) {
    if (!v.message || v.message.addressTableLookups.length) continue;
    const call = v.transactionCreate ?? v.executes[0] ?? v.approvals[0];
    if (!call) continue;
    const evidence = [instructionEvidence(ctx, call.txIndex, call.ix)];
    if (v.contentSource === "state") evidence.push(ctx.report.addEvidence({ type: "account", source: "rpc", address: v.transaction, summary: "Stored Squads vault transaction message", data: v.message }));
    for (const raw of vaultInstructions(v.message)) out.push({ ix: ctx.decoder.decodeInstruction(raw), txIndex: call.txIndex, path: [call.ix.index, raw.index], proposed: true, evidence });
  }
  return out;
}

export const isToken = (ix: DecodedInstruction): boolean => ix.programAddress === TOKEN_PROGRAM || ix.programAddress === TOKEN_2022_PROGRAM;
export function authorityType(ix: DecodedInstruction): string | null {
  const t = arg(ix, "authorityType");
  const name = typeof t === "string" ? t : t && typeof t === "object" && "__kind" in t ? String(t.__kind) : null;
  return name ? name[0]!.toLowerCase() + name.slice(1) : null;
}

export const authorityTransferRule: Rule = {
  id: "authority.transfer", ruleIds: ["authority.transfer"], description: "Explicit token, loader and Drift admin authority changes.",
  run(ctx) {
    const signers = sessionSigners(ctx);
    for (const c of authorityInstructions(ctx)) {
      const ix = c.ix;
      if (ix.status !== "named") continue;
      let next: string | null = null, old: string | null = null, target: string | null = null;
      let capability = "", cls: CapabilityClass = "other";
      if (isToken(ix) && ix.name === "setAuthority") {
        next = typeof arg(ix, "newAuthority") === "string" ? String(arg(ix, "newAuthority")) : null;
        old = accountNamed(ix, "owner"); target = accountNamed(ix, "owned");
        const type = authorityType(ix);
        if (!type) continue;
        capability = `token.${type}`;
        cls = ({ mintTokens: "mint_control", freezeAccount: "freeze", accountOwner: "fund_movement", closeAccount: "account_control", permanentDelegate: "fund_movement" } as Record<string, CapabilityClass>)[type] ?? "config";
      } else if (ix.programAddress === UPGRADEABLE_LOADER_PROGRAM && ["setAuthority", "setAuthorityChecked"].includes(ix.name!)) {
        next = accountNamed(ix, "newAuthority"); old = accountNamed(ix, "currentAuthority"); target = accountNamed(ix, "account");
        capability = "program.upgrade"; cls = "code_control";
      } else if (ix.programAddress === "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH" && ix.name === "updateAdmin") {
        next = typeof arg(ix, "admin") === "string" ? String(arg(ix, "admin")) : null;
        old = accountNamed(ix, "admin"); target = accountNamed(ix, "state"); capability = "protocol.admin"; cls = "admin_control";
      } else continue;
      if (!target || next === old) continue;
      const id = ctx.report.addClaim({ kind: "Fact", ruleId: this.id, level: next && !signers.has(next) ? "L3" : "L1", statement: `${c.proposed ? "Proposed " : ""}${ix.name} ${capability} on ${target}: ${old ?? "current authority"} gives authority to ${next ?? "nobody (authority removed)"}.`, evidenceIds: [...c.evidence, instructionEvidence(ctx, c.txIndex, ix, c.path)], transactionIndices: [c.txIndex] });
      // A nonce raises urgency only when linked to an evidenced outside control grant.
      if (next && !signers.has(next)) {
        const transactions = new Set([c.txIndex]);
        if (c.proposed) for (const v of proposalViews(ctx)) {
          const call = v.transactionCreate ?? v.executes[0] ?? v.approvals[0];
          if (call?.txIndex === c.txIndex && call.ix.index === c.path[0]) {
            for (const linked of [...v.approvals, ...v.executes]) transactions.add(linked.txIndex);
          }
        }
        for (const t of transactions) ctx.claims.set(`controlGrant:${t}`, id);
      }
      if (next) ctx.report.addCapability({ direction: "granted", capability, class: cls, holder: next, target, claimId: id });
      if (old) ctx.report.addCapability({ direction: "revoked", capability, class: cls, holder: old, target, claimId: id });
    }
  }
};
