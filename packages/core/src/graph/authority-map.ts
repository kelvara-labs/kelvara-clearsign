// Authority maps (PLAN.md "Capability preview"): for each instruction of a program, which stored
// authority field its signer is tied to, read from the program's Anchor IDL. Pure and fs-free:
// the caller loads the IDL and says whether it is verified (on-chain IDL account whose authority
// equals the upgrade authority, hash pinned in packages/idls/manifest.json).
import type { AnchorIdlAccountItem, AnchorIdlJson } from "../decode/types.js";
import { sha256 } from "../util/sha256.js";
import { CAPABILITY_RISK_V1, type CapabilityClass } from "../report/rubrics.js";

/**
 * How the signer is tied to the authority:
 *  - relation: the IDL says `relations: [account]`, i.e. Anchor has_one: account.<field> == signer.
 *  - address: the IDL fixes the signer's address.
 *  - field_name (legacy IDLs without relations): the instruction also takes an account whose stored
 *    type has a field named like the signer. A naming convention, never more than lower confidence.
 */
export type AuthorityTieKind = "relation" | "address" | "field_name";

export interface AuthorityTie {
  kind: AuthorityTieKind;
  /** Signer account name in the instruction. */
  signer: string;
  /** Account holding the stored authority field (relation / field_name); null for address ties. */
  account: string | null;
  /** Stored field the signer must equal (relation / field_name), or the fixed address. */
  field: string;
  /** Stored account type name, when known (field_name ties). */
  accountType: string | null;
}

export interface AuthorityMapEntry {
  instruction: string;
  /** Anchor 8-byte discriminator as lowercase hex (from the IDL, or derived for legacy IDLs). */
  discriminator: string;
  tie: AuthorityTie;
  /** Plain-words description of what calling it changes (keyword map, labelled as such). */
  changes: string;
  class: CapabilityClass;
  /** True when the tied field is an admin-style authority (not a per-user account owner). */
  admin: boolean;
}

export interface AuthorityMap {
  programId: string;
  name: string;
  /** Where the IDL came from, for evidence (repo path or on-chain IDL account). */
  source: string;
  /** Verified per PLAN.md; anything else is labelled lower confidence. */
  verified: boolean;
  entries: AuthorityMapEntry[];
}

export interface BuildAuthorityMapOptions {
  programId?: string;
  name?: string;
  source: string;
  verified: boolean;
}

const snake = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const words = (s: string): string => snake(s).replace(/_/g, " ");

/**
 * Keyword map (PLAN.md M1 step 5: admin, authority, oracle, withdraw guard, pause, fee, weight, market).
 * First match wins; order puts guards before withdraws and pauses before generic admin words.
 */
const KEYWORDS: [RegExp, CapabilityClass][] = [
  [/guard/, "admin_control"],
  [/withdraw|vault|sweep|super_admin|admin_deposit|deposit_to_program|deposit_into|transfer/, "fund_movement"],
  [/(^|_)mint_to|(^|_)mint$/, "mint_control"],
  [/oracle/, "admin_control"],
  [/pause|freeze|status|halt/, "freeze"],
  [/close|delete|reclaim|purge/, "account_control"],
  [/admin|authority|owner|initialize|(^|_)init_|add_bank|add_market|configure|margin|weight|liquidat|bankrupt|deleverage|curve|repeg|move_amm|(^|_)k$|recenter|settle|override/, "admin_control"],
  [/fee|name|metadata|duration|spread|param|tick|size|period|limit|discount|cache|flag|emode|rate|expiry|tier|offset|scalar|threshold|twap|stats|mapping|correlation|max_|min_|pool_id|number_of/, "config"]
];

export function classifyInstruction(name: string): CapabilityClass {
  const s = snake(name);
  for (const [re, cls] of KEYWORDS) if (re.test(s)) return cls;
  return "other";
}

export function describeInstruction(name: string, cls: CapabilityClass): string {
  return `${words(name)}: ${CAPABILITY_RISK_V1.classes[cls].description} (keyword map)`;
}

const flatAccounts = (items: AnchorIdlAccountItem[]): AnchorIdlAccountItem[] =>
  items.flatMap((a) => (Array.isArray(a.accounts) ? flatAccounts(a.accounts) : [a]));
const isSigner = (a: AnchorIdlAccountItem): boolean => a.signer === true || a.isSigner === true;
const ADMIN = /admin|guardian|governance/i;

/** Stored account types (legacy `accounts` section or new-format `types`) and their field names. */
function storedFields(idl: AnchorIdlJson & { accounts?: { name: string; type?: { fields?: { name: string }[] } }[] }): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (name: string, fields: unknown[] | undefined) => {
    if (!fields) return;
    out.set(name.toLowerCase(), new Set(fields.flatMap((f) => (f && typeof f === "object" && "name" in f ? [snake(String((f as { name: string }).name))] : []))));
  };
  for (const a of idl.accounts ?? []) add(a.name, a.type?.fields);
  const accountNames = new Set((idl.accounts ?? []).map((a) => a.name.toLowerCase()));
  for (const t of idl.types ?? []) if (accountNames.has(t.name.toLowerCase()) && !out.get(t.name.toLowerCase())?.size) add(t.name, t.type.fields);
  return out;
}

/**
 * Builds the authority map from an Anchor IDL (0.1.0 spec with relations, or legacy). Instructions
 * whose signer is not tied to any stored field or fixed address are not entries: they are open to
 * any signer (e.g. a user acting on their own account) and grant nothing.
 */
export function buildAuthorityMap(idl: AnchorIdlJson, opts: BuildAuthorityMapOptions): AuthorityMap {
  const programId = opts.programId ?? idl.address ?? idl.metadata?.address;
  if (!programId) throw new Error("authority map needs a program id");
  const fields = storedFields(idl as Parameters<typeof storedFields>[0]);
  const entries: AuthorityMapEntry[] = [];
  for (const ix of idl.instructions) {
    const accounts = flatAccounts(ix.accounts);
    // Legacy IDLs omit it: Anchor's rule is sha256("global:<snake_case name>")[0..8].
    const disc = ix.discriminator ?? Array.from(sha256(new TextEncoder().encode(`global:${snake(ix.name)}`)).slice(0, 8));
    const discriminator = disc.map((b) => b.toString(16).padStart(2, "0")).join("");
    for (const signer of accounts.filter(isSigner)) {
      const ties: AuthorityTie[] = [];
      const rel = Array.isArray(signer.relations) ? (signer.relations as string[]) : [];
      for (const r of rel) ties.push({ kind: "relation", signer: signer.name, account: r, field: snake(signer.name), accountType: null });
      if (typeof signer.address === "string") ties.push({ kind: "address", signer: signer.name, account: null, field: signer.address, accountType: null });
      if (!ties.length && !rel.length) {
        // Legacy IDL: an account in this instruction whose stored type has a field named like the signer.
        for (const other of accounts) {
          if (other === signer) continue;
          const f = fields.get(other.name.toLowerCase());
          if (f?.has(snake(signer.name))) ties.push({ kind: "field_name", signer: signer.name, account: other.name, field: snake(signer.name), accountType: other.name });
        }
      }
      const tie = ties[0];
      if (!tie) continue;
      const cls = classifyInstruction(ix.name);
      entries.push({ instruction: ix.name, discriminator, tie, changes: describeInstruction(ix.name, cls), class: cls, admin: ADMIN.test(tie.signer) || ADMIN.test(tie.field) });
    }
  }
  return { programId, name: opts.name ?? idl.metadata?.name ?? idl.name ?? programId, source: opts.source, verified: opts.verified, entries };
}
