// Rubrics that are part of the report contract. Changing a value here changes reports:
// bump the rubric id and announce it to @all.

export const ALERT_LEVELS = ["L0", "L1", "L2", "L3", "L4"] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];

export const CLAIM_KINDS = ["Fact", "Derived", "Conditional", "Unknown"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** alert-levels-v1 (PLAN.md, Graded alerts). */
export const ALERT_LEVELS_V1 = {
  id: "alert-levels-v1",
  levels: {
    L0: { label: "Clear", action: "pass" },
    L1: { label: "Notice", action: "pass_with_notice" },
    L2: { label: "Warning", action: "hold" },
    L3: { label: "Critical", action: "hold_block_default" },
    L4: { label: "Blocked", action: "reject" }
  },
  /**
   * Only Fact claims from these rules may reach L4. The same rule behind a durable nonce
   * keeps its ruleId (the nonce is a separate claim it depends on).
   */
  l4Rules: ["system.assign_takeover", "token.owner_takeover", "wallet.sweep", "address.poisoning"]
} as const;

export type AlertAction = (typeof ALERT_LEVELS_V1.levels)[AlertLevel]["action"];

export const levelValue = (level: AlertLevel): number => ALERT_LEVELS.indexOf(level);

export function maxLevel(levels: Iterable<AlertLevel>): AlertLevel {
  let best: AlertLevel = "L0";
  for (const l of levels) if (levelValue(l) > levelValue(best)) best = l;
  return best;
}

/** True when a claim of this kind and ruleId may carry this level under alert-levels-v1. */
export function levelAllowed(kind: ClaimKind, ruleId: string | null, level: AlertLevel): boolean {
  if (level !== "L4") return true;
  return kind === "Fact" && ruleId !== null && (ALERT_LEVELS_V1.l4Rules as readonly string[]).includes(ruleId);
}

/**
 * capability-risk-v1. Granted powers rank by damage (what the holder can do to others);
 * revoked powers rank by defensive loss (what the user can no longer stop or undo).
 * Both use the same classes and scores; ranks are 1..n by score desc, then capability, target, id.
 */
export const CAPABILITY_RISK_V1 = {
  id: "capability-risk-v1",
  classes: {
    code_control: { score: 100, description: "can replace program code (upgrade authority)" },
    admin_control: { score: 90, description: "can change protocol, multisig or program configuration as its admin" },
    fund_movement: { score: 80, description: "can move or burn balances it does not own (owner, permanent delegate, unlimited delegate)" },
    mint_control: { score: 70, description: "can mint new supply" },
    account_control: { score: 60, description: "can close, reassign or take over accounts" },
    freeze: { score: 50, description: "can freeze or thaw balances" },
    bounded_spend: { score: 40, description: "can spend a bounded amount (delegate with a limit)" },
    config: { score: 30, description: "can change non-custodial settings (fees, metadata)" },
    other: { score: 10, description: "any other power" }
  }
} as const;

export type CapabilityClass = keyof typeof CAPABILITY_RISK_V1.classes;
export const CAPABILITY_CLASSES = Object.keys(CAPABILITY_RISK_V1.classes) as [CapabilityClass, ...CapabilityClass[]];
export const capabilityScore = (c: CapabilityClass): number => CAPABILITY_RISK_V1.classes[c].score;
