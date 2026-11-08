// Capability maps for the IDL registry (PLAN.md M3, idls:build step 5). Pure and fs-free, shared by
// scripts/idls-build.ts (writes capabilities/*.json) and the G5 test (rebuilds and compares).
//  - curated: hand-written per program (curated/<name>.json), every name checked against the root;
//  - keyword: every other instruction, classified by core's keyword map, confidence "low".
import type { RootNode } from "@codama/nodes";
import {
  CAPABILITY_CLASSES,
  classifyInstruction,
  describeInstruction,
  COMPUTE_BUDGET_INSTRUCTIONS,
  SIGNATURE_CHECK_INSTRUCTION,
  UPGRADEABLE_LOADER_ACCOUNTS,
  UPGRADEABLE_LOADER_INSTRUCTIONS,
  type CapabilityClass
} from "@kelvara/core";

export interface CuratedEntry {
  instruction: string;
  /** Signer account (instruction account name) that holds the power; null for set-at-creation calls. */
  authority: string | null;
  capability: string;
  class: CapabilityClass;
  changes: string;
}

export interface CuratedAuthorityType {
  variant: string;
  capability: string;
  class: CapabilityClass;
  changes: string;
}

export interface CuratedFile {
  schema: "kelvara.capability-curated/v1";
  program: string;
  programId: string;
  extends?: string;
  reviewed: string;
  instructions: CuratedEntry[];
  authorityTypes?: CuratedAuthorityType[];
}

export interface CapabilityEntry {
  instruction: string;
  discriminator: string | null;
  /** Signer that holds the power (curated), or the instruction's signers (keyword). */
  authority: string | null;
  signers: string[];
  capability: string | null;
  class: CapabilityClass;
  changes: string;
  source: "curated" | "keyword";
  confidence: "curated" | "low";
}

export interface CapabilityMap {
  schema: "kelvara.capability-map/v1";
  program: string;
  programId: string;
  kind: "curated" | "keyword";
  /** Where the instruction names come from (root file or builtin decoder). */
  checkedAgainst: string;
  reviewed: string | null;
  entries: CapabilityEntry[];
  authorityTypes: CuratedAuthorityType[];
}

/** One instruction as the registry sees it: name, accounts (with signer flags) and discriminator. */
export interface InstructionShape {
  name: string;
  accounts: { name: string; signer: boolean }[];
  discriminator: string | null;
}

const hexOfNumber = (n: number, format: string): string | null => {
  const size = { u8: 1, u16: 2, u32: 4, u64: 8 }[format];
  if (!size) return null;
  const out: string[] = [];
  let v = BigInt(n);
  for (let i = 0; i < size; i++) {
    out.push(Number(v & 0xffn).toString(16).padStart(2, "0"));
    v >>= 8n;
  }
  return out.join("");
};

type AnyNode = { kind: string; [k: string]: unknown };

/** Discriminator bytes as hex from a Codama instruction's field discriminators (constant arguments). */
export function codamaDiscriminator(ix: AnyNode): string | null {
  const discs = ((ix.discriminators as AnyNode[] | undefined) ?? []).filter((d) => d.kind === "fieldDiscriminatorNode");
  if (!discs.length) return null;
  const args = (ix.arguments as AnyNode[] | undefined) ?? [];
  const parts: [number, string][] = [];
  for (const d of discs) {
    const arg = args.find((a) => a.name === d.name);
    const dv = arg?.defaultValue as AnyNode | undefined;
    let type = arg?.type as AnyNode | undefined;
    if (type?.kind === "fixedSizeTypeNode") type = type.type as AnyNode;
    let hex: string | null = null;
    if (dv?.kind === "bytesValueNode" && dv.encoding === "base16") hex = String(dv.data).toLowerCase();
    else if (dv?.kind === "numberValueNode" && type?.kind === "numberTypeNode") hex = hexOfNumber(Number(dv.number), String(type.format));
    if (hex === null) return null;
    parts.push([Number(d.offset ?? 0), hex]);
  }
  return parts.sort((a, b) => a[0] - b[0]).map(([, h]) => h).join("");
}

export function rootInstructions(root: RootNode): InstructionShape[] {
  return (root.program.instructions as unknown as AnyNode[]).map((ix) => ({
    name: String(ix.name),
    accounts: ((ix.accounts as AnyNode[]) ?? []).map((a) => ({ name: String(a.name), signer: a.isSigner === true || a.isSigner === "either" })),
    discriminator: codamaDiscriminator(ix)
  }));
}

/** The upgradeable loader has no IDL: names and accounts come from the hand-written decoder (bincode u32 tag). */
export function loaderInstructions(): InstructionShape[] {
  const signers: Record<string, string[]> = {
    write: ["bufferAuthority"],
    deployWithMaxDataLen: ["payer", "authority"],
    upgrade: ["authority"],
    setAuthority: ["currentAuthority"],
    close: ["authority"],
    setAuthorityChecked: ["currentAuthority", "newAuthority"],
    migrate: ["authority"],
    extendProgramChecked: ["authority", "payer"],
    extendProgram: ["payer"]
  };
  return UPGRADEABLE_LOADER_INSTRUCTIONS.map((name, i) => ({
    name,
    accounts: (UPGRADEABLE_LOADER_ACCOUNTS[name] ?? []).map((a) => ({ name: a, signer: signers[name]?.includes(a) ?? false })),
    discriminator: hexOfNumber(i, "u32")
  }));
}

/** Compute Budget has no IDL: names come from the hand-written decoder (borsh u8 tag 1..4); no accounts, no signers. */
export function computeBudgetInstructions(): InstructionShape[] {
  const tags = [1, 2, 3, 4];
  return COMPUTE_BUDGET_INSTRUCTIONS.map((name, i) => ({ name, accounts: [], discriminator: hexOfNumber(tags[i]!, "u8") }));
}

/** Instructions and provenance text of a hand-written decoder program. */
export function builtinShape(decoder: string): { ixs: InstructionShape[]; checkedAgainst: string } | null {
  if (decoder === "loader") return { ixs: loaderInstructions(), checkedAgainst: "packages/core/src/decode/builtin.ts (hand-written decoder)" };
  if (decoder === "computeBudget") return { ixs: computeBudgetInstructions(), checkedAgainst: "packages/core/src/decode/builtin.ts (hand-written decoder)" };
  if (decoder === "sigverify") return { ixs: [{ name: SIGNATURE_CHECK_INSTRUCTION, accounts: [], discriminator: null }], checkedAgainst: "packages/core/src/decode/builtin.ts (hand-written decoder)" };
  return null;
}

/** Codama root enum variant names of a defined type (e.g. Token's authorityType). */
export function enumVariants(root: RootNode, typeName: string): string[] {
  const t = (root.program.definedTypes as unknown as AnyNode[]).find((d) => d.name === typeName);
  const type = t?.type as AnyNode | undefined;
  return type?.kind === "enumTypeNode" ? (type.variants as AnyNode[]).map((v) => String(v.name)) : [];
}

/** Merges a curated file with the one it extends (later entries win by instruction / variant). */
export function resolveCurated(file: CuratedFile, byName: Record<string, CuratedFile>): CuratedFile {
  if (!file.extends) return file;
  const base = resolveCurated(byName[file.extends]!, byName);
  const ix = new Map(base.instructions.map((e) => [e.instruction, e]));
  for (const e of file.instructions) ix.set(e.instruction, e);
  const at = new Map((base.authorityTypes ?? []).map((e) => [e.variant, e]));
  for (const e of file.authorityTypes ?? []) at.set(e.variant, e);
  return { ...file, instructions: [...ix.values()], authorityTypes: [...at.values()] };
}

/** Problems with a curated file against the program's real instructions (empty = valid). */
export function checkCurated(curated: CuratedFile, ixs: InstructionShape[], authorityTypes: string[] | null): string[] {
  const errors: string[] = [];
  const byName = new Map(ixs.map((i) => [i.name, i]));
  const seen = new Set<string>();
  for (const e of curated.instructions) {
    const ix = byName.get(e.instruction);
    if (seen.has(e.instruction)) errors.push(`${curated.program}: ${e.instruction} listed twice`);
    seen.add(e.instruction);
    if (!ix) {
      errors.push(`${curated.program}: curated instruction ${e.instruction} does not exist`);
      continue;
    }
    if (!CAPABILITY_CLASSES.includes(e.class)) errors.push(`${curated.program}.${e.instruction}: unknown class ${e.class}`);
    if (e.authority !== null) {
      const acct = ix.accounts.find((a) => a.name === e.authority);
      if (!acct) errors.push(`${curated.program}.${e.instruction}: authority account ${e.authority} is not an account of the instruction`);
      else if (!acct.signer) errors.push(`${curated.program}.${e.instruction}: authority account ${e.authority} is not a signer`);
    }
    if (!e.capability || !e.changes) errors.push(`${curated.program}.${e.instruction}: capability and changes are required`);
  }
  for (const t of curated.authorityTypes ?? []) {
    if (!authorityTypes) errors.push(`${curated.program}: authorityTypes given but the program has no authorityType enum`);
    else if (!authorityTypes.includes(t.variant)) errors.push(`${curated.program}: authority type ${t.variant} does not exist`);
    if (!CAPABILITY_CLASSES.includes(t.class)) errors.push(`${curated.program}: authority type ${t.variant} has unknown class ${t.class}`);
  }
  return errors;
}

/** Capability map: curated entries where listed, keyword entries (confidence low) for every other instruction. */
export function buildCapabilityMap(opts: { program: string; programId: string; instructions: InstructionShape[]; checkedAgainst: string; curated?: CuratedFile }): CapabilityMap {
  const curated = new Map((opts.curated?.instructions ?? []).map((e) => [e.instruction, e]));
  const entries: CapabilityEntry[] = opts.instructions.map((ix) => {
    const signers = ix.accounts.filter((a) => a.signer).map((a) => a.name);
    const c = curated.get(ix.name);
    if (c) return { instruction: ix.name, discriminator: ix.discriminator, authority: c.authority, signers, capability: c.capability, class: c.class, changes: c.changes, source: "curated", confidence: "curated" };
    const cls = classifyInstruction(ix.name);
    return { instruction: ix.name, discriminator: ix.discriminator, authority: null, signers, capability: null, class: cls, changes: describeInstruction(ix.name, cls), source: "keyword", confidence: "low" };
  });
  return {
    schema: "kelvara.capability-map/v1",
    program: opts.program,
    programId: opts.programId,
    kind: opts.curated ? "curated" : "keyword",
    checkedAgainst: opts.checkedAgainst,
    reviewed: opts.curated?.reviewed ?? null,
    entries,
    authorityTypes: opts.curated?.authorityTypes ?? []
  };
}
