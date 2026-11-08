// pnpm labels:build: program display names for programs ClearSign cannot decode (E25).
//   1. candidates  the programs most used on mainnet, tallied from real sampled blocks (Helius getBlock): the number
//                  of transactions that invoke each program (top-level or inner). No program id is typed by hand.
//   2. verify      Helius getMultipleAccounts: the account exists and is executable; anything else is dropped.
//   3. names       Helius program catalog, describeProgram over wss://fs-beta.helius-rpc.com (the IDL catalog Orb and
//                  Parsed Events share). Catalog slugs are humanized ("raydium_clmm" -> "Raydium Clmm" through an
//                  explicit word map). Programs the catalog does not name are dropped.
//   4. write       labels.json: names and ids only. A name never means the program is decoded or safe.
// Flags: --blocks N (default 40), --top N (default 200). Reads HELIUS_API_KEY like idls:build; never prints it.
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { heliusCall, heliusMainnetUrl, redact, type AccountResult } from "../src/chain.js";
import { humanizeSlug } from "../src/labels.js";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const flag = (name: string, d: number) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const BLOCKS = flag("--blocks", 40), TOP = flag("--top", 200);
const url = heliusMainnetUrl(pkgDir);
const key = new URL(url).searchParams.get("api-key") ?? "";
const rpc = (method: string, params: unknown[]) => heliusCall(url, method, params);
const tally = new Map<string, number>();

interface Block { transactions: { transaction: { message: { accountKeys: (string | { pubkey: string })[]; instructions: { programIdIndex?: number; programId?: string }[] } }; meta: { err: unknown; innerInstructions?: { instructions: { programIdIndex?: number; programId?: string }[] }[]; loadedAddresses?: { writable: string[]; readonly: string[] } } | null }[] }

const head = Number((await rpc("getSlot", [{ commitment: "finalized" }])).result);
console.log(`sampling ${BLOCKS} finalized blocks below slot ${head}`);
let sampled = 0;
for (let i = 0; i < BLOCKS; i++) {
  const slot = head - 1000 - i * 20_000;
  const res = (await rpc("getBlock", [slot, { encoding: "json", transactionDetails: "full", rewards: false, maxSupportedTransactionVersion: 1, commitment: "finalized" }]).catch((e: Error) => { if (i < 2) console.log(redact(e.message).slice(0, 200)); return null; }))?.result as Block | undefined;
  if (!res) continue;
  sampled++;
  for (const tx of res.transactions) {
    if (!tx.meta || tx.meta.err) continue;
    const keys = [...tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey)), ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
    const progs = new Set<string>();
    for (const ix of [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions)]) {
      const id = ix.programId ?? (ix.programIdIndex !== undefined ? keys[ix.programIdIndex] : undefined);
      if (id) progs.add(id);
    }
    for (const id of progs) tally.set(id, (tally.get(id) ?? 0) + 1);
  }
}
console.log(`blocks read: ${sampled}; distinct programs: ${tally.size}`);

const candidates = [...tally].sort((a, b) => b[1] - a[1]).slice(0, TOP * 3).map(([id]) => id);

const executable = new Set<string>();
for (let i = 0; i < candidates.length; i += 100) {
  const chunk = candidates.slice(i, i + 100);
  const r = (await rpc("getMultipleAccounts", [chunk, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "finalized" }])).result as { value: (AccountResult["value"])[] };
  chunk.forEach((id, j) => { if (r.value[j]?.executable) executable.add(id); });
}
console.log(`verified executable: ${executable.size} of ${candidates.length}`);

const names = new Map<string, string>();
const ws = new WebSocket(`wss://fs-beta.helius-rpc.com/?api-key=${key}`);
await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("describeProgram socket failed")); });
const pending = new Map<number, (v: { name?: string } | null) => void>();
ws.onmessage = (m) => {
  const j = JSON.parse(String(m.data)) as { id: number; result?: { name?: string } };
  pending.get(j.id)?.(j.result ?? null);
  pending.delete(j.id);
};
let nextId = 1;
const describe = (program: string) => new Promise<{ name?: string } | null>((resolve) => {
  const id = nextId++;
  const t = setTimeout(() => { pending.delete(id); resolve(null); }, 10_000);
  pending.set(id, (v) => { clearTimeout(t); resolve(v); });
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "describeProgram", params: [{ program }] }));
});
for (const id of candidates.filter((c) => executable.has(c))) {
  const d = await describe(id);
  if (d?.name) names.set(id, d.name);
}
ws.close();
console.log(`named by the catalog: ${names.size}`);

const fetchedAt = new Date().toISOString();
const registered = new Set((JSON.parse(readFileSync(path.join(pkgDir, "registry.json"), "utf8")) as { programs: { programId: string }[] }).programs.map((p) => p.programId));
const labels = candidates
  .filter((id) => names.has(id) && executable.has(id) && !registered.has(id))
  .slice(0, TOP)
  .map((id) => ({ programId: id, name: humanizeSlug(names.get(id)!) }));
const out = {
  schema: "kelvara.program-labels/v1",
  source: `Helius program catalog (describeProgram, ${fetchedAt.slice(0, 10)})`,
  fetchedAt,
  note: "Names only. Candidates are the programs most used in sampled mainnet blocks; every id was verified as an executable account over Helius. A name never means the program is decoded or safe.",
  blocksSampled: sampled,
  candidates: candidates.length,
  verifiedExecutable: executable.size,
  labels
};
const text = JSON.stringify(out, null, 1) + "\n";
if (/api-key/i.test(text)) throw new Error(redact("refusing to write labels: contains api-key"));
writeFileSync(path.join(pkgDir, "labels.json"), text);
console.log(`labels.json: ${labels.length} labels`);
