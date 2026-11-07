// Records real mainnet transactions for G5's "each P0 IDL decodes at least 3 real fixtures" where
// fixtures/tx (scenarios-owned) has fewer than 3 for a program's IDL. Today that is Drift: its 5
// mainnet fixtures all use the non-Anchor `ff ff ff ff` path, so only the replay txs decode by IDL.
// Usage: pnpm --filter @kelvara/idls fixtures:registry [--before <signature>]
// Helius mainnet only: getSignaturesForAddress(program) then getTransaction (base64). Keeps successful
// txs in which the program's Codama root names at least one instruction (top-level or inner), preferring
// distinct instruction names, up to 5. Same shape as fixtures/tx (kelvara.fixture.tx/v1); the output is
// scanned for the key before writing.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RootNode } from "@codama/nodes";
import { getBase58Encoder, type Address } from "@solana/kit";
import { createDecoder, parseTransaction, type AnchorIdlJson, type ResolvedInstruction } from "@kelvara/core";
import { heliusCall, heliusMainnetUrl } from "../src/chain.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const json = <T>(p: string): T => JSON.parse(readFileSync(path.join(pkgDir, p), "utf8")) as T;
const manifest = json<{ idls: { name: string; programId: string; format: string }[] }>("manifest.json");
const decoder = createDecoder(manifest.idls.map((e) => ({ name: e.name, programId: e.programId, root: json<RootNode>(`roots/${e.name}.json`), ...(e.format.startsWith("anchor") ? { idl: json<AnchorIdlJson>(`raw/${e.name}.json`) } : {}) })));
const url = heliusMainnetUrl(pkgDir);
const TARGETS = ["drift-v2"];
const WANT = 5;
const MAX_FETCH = 400;
const argv = process.argv.slice(2);
const BEFORE = argv[argv.indexOf("--before") + 1] && argv.includes("--before") ? argv[argv.indexOf("--before") + 1] : undefined;

type Meta = { err: unknown; loadedAddresses?: { writable: Address[]; readonly: Address[] }; innerInstructions?: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[] };

for (const name of TARGETS) {
  const programId = manifest.idls.find((e) => e.name === name)!.programId;
  // Recent Drift traffic is all the non-Anchor path; page back from --before (e.g. the replayed attack tx).
  const sigs: { signature: string; err: unknown }[] = [];
  let before = BEFORE;
  for (let page = 0; page < 3; page++) {
    const batch = (await heliusCall(url, "getSignaturesForAddress", [programId, { limit: 1000, commitment: "finalized", ...(before ? { before } : {}) }])).result as { signature: string; err: unknown }[];
    sigs.push(...batch);
    if (batch.length < 1000) break;
    before = batch.at(-1)!.signature;
  }
  let fetched = 0;
  const kept: { file: string; names: string[] }[] = [];
  const seenNames = new Set<string>();
  const backups: { sig: string; body: unknown; names: string[] }[] = [];
  for (const s of sigs) {
    if (kept.length >= WANT) break;
    if (s.err) continue;
    if (++fetched > MAX_FETCH) break;
    const r = (await heliusCall(url, "getTransaction", [s.signature, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "finalized" }])).result as { slot: number; blockTime: number; version: number | "legacy"; transaction: [string, string]; meta: Meta } | null;
    if (!r) continue;
    const tx = parseTransaction({ base64: r.transaction[0], kind: "wire" });
    const keys = [...tx.staticAccounts, ...(r.meta.loadedAddresses?.writable ?? []), ...(r.meta.loadedAddresses?.readonly ?? [])];
    const resolve = (programIdIndex: number, indices: number[], data: Uint8Array, index: number): ResolvedInstruction => ({
      index, programIdIndex, programAddress: keys[programIdIndex]!, data,
      accounts: indices.map((i) => ({ index: i, address: keys[i]!, signer: i < tx.header.numSignerAccounts, writable: false, source: { kind: "static" } as const }))
    });
    const ixs = tx.instructions.map((ix, i) => resolve(ix.programIdIndex, ix.accountIndices, ix.data, i));
    for (const g of r.meta.innerInstructions ?? []) for (const ix of g.instructions) ixs.push(resolve(ix.programIdIndex, ix.accounts, Uint8Array.from(getBase58Encoder().encode(ix.data)), g.index));
    const names = ixs.map((ix) => decoder.decodeInstruction(ix)).filter((d) => d.programAddress === programId && d.status === "named" && d.decoder === "codama").map((d) => d.name!);
    if (!names.length) continue;
    const bytes = Buffer.from(r.transaction[0], "base64");
    const body = {
      schema: "kelvara.fixture.tx/v1",
      network: "mainnet",
      signature: s.signature,
      slot: r.slot,
      blockTime: r.blockTime,
      fetchedAt: new Date().toISOString(),
      source: "helius:getTransaction",
      program: programId,
      encoding: "base64",
      transaction: r.transaction[0],
      sha256: createHash("sha256").update(bytes).digest("hex"),
      version: r.version,
      purpose: `G5: ${name} IDL decodes real transactions (${[...new Set(names)].join(", ")})`,
      meta: r.meta
    };
    if (names.some((n) => !seenNames.has(n))) {
      names.forEach((n) => seenNames.add(n));
      const text = JSON.stringify(body, null, 2) + "\n";
      if (/api-key/i.test(text)) throw new Error("refusing to write fixture: contains api-key");
      const file = path.join("fixtures", name, `${s.signature}.json`);
      mkdirSync(path.join(pkgDir, "fixtures", name), { recursive: true });
      writeFileSync(path.join(pkgDir, file), text);
      kept.push({ file, names: [...new Set(names)] });
    } else backups.push({ sig: s.signature, body, names });
  }
  for (const k of kept) console.log(`${name} ${k.file}: ${k.names.join(", ")}`);
  if (kept.length < 3) console.log(`${name}: only ${kept.length} distinct-instruction txs in ${fetched} transactions read (${backups.length} more with repeated names not written)`);
}
