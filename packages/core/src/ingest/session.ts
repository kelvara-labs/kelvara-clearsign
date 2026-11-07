// Group one or several transactions into a session with stable indices and resolve
// every address lookup table through the injected AccountReader in one batched read.
import type { Address } from "@solana/kit";
import { createCachingAccountReader, type AccountReader } from "../state/account-reader.js";
import { sha256Base58 } from "../util/encoding.js";
import { IngestError } from "./errors.js";
import { ADDRESS_LOOKUP_TABLE_PROGRAM, U64_MAX, parseLookupTableData } from "./lookup-table.js";
import { parseTransaction } from "./parse.js";
import type {
  IngestInput,
  LookupProblem,
  LookupTableInfo,
  ParsedTransaction,
  ResolvedAccount,
  Session,
  SessionTransaction
} from "./types.js";

export interface IngestOptions {
  /** Reader for lookup table accounts. Omit only when no input uses a lookup table. */
  reader?: AccountReader;
}

type TableRead = { info: LookupTableInfo } | { problem: LookupProblem };

async function readTables(addresses: Address[], reader: AccountReader | undefined): Promise<Map<string, TableRead>> {
  const out = new Map<string, TableRead>();
  if (addresses.length === 0) return out;
  if (!reader) throw new IngestError("READER_FAILED", "a transaction uses lookup tables but no account reader was given");
  let accounts;
  try {
    accounts = await createCachingAccountReader(reader).getMultipleAccounts(addresses);
  } catch (e) {
    throw new IngestError("READER_FAILED", `lookup table read failed: ${(e as Error)?.message ?? String(e)}`);
  }
  addresses.forEach((table, i) => {
    const acc = accounts[i];
    if (!acc) return void out.set(table, { problem: { kind: "table_missing", table } });
    if (acc.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM) {
      return void out.set(table, { problem: { kind: "not_a_lookup_table", table, owner: acc.owner } });
    }
    const info = parseLookupTableData(table, acc.data);
    out.set(table, info ? { info } : { problem: { kind: "malformed_table", table } });
  });
  return out;
}

function resolveAccounts(tx: ParsedTransaction, tables: Map<string, TableRead>): { accounts: ResolvedAccount[]; problems: LookupProblem[] } {
  const { header, staticAccounts } = tx;
  const accounts: ResolvedAccount[] = staticAccounts.map((address, i) => {
    const signer = i < header.numSignerAccounts;
    const writable = signer
      ? i < header.numSignerAccounts - header.numReadonlySignerAccounts
      : i < staticAccounts.length - header.numReadonlyNonSignerAccounts;
    return { index: i, address, signer, writable, source: { kind: "static" } };
  });
  const problems: LookupProblem[] = [];
  const seenProblem = new Set<string>();
  const note = (p: LookupProblem) => {
    const key = JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    if (!seenProblem.has(key)) { seenProblem.add(key); problems.push(p); }
  };
  // Runtime order: all writable loaded addresses (lookup by lookup), then all readonly ones.
  for (const writable of [true, false]) {
    for (const l of tx.addressTableLookups) {
      const t = tables.get(l.lookupTableAddress);
      if (t && "info" in t && t.info.deactivationSlot !== U64_MAX) {
        note({ kind: "table_deactivated", table: l.lookupTableAddress, deactivationSlot: t.info.deactivationSlot });
      }
      for (const tableIndex of writable ? l.writableIndexes : l.readonlyIndexes) {
        let address: Address | null = null;
        if (!t) note({ kind: "table_missing", table: l.lookupTableAddress });
        else if ("problem" in t) note(t.problem);
        else if (tableIndex >= t.info.addresses.length) {
          note({ kind: "index_out_of_range", table: l.lookupTableAddress, tableIndex, tableSize: t.info.addresses.length });
        } else address = t.info.addresses[tableIndex] ?? null;
        accounts.push({
          index: accounts.length,
          address,
          signer: false,
          writable,
          source: { kind: "lookup", table: l.lookupTableAddress, tableIndex }
        });
      }
    }
  }
  return { accounts, problems };
}

/** Parse, group and resolve one or several transactions into a session. */
export async function ingestSession(
  inputs: readonly (IngestInput | Uint8Array | string)[],
  options: IngestOptions = {}
): Promise<Session> {
  if (inputs.length === 0) throw new IngestError("EMPTY_INPUT", "a session needs at least one transaction");
  const parsed = inputs.map((input, i) => {
    try {
      return parseTransaction(input);
    } catch (e) {
      if (e instanceof IngestError) throw new IngestError(e.code, `transaction ${i}: ${e.message}`, i);
      throw e;
    }
  });

  const tableAddresses = [...new Set(parsed.flatMap((p) => p.addressTableLookups.map((l) => l.lookupTableAddress)))];
  const tables = await readTables(tableAddresses, options.reader);

  const transactions: SessionTransaction[] = parsed.map((p, index) => {
    const { accounts, problems } = resolveAccounts(p, tables);
    const instructions = p.instructions.map((ix, i) => ({
      index: i,
      programIdIndex: ix.programIdIndex,
      programAddress: p.staticAccounts[ix.programIdIndex] as Address,
      accounts: ix.accountIndices.map((a) => accounts[a] as ResolvedAccount),
      data: ix.data
    }));
    const { instructions: compiledInstructions, ...rest } = p;
    const input = inputs[index];
    const label = typeof input === "object" && !(input instanceof Uint8Array) ? input?.label : undefined;
    const tx: SessionTransaction = {
      ...rest,
      index,
      compiledInstructions,
      accounts,
      instructions,
      lookupProblems: problems,
      complete: accounts.every((a) => a.address !== null)
    };
    if (label !== undefined) tx.label = label;
    return tx;
  });

  const lookupTables: Record<string, LookupTableInfo> = {};
  for (const [addr, t] of tables) if ("info" in t) lookupTables[addr] = t.info;

  const hashes = new TextEncoder().encode(transactions.map((t) => t.messageHash).join("\n"));
  return {
    id: sha256Base58(hashes),
    transactions,
    lookupTables,
    complete: transactions.every((t) => t.complete)
  };
}
