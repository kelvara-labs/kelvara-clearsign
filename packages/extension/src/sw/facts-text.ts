// Plain-language text for the engine's L0 benign facts (E23: fact.memo, fact.sol_transfer, fact.token_transfer,
// fact.priority_fee, fact.network_fee, fact.no_permission_change). Built from the facts' structured instruction and
// derivation evidence, not from the engine sentences, which carry lamport counts and formulas. Pure.
import type { Evidence, Report } from "@kelvara/core";

const MEMO_MAX = 200;
const record = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

/** Lamports (string, number or bigint) as SOL text without trailing zeros: 16972958 -> "0.016972958 SOL". */
export function solText(lamports: unknown): string | null {
  let n: bigint;
  try {
    n = BigInt(lamports as string | number | bigint);
  } catch {
    return null;
  }
  if (n < 0n) return null;
  const whole = n / 1_000_000_000n;
  const frac = (n % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} SOL`;
}

/** Token amount in base units to decimal text. */
function tokenAmount(amount: unknown, decimals: unknown): string | null {
  try {
    const a = BigInt(amount as string);
    const d = Number(decimals);
    if (!Number.isInteger(d) || d < 0 || d > 36) return null;
    if (d === 0) return a.toString();
    const s = a.toString().padStart(d + 1, "0");
    const frac = s.slice(-d).replace(/0+$/, "");
    return `${s.slice(0, -d)}${frac ? `.${frac}` : ""}`;
  } catch {
    return null;
  }
}

function memoQuote(memo: string): string {
  const flat = [...memo.replace(/[\p{C}\u2028\u2029]/gu, " ")];
  return `“${flat.slice(0, MEMO_MAX).join("")}${flat.length > MEMO_MAX ? "…" : ""}”`;
}

export interface FactLine {
  rule: string;
  tx: number | null;
  /** Sentence fragment starting with a capital letter, no final period. */
  text: string;
  /** Lower-case verb phrase for the one-sentence summary ("signs a memo"). */
  brief: string | null;
}

/** Facts in report order, each as a plain-language line. A fact whose evidence is unreadable falls back to the engine sentence. */
export function factLines(r: Report): FactLine[] {
  const ev = new Map<string, Evidence>(r.evidence.map((e) => [e.id, e]));
  const out: FactLine[] = [];
  for (const c of r.claims) {
    if (!c.ruleId?.startsWith("fact.") || c.ruleId === "fact.no_permission_change") continue;
    const items = c.evidenceIds.map((id) => ev.get(id)).filter((e): e is Evidence => !!e);
    const tx = items[0]?.transactionIndex ?? null;
    const ixData = record(items.find((e) => e.type === "instruction")?.data);
    const args = record(ixData.args);
    const accounts = new Map<string, string>();
    if (Array.isArray(ixData.accounts)) for (const a of ixData.accounts) accounts.set(String(record(a).name), String(record(a).address));
    const derived = record(items.find((e) => e.type === "derivation")?.data);
    let line: FactLine | null = null;
    switch (c.ruleId) {
      case "fact.memo":
        if (typeof args.memo === "string") line = { rule: c.ruleId, tx, text: `Signs a memo: ${memoQuote(args.memo)}`, brief: "signs a memo" };
        break;
      case "fact.sol_transfer": {
        const amount = solText(args.amount), to = accounts.get("destination");
        if (amount && to) line = { rule: c.ruleId, tx, text: `Sends ${amount} to ${to}`, brief: `sends ${amount}` };
        break;
      }
      case "fact.token_transfer": {
        // Amount, mint and recipient owner come from the engine's own statement when the engine read them.
        const m = /sends (.+?)(?: of token mint (\S+))? from token account \S+ to (?:(\S+) \(owner of token account (\S+)\)|token account (\S+) \(its owner was not read\))/.exec(c.statement);
        const dest = accounts.get("destination");
        const amount = tokenAmount(args.amount, args.decimals) ?? m?.[1] ?? null;
        const to = m?.[3] ?? (m?.[5] ? `token account ${m[5]}` : dest ? `token account ${dest}` : null);
        if (amount && to) line = { rule: c.ruleId, tx, text: `Sends ${amount}${m?.[2] ? ` of token ${m[2]}` : ""} to ${to}`, brief: "sends tokens" };
        break;
      }
      case "fact.swap": {
        const m = /swaps (up to .+?) for ((?:at least|exactly) .+?) via (\S+) \(.*slippage tolerance (\d+) bps\)/.exec(c.statement);
        if (m) line = { rule: c.ruleId, tx, text: `Swaps ${m[1]} for ${m[2]} via ${m[3]} (slippage up to ${Number(m[4]) / 100}%)`, brief: `swaps ${m[1]!.replace(/^up to /, "")} for ${m[2]!.replace(/^(at least|exactly) /, "")}` };
        break;
      }
      case "fact.priority_fee": {
        const max = derived.maxPriorityFeeLamports;
        if (max === null) line = { rule: c.ruleId, tx, text: "Sets a compute unit price without a limit, so the priority fee depends on the limit the network applies", brief: null };
        else if (String(max) === "0") line = { rule: c.ruleId, tx, text: "Sets compute limits and no priority fee", brief: null };
        else if (solText(max)) line = { rule: c.ruleId, tx, text: `Sets a priority fee of up to ${solText(max)}`, brief: `sets a priority fee of up to ${solText(max)}` };
        else if (items.length) line = { rule: c.ruleId, tx, text: "Sets compute budget limits", brief: null };
        break;
      }
      case "fact.network_fee": {
        const fee = solText(derived.baseFeeLamports ?? derived.getFeeForMessageLamports);
        if (fee) line = { rule: c.ruleId, tx, text: `Pays a network fee of ${fee}`, brief: null };
        break;
      }
    }
    out.push(line ?? { rule: c.ruleId, tx, text: c.statement.replace(/^Transaction \d+ /, "").replace(/^./, (ch) => ch.toUpperCase()).replace(/\.$/, ""), brief: null });
  }
  return out;
}

export const NO_PERMISSION_TEXT = "No authority, delegate, owner or upgrade permission changes.";
export const hasNoPermissionChange = (r: Report): boolean => r.claims.some((c) => c.ruleId === "fact.no_permission_change");

/** "Signs a memo: “hi”. Sends 0.5 SOL to X. ..." Multi-transaction sessions label each line "Transaction N: ". */
const FEE_RULES = new Set(["fact.priority_fee", "fact.network_fee"]);

/** "Fees: 0.000005 SOL network + up to 0.000004251 SOL priority." One line for all fee facts. */
function feeLine(lines: FactLine[]): string | null {
  const net = lines.find((f) => f.rule === "fact.network_fee")?.text.match(/([\d.]+ SOL)$/)?.[1];
  const prio = lines.find((f) => f.rule === "fact.priority_fee")?.text.match(/up to ([\d.]+ SOL)$/)?.[1];
  if (!net && !prio) return null;
  return `Fees: ${[net ? `${net} network` : null, prio ? `up to ${prio} priority` : null].filter(Boolean).join(" + ")}.`;
}

/** What the transaction does first, then permissions, then one fee line. Unreadable instructions are described by the caller. */
export function authorizeFacts(r: Report): string[] {
  const multi = r.session.transactions.length > 1;
  const all = factLines(r);
  const lines = all.filter((f) => f.rule !== "fact.unknown_instruction" && !FEE_RULES.has(f.rule)).map((f) => `${multi && f.tx !== null ? `Transaction ${f.tx}: ` : ""}${f.text}.`);
  if (hasNoPermissionChange(r)) lines.push(NO_PERMISSION_TEXT);
  const fees = feeLine(all);
  if (fees) lines.push(fees);
  return lines;
}

/** One human sentence from the facts, or null when there are none. */
export function factSummary(r: Report): string | null {
  const all = factLines(r);
  const actions = all.filter((f) => !FEE_RULES.has(f.rule) && f.rule !== "fact.unknown_instruction");
  // Fees are a footnote: they lead the sentence only when the transaction does nothing else ClearSign can name.
  const source = actions.some((f) => f.brief) || all.some((f) => f.rule === "fact.unknown_instruction") ? actions : all;
  const briefs = [...new Set(source.map((f) => f.brief).filter((b): b is string => !!b))];
  if (!briefs.length) return null;
  const list = briefs.length === 1 ? briefs[0]! : `${briefs.slice(0, -1).join(", ")} and ${briefs.at(-1)}`;
  const body = `This ${r.session.transactions.length > 1 ? "request" : "transaction"} ${list}.`;
  return hasNoPermissionChange(r) ? `${body} ${NO_PERMISSION_TEXT}` : body;
}

/**
 * The engine's simulation text for the UI: "Simulation shows: " prefix dropped, the single-transaction label
 * dropped, a proper minus sign for negative amounts. Anything else stays as the engine wrote it.
 */
export function humanSimulation(summary: string, transactions: number): string {
  let s = summary.replace(/^Simulation shows:\s*/, "");
  if (transactions === 1) s = s.replace(/^Transaction 0(?= \(|:)/, "").trim().replace(/^:\s*/, "").replace(/^\((simulated[^)]*)\):\s*/, "($1) ");
  return s.replace(/(^|[\s(])-(?=\d)/g, "$1−").replace(/^./, (ch) => ch.toUpperCase());
}
