// Key risks (X28): one short headline and one plain sentence per alert claim, at most three, so the most important
// finding leads page 2 and the title. Presentation only: levels, claims and controls are the engine's. Pure.
import type { Capability, Claim, Report } from "@kelvara/core";

export interface KeyRisk { id: string; headline: string; text: string }

const PREFIX = /^(Proven from the transaction and on-chain reads|Derived from the decoded instructions|Possible, under the stated assumptions|Not determined):\s*/;
/** The engine's evidence-kind prefix is dropped from visible text; the kind stays a badge on finding cards. */
export const stripEvidencePrefix = (s: string): string => s.replace(PREFIX, "");

const firstSentence = (s: string, max = 220): string => {
  const one = stripEvidencePrefix(s).split(/(?<=[.!?])\s+(?=[A-Z“"])/)[0] ?? s;
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const CAP: Record<string, string> = {
  "program.upgrade": "program upgrade", "program.buffer": "program buffer", "token.mintTokens": "minting", "token.freezeAccount": "freezing", "token.freeze": "freezing",
  "token.permanent_delegate": "permanent delegate", "token.accountOwner": "token account ownership", "token.closeAccount": "account closing", "token.closeMint": "mint closing",
  "token.authority": "token authority", "token.delegate": "spending", "protocol.admin": "admin", "squads.members": "multisig membership", "squads.threshold": "multisig threshold",
  "squads.timeLock": "multisig time lock", "squads.configAuthority": "multisig configuration", "account.owner": "account ownership"
};
const capPhrase = (c: string): string => CAP[c] ?? (c.split(".").pop() ?? c).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();

/** At most three key risks from the engine's alert claims, in the alert's order; `more` counts the rest. */
export function keyRisks(r: Report): { risks: KeyRisk[]; more: number } {
  const byId = new Map<string, Claim>(r.claims.map((c) => [c.id, c]));
  const granted = new Map<string, Capability>(r.capabilities.granted.map((c) => [c.claimId, c]));
  const ids = r.alert.claimIds.filter((id) => byId.has(id));
  const risks = ids.slice(0, 3).map((id): KeyRisk => {
    const c = byId.get(id)!;
    const cap = granted.get(id);
    switch (c.ruleId) {
      case "authority.transfer": {
        const phrase = cap ? capPhrase(cap.capability) : "control";
        const lost = cap ? r.capabilities.revoked.some((x) => x.capability === cap.capability && x.target === cap.target) : false;
        return { id, headline: `Hands ${phrase} control to another key`, text: cap?.holder ? `${cap.holder} would get ${phrase} control${cap.target ? ` over ${cap.target}` : ""}.${lost ? " The current holder loses it." : ""}` : firstSentence(c.statement) };
      }
      case "lifetime.durable_nonce":
        return { id, headline: "Never expires, so it can be submitted later", text: "This transaction never expires, so whoever holds it can submit it at any later time." };
      case "nonce.staged_by_outsider":
        return { id, headline: "Set up by an outside account", text: "The never-expiring slot was set up by an account outside your wallet." };
      case "token2022.permanent_delegate":
        return { id, headline: "Token has a permanent delegate", text: cap?.holder ? `${cap.holder} could move or burn your balance of this token at any time.` : firstSentence(c.statement) };
      case "token.freeze_authority":
        return { id, headline: "Token can be frozen", text: cap?.holder ? `${cap.holder} could freeze your balance of this token.` : firstSentence(c.statement) };
      case "wallet.sweep":
        return { id, headline: "Empties your wallet", text: firstSentence(c.statement) };
      default:
        return { id, headline: c.ruleId ? firstSentence(c.statement, 70).replace(/[.:]$/, "") : firstSentence(c.statement, 70), text: firstSentence(c.statement) };
    }
  });
  return { risks, more: Math.max(0, ids.length - risks.length) };
}
