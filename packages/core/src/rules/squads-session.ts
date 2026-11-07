// Squads v4 activity in a session: which proposals are created, voted on and executed, linked to
// their vault or config transaction. Port of the linking logic in Helius Watchtower
// (src/detectors/multisigProposal.ts, upgradeProposal.ts: proposalFor, sameTransactionProposal),
// MIT, rewritten to read our decoded session and RuleState instead of confirmed Parsed Events.
import { decodeSquadsMessage, SQUADS_V4_PROGRAM, type SquadsMessage } from "../decode/squads.js";
import type { DecodedInstruction } from "../decode/types.js";
import type { ResolvedInstruction } from "../ingest/types.js";
import { accountNamed, instructionEvidence } from "./common.js";
import type { RuleContext } from "./types.js";

export interface SquadsCall {
  txIndex: number;
  ix: DecodedInstruction;
  name: string;
  multisig: string | null;
  /** The member, creator or config authority that signs the call. */
  signer: string | null;
}

export interface ProposalView {
  multisig: string;
  proposal: string | null;
  /** Vault, config or batch transaction account. */
  transaction: string | null;
  kind: "vault" | "config" | "batch" | "unknown";
  proposalCreate: SquadsCall | null;
  transactionCreate: SquadsCall | null;
  approvals: SquadsCall[];
  executes: SquadsCall[];
  /** Vault message from an in-session create or a VaultTransaction account; null when unknown. */
  message: SquadsMessage | null;
  /** Where the content came from. */
  contentSource: "session" | "state" | null;
  /** Why the content could not be read, when it could not. */
  contentProblem: string | null;
  /** Config actions from an in-session configTransactionCreate. */
  configActions: unknown[] | null;
}

export interface MultisigView {
  address: string;
  threshold: number;
  timeLock: number;
  members: { key: string; mask: number }[];
  configAuthority: string | null;
  /** "state": read from chain; "session": created by a multisigCreate call in this session. */
  source: "state" | "session";
  created: SquadsCall | null;
}

const DEFAULT_PUBKEY = "11111111111111111111111111111111";
const APPROVE = "proposalApprove";
const EXECUTES: Record<string, ProposalView["kind"]> = {
  vaultTransactionExecute: "vault",
  configTransactionExecute: "config",
  batchExecuteTransaction: "batch"
};
const TX_CREATES: Record<string, ProposalView["kind"]> = {
  vaultTransactionCreate: "vault",
  configTransactionCreate: "config",
  batchCreate: "batch"
};

/** Argument by name; Codama flattens single-struct args, the fallback keeps them under `args`. Accepts snake_case. */
export function arg(ix: DecodedInstruction, name: string): unknown {
  const snake = name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const a = ix.args ?? {};
  const nested = (a.args ?? {}) as Record<string, unknown>;
  return a[name] ?? a[snake] ?? nested[name] ?? nested[snake];
}

export function squadsCalls(ctx: RuleContext): SquadsCall[] {
  const out: SquadsCall[] = [];
  ctx.decoded.forEach((ixs, txIndex) => {
    for (const ix of ixs) {
      if (ix.programAddress !== SQUADS_V4_PROGRAM || ix.status !== "named" || !ix.name) continue;
      const signer =
        accountNamed(ix, "member") ?? accountNamed(ix, "creator") ?? accountNamed(ix, "configAuthority") ?? ix.accounts.find((a) => a.signer)?.address ?? null;
      out.push({ txIndex, ix, name: ix.name, multisig: accountNamed(ix, "multisig"), signer });
    }
  });
  return out;
}

export function multisigView(ctx: RuleContext, address: string | null): MultisigView | null {
  if (!address) return null;
  const acc = ctx.state.squads?.[address];
  if (!acc || acc.name !== "Multisig") return createdInSession(ctx, address);
  const d = acc.data;
  const members = ((d.members as { key: string; permissions?: { mask?: number } }[] | undefined) ?? []).map((m) => ({ key: String(m.key), mask: Number(m.permissions?.mask ?? 0) }));
  const ca = d.configAuthority === undefined || d.configAuthority === null ? null : String(d.configAuthority);
  return { address, threshold: Number(d.threshold), timeLock: Number(d.timeLock), members, configAuthority: ca === DEFAULT_PUBKEY ? null : ca, source: "state", created: null };
}

/** A multisig created earlier in this session: its parameters come from the multisigCreate(V2) bytes. */
function createdInSession(ctx: RuleContext, address: string): MultisigView | null {
  for (const c of squadsCalls(ctx)) {
    if ((c.name !== "multisigCreateV2" && c.name !== "multisigCreate") || c.multisig !== address) continue;
    const members = ((arg(c.ix, "members") as { key: string; permissions?: { mask?: number } }[] | undefined) ?? []).map((m) => ({ key: String(m.key), mask: Number(m.permissions?.mask ?? 0) }));
    const ca = arg(c.ix, "configAuthority");
    return { address, threshold: Number(arg(c.ix, "threshold")), timeLock: Number(arg(c.ix, "timeLock")), members, configAuthority: ca ? String(ca) : null, source: "session", created: c };
  }
  return null;
}

/** Proposal account state, when read. */
export function proposalState(ctx: RuleContext, address: string | null): { status: string; approved: string[]; transactionIndex: bigint | null; multisig: string | null } | null {
  const acc = address ? ctx.state.squads?.[address] : undefined;
  if (!acc || acc.name !== "Proposal") return null;
  const d = acc.data;
  const ti = d.transactionIndex;
  return {
    status: String((d.status as { __kind?: string } | undefined)?.__kind ?? "unknown"),
    approved: ((d.approved as unknown[] | undefined) ?? []).map(String),
    transactionIndex: typeof ti === "bigint" ? ti : ti === undefined ? null : BigInt(ti as number),
    multisig: d.multisig ? String(d.multisig) : null
  };
}

function bigintOf(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  return null;
}

/** Every proposal the session touches, linked to its transaction and content where possible. */
export function proposalViews(ctx: RuleContext, calls = squadsCalls(ctx)): ProposalView[] {
  const views: ProposalView[] = [];
  const byProposal = new Map<string, ProposalView>();
  const byTransaction = new Map<string, ProposalView>();
  const view = (multisig: string, proposal: string | null, transaction: string | null): ProposalView => {
    let v = (proposal && byProposal.get(proposal)) || (transaction && byTransaction.get(transaction)) || undefined;
    if (!v) {
      v = { multisig, proposal: null, transaction: null, kind: "unknown", proposalCreate: null, transactionCreate: null, approvals: [], executes: [], message: null, contentSource: null, contentProblem: null, configActions: null };
      views.push(v);
    }
    if (proposal && !v.proposal) {
      v.proposal = proposal;
      byProposal.set(proposal, v);
    }
    if (transaction && !v.transaction) {
      v.transaction = transaction;
      byTransaction.set(transaction, v);
    }
    return v;
  };

  // Pass 1: executes name both the proposal and its transaction, so they link the two for sure.
  for (const c of calls) {
    const kind = EXECUTES[c.name];
    if (!kind || !c.multisig) continue;
    const v = view(c.multisig, accountNamed(c.ix, "proposal"), accountNamed(c.ix, "transaction") ?? accountNamed(c.ix, "batch"));
    v.kind = kind;
    v.executes.push(c);
  }
  // Pass 2: creates. A transaction create and a proposal create on the same multisig in the same
  // transaction belong together (Watchtower's sameTransactionProposal).
  for (const c of calls) {
    if (!c.multisig) continue;
    const kind = TX_CREATES[c.name];
    if (kind) {
      const tx = accountNamed(c.ix, "transaction") ?? accountNamed(c.ix, "batch");
      const sibling = calls.find((p) => p.name === "proposalCreate" && p.txIndex === c.txIndex && p.multisig === c.multisig);
      const v = view(c.multisig, sibling ? accountNamed(sibling.ix, "proposal") : null, tx);
      v.kind = kind;
      v.transactionCreate = c;
      if (sibling) v.proposalCreate = sibling;
    } else if (c.name === "proposalCreate") {
      const v = view(c.multisig, accountNamed(c.ix, "proposal"), null);
      v.proposalCreate = c;
    }
  }
  // Pass 3: approvals.
  for (const c of calls) {
    if (c.name !== APPROVE || !c.multisig) continue;
    view(c.multisig, accountNamed(c.ix, "proposal"), null).approvals.push(c);
  }
  // Pass 4: state links a proposal with no in-session transaction to a VaultTransaction account
  // with the same multisig and index.
  for (const v of views) {
    if (v.transaction || !v.proposal) continue;
    const p = proposalState(ctx, v.proposal);
    const index = p?.transactionIndex ?? bigintOf(v.proposalCreate ? arg(v.proposalCreate.ix, "transactionIndex") : undefined);
    if (index === null || index === undefined) continue;
    for (const [address, acc] of Object.entries(ctx.state.squads ?? {})) {
      if (acc.name !== "VaultTransaction" || String(acc.data.multisig) !== v.multisig || bigintOf(acc.data.index) !== index) continue;
      v.transaction = address;
      v.kind = "vault";
    }
  }
  for (const v of views) fillContent(ctx, v);
  return views;
}

function fillContent(ctx: RuleContext, v: ProposalView): void {
  const create = v.transactionCreate;
  if (create?.name === "vaultTransactionCreate") {
    const bytes = arg(create.ix, "transactionMessage");
    if (bytes instanceof Uint8Array) {
      try {
        v.message = decodeSquadsMessage(bytes);
        v.contentSource = "session";
      } catch (e) {
        v.contentProblem = `the proposed message does not decode: ${(e as Error).message}`;
      }
    } else v.contentProblem = "the proposed message bytes are missing";
    return;
  }
  if (create?.name === "configTransactionCreate") {
    const actions = arg(create.ix, "actions");
    if (Array.isArray(actions)) {
      v.configActions = actions;
      v.contentSource = "session";
    } else v.contentProblem = "the config actions did not decode";
    return;
  }
  const acc = v.transaction ? ctx.state.squads?.[v.transaction] : undefined;
  if (acc?.name === "VaultTransaction" && acc.data.message) {
    v.message = acc.data.message as SquadsMessage;
    v.contentSource = "state";
    return;
  }
  if (v.kind === "batch") v.contentProblem = "batch transactions are not decoded yet";
  else if (v.transaction) v.contentProblem = `transaction account ${v.transaction} was not read`;
  else v.contentProblem = "no transaction account for this proposal is in the session or in the state read";
}

/** Instructions inside a vault message, resolved against its static keys; lookup-table keys stay null. */
export function vaultInstructions(message: SquadsMessage): ResolvedInstruction[] {
  const keys = message.accountKeys;
  const n = keys.length;
  return message.instructions.map((ix, index) => ({
    index,
    programIdIndex: ix.programIdIndex,
    programAddress: (keys[ix.programIdIndex] ?? "") as ResolvedInstruction["programAddress"],
    data: ix.data,
    accounts: [...ix.accountIndexes].map((i) => ({
      index: i,
      address: (i < n ? keys[i]! : null) as ResolvedInstruction["accounts"][number]["address"],
      signer: i < message.numSigners,
      writable: i < message.numWritableSigners || (i >= message.numSigners && i < message.numSigners + message.numWritableNonSigners),
      source: { kind: "static" as const }
    }))
  }));
}

/** Distinct approving members across the session. */
export const approvers = (v: ProposalView): string[] => [...new Set(v.approvals.map((a) => a.signer).filter((s): s is string => !!s))];

/** Evidence for a Multisig account read from chain. */
export function multisigEvidence(ctx: RuleContext, ms: MultisigView): string {
  if (ms.created) return instructionEvidence(ctx, ms.created.txIndex, ms.created.ix);
  return ctx.report.addEvidence({
    type: "account",
    source: "rpc",
    summary: `Squads multisig ${ms.address}: threshold ${ms.threshold} of ${ms.members.length}, time lock ${ms.timeLock} s`,
    address: ms.address,
    data: { threshold: ms.threshold, timeLock: ms.timeLock, members: ms.members, configAuthority: ms.configAuthority }
  });
}

/** Evidence for a Proposal account read from chain. */
export function proposalEvidence(ctx: RuleContext, address: string): string | null {
  const p = proposalState(ctx, address);
  if (!p) return null;
  return ctx.report.addEvidence({
    type: "account",
    source: "rpc",
    summary: `Squads proposal ${address}: ${p.status}, ${p.approved.length} approval(s)`,
    address,
    data: { status: p.status, approved: p.approved, transactionIndex: p.transactionIndex, multisig: p.multisig }
  });
}
