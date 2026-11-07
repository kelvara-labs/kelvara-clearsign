// squads.config_change: the session proposes, approves or executes a Squads config transaction
// (members, threshold, time lock, spending limits, rent collector), or a config authority changes a
// controlled multisig directly, without a member vote. Port of Helius Watchtower
// src/detectors/multisigChange.ts (AUTHORITY_CHANGES, configActions, describeAction; MIT), rewritten
// on our decoded session. Severity map: Watchtower critical = L3, high = L2, medium = L1.
import type { AlertLevel } from "../report/rubrics.js";
import { maxLevel } from "../report/rubrics.js";
import { instructionEvidence, sessionSigners, short } from "./common.js";
import { arg, proposalViews, squadsCalls } from "./squads-session.js";
import type { Rule, RuleContext } from "./types.js";

export const RULE_ID = "squads.config_change";

interface Described {
  text: string;
  level: AlertLevel;
}

const field = (o: unknown, ...names: string[]): unknown => {
  if (!o || typeof o !== "object") return undefined;
  const r = o as Record<string, unknown>;
  for (const n of names) {
    const snake = n.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (r[n] !== undefined) return r[n];
    if (r[snake] !== undefined) return r[snake];
  }
  return undefined;
};

function permissionsText(mask: number | undefined): string {
  if (mask === undefined || Number.isNaN(mask)) return "unknown permissions";
  const parts = [mask & 1 ? "initiate" : "", mask & 2 ? "vote" : "", mask & 4 ? "execute" : ""].filter(Boolean);
  return parts.join("/") || "no permissions";
}

/** Codama enums decode as { __kind, ...fields }; Anchor JSON as { Variant: { ...fields } }. */
function variantOf(action: unknown): [string, Record<string, unknown>] {
  if (typeof action === "string") return [action, {}];
  const o = (action ?? {}) as Record<string, unknown>;
  if (typeof o.__kind === "string") return [o.__kind, o];
  const [k, v] = Object.entries(o)[0] ?? ["unknown", {}];
  return [k, (v ?? {}) as Record<string, unknown>];
}

/** `outside`: true when a key is not a signer in this session. */
export function describeConfigAction(action: unknown, outside: (key: string) => boolean): Described {
  const [variant, f] = variantOf(action);
  switch (variant) {
    case "AddMember": {
      const m = field(f, "newMember");
      const key = String(field(m, "key") ?? "?");
      const mask = Number(field(field(m, "permissions"), "mask"));
      return { text: `add member ${key} (${permissionsText(mask)})${outside(key) ? ", a key outside this session" : ""}`, level: "L2" };
    }
    case "RemoveMember":
      return { text: `remove member ${String(field(f, "oldMember"))}`, level: "L2" };
    case "ChangeThreshold": {
      const t = Number(field(f, "newThreshold"));
      return { text: `set the threshold to ${t}`, level: t <= 1 ? "L3" : "L2" };
    }
    case "SetTimeLock": {
      const t = Number(field(f, "newTimeLock", "timeLock"));
      return { text: `set the time lock to ${t} s`, level: t === 0 ? "L2" : "L1" };
    }
    case "AddSpendingLimit": {
      const members = field(f, "members");
      return {
        text: `add a spending limit of ${String(field(f, "amount"))} raw units of mint ${String(field(f, "mint"))} for ${Array.isArray(members) ? members.map(String).join(", ") : "unknown members"}`,
        level: "L2"
      };
    }
    case "RemoveSpendingLimit":
      return { text: `remove spending limit ${String(field(f, "spendingLimit"))}`, level: "L1" };
    case "SetRentCollector":
      return { text: `set the rent collector to ${String(field(f, "newRentCollector") ?? "none")}`, level: "L1" };
    default:
      return { text: `${variant} (not recognized)`, level: "L2" };
  }
}

/** Direct changes a config authority signs alone (Watchtower AUTHORITY_CHANGES). */
const DIRECT: Record<string, (ix: Parameters<typeof arg>[0], outside: (k: string) => boolean) => Described> = {
  multisigAddMember: (ix, o) => describeConfigAction({ __kind: "AddMember", newMember: arg(ix, "newMember") }, o),
  multisigRemoveMember: (ix, o) => describeConfigAction({ __kind: "RemoveMember", oldMember: arg(ix, "oldMember") }, o),
  multisigChangeThreshold: (ix, o) => describeConfigAction({ __kind: "ChangeThreshold", newThreshold: arg(ix, "newThreshold") }, o),
  multisigSetTimeLock: (ix, o) => describeConfigAction({ __kind: "SetTimeLock", newTimeLock: arg(ix, "timeLock") }, o),
  multisigAddSpendingLimit: (ix, o) => describeConfigAction({ __kind: "AddSpendingLimit", amount: arg(ix, "amount"), mint: arg(ix, "mint"), members: arg(ix, "members") }, o),
  multisigRemoveSpendingLimit: () => ({ text: "remove a spending limit", level: "L1" }),
  multisigSetRentCollector: (ix, o) => describeConfigAction({ __kind: "SetRentCollector", newRentCollector: arg(ix, "rentCollector") }, o),
  multisigSetConfigAuthority: (ix, o) => {
    const to = String(arg(ix, "configAuthority") ?? "?");
    return { text: `hand the config authority to ${to}${o(to) ? ", a key outside this session" : ""}`, level: o(to) ? "L3" : "L2" };
  }
};

export const squadsConfigChangeRule: Rule = {
  id: RULE_ID,
  ruleIds: [RULE_ID],
  description: "Squads membership, threshold, time lock, spending-limit and config-authority changes (Watchtower multisigChange.ts)",
  run(ctx: RuleContext) {
    const signers = sessionSigners(ctx);
    const outside = (k: string): boolean => !signers.has(k);
    // Config transactions that go through a member vote.
    for (const v of proposalViews(ctx)) {
      if (v.kind !== "config" || !v.configActions) continue;
      const calls = [v.transactionCreate, v.proposalCreate, ...v.approvals, ...v.executes].filter((c): c is NonNullable<typeof c> => !!c);
      const actions = v.configActions.map((a) => describeConfigAction(a, outside));
      const worst = maxLevel(["L1", ...actions.map((a) => a.level)]);
      const verbs = [v.transactionCreate && "proposes", v.approvals.length && "approves", v.executes.length && "executes"].filter(Boolean).join(" and ");
      const nonceClaims = [...new Set(calls.map((c) => c.txIndex))].map((t) => ctx.claims.get(`nonce:${t}`)).filter((c): c is string => !!c);
      ctx.report.addClaim({
        kind: "Fact",
        statement: `This session ${verbs} a config change on multisig ${short(v.multisig)}: ${actions.map((a) => a.text).join("; ") || "no actions"}.`,
        evidenceIds: calls.map((c) => instructionEvidence(ctx, c.txIndex, c.ix)),
        dependsOn: nonceClaims,
        ruleId: RULE_ID,
        // Only proposing, with no vote or execution in the session, stays below L3.
        level: v.approvals.length || v.executes.length || worst !== "L3" ? worst : "L2"
      });
    }
    // Direct changes by a config authority (controlled multisig), no vote.
    for (const c of squadsCalls(ctx)) {
      const describe = DIRECT[c.name];
      if (!describe) continue;
      const d = describe(c.ix, outside);
      ctx.report.addClaim({
        kind: "Fact",
        statement: `Config authority ${short(c.signer)} changes multisig ${short(c.multisig)} directly, without a member vote: ${d.text}.`,
        evidenceIds: [instructionEvidence(ctx, c.txIndex, c.ix)],
        ruleId: RULE_ID,
        level: maxLevel(["L2", d.level])
      });
    }
  }
};
