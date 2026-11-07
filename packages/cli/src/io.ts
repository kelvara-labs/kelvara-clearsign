// Inputs, tx fixtures and the Helius key. The key is read from HELIUS_API_KEY or the main checkout's .env,
// never printed, logged or written; every message that may hold a URL goes through redactUrl.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactUrl, type IngestInput, type RpcClient } from "@kelvara/core";

export const FIXTURE_SCHEMA = "kelvara.fixture.tx/v1";

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Fixture shape shared with scenarios (fixtures/tx/<dir>/<signature>.json). */
export interface TxFixture {
  schema: string;
  network: string;
  signature: string;
  slot: number | null;
  blockTime: number | null;
  fetchedAt: string;
  source: string;
  encoding: "base64";
  transaction: string;
  sha256: string;
  version: "legacy" | number | null;
  meta: unknown;
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** One input file: base64 text (one transaction per line), a tx fixture, an array, or {transactions: [...]}. */
export function inputsFromText(text: string, name: string): IngestInput[] {
  const t = text.trim();
  if (!t) throw new Error(`${name}: empty input`);
  if (t.startsWith("{") || t.startsWith("[")) {
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch (e) {
      throw new Error(`${name}: not JSON (${(e as Error).message})`);
    }
    const list = Array.isArray(v) ? v : (v as { transactions?: unknown }).transactions ?? [v];
    if (!Array.isArray(list) || !list.length) throw new Error(`${name}: no transactions`);
    return list.map((x, i) => {
      if (typeof x === "string") return { base64: x.trim(), label: `${name}#${i}` };
      const o = x as { transaction?: unknown; wireBase64?: unknown; base64?: unknown; label?: unknown };
      const b = o.transaction ?? o.wireBase64 ?? o.base64;
      if (typeof b !== "string") throw new Error(`${name}#${i}: no base64 transaction`);
      return { base64: b.trim(), label: typeof o.label === "string" ? o.label : `${name}#${i}` };
    });
  }
  const lines = t.split(/\s+/).filter(Boolean);
  for (const l of lines) if (!B64.test(l)) throw new Error(`${name}: not base64`);
  return lines.map((base64, i) => ({ base64, label: lines.length > 1 ? `${name}#${i}` : name }));
}

export function readInput(file: string): IngestInput[] {
  const text = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  return inputsFromText(text, file === "-" ? "stdin" : path.basename(file));
}

/** Finds fixtures/tx/**\/<signature>.json. */
export function findTxFixture(root: string, signature: string): string | null {
  const base = path.join(root, "fixtures/tx");
  if (!existsSync(base)) return null;
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === `${signature}.json`) return p;
    }
  }
  return null;
}

/** Reads a fixture and checks its signature and that its bytes hash to its stored sha256. */
export function loadTxFixture(file: string, signature: string): TxFixture {
  const f = JSON.parse(readFileSync(file, "utf8")) as TxFixture;
  if (f.signature !== signature) throw new Error(`${file}: signature ${f.signature} is not ${signature}`);
  if (typeof f.transaction !== "string") throw new Error(`${file}: no transaction bytes`);
  const hash = sha256Hex(Buffer.from(f.transaction, "base64"));
  if (f.sha256 && f.sha256 !== hash) throw new Error(`${file}: sha256 ${f.sha256} does not match bytes (${hash})`);
  return f;
}

/** getTransaction (base64) over the client; the raw bytes and their sha256 become the fixture. */
export async function fetchTxFixture(rpc: RpcClient, signature: string): Promise<TxFixture> {
  const r = await rpc.call<{ slot: number; blockTime: number | null; version?: "legacy" | number; transaction: [string, string]; meta: unknown } | null>("getTransaction", [
    signature,
    { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }
  ]);
  if (!r) throw new Error(`transaction ${signature} not found on ${rpc.network}`);
  const [b64, enc] = r.transaction;
  if (enc !== "base64" || typeof b64 !== "string") throw new Error(`transaction ${signature}: unexpected encoding ${enc}`);
  return {
    schema: FIXTURE_SCHEMA,
    network: rpc.network,
    signature,
    slot: r.slot ?? null,
    blockTime: r.blockTime ?? null,
    fetchedAt: new Date().toISOString(),
    source: "helius:getTransaction",
    encoding: "base64",
    transaction: b64,
    sha256: sha256Hex(Buffer.from(b64, "base64")),
    version: r.version ?? null,
    meta: r.meta ?? null
  };
}

export function writeTxFixture(dir: string, f: TxFixture): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${f.signature}.json`);
  const text = JSON.stringify(f, null, 2) + "\n";
  if (/api-key=/i.test(text)) throw new Error("refusing to write a fixture that contains an api-key");
  writeFileSync(file, text);
  return file;
}

/** HELIUS_API_KEY from the environment, main checkout, or a local origin's main checkout. */
export function heliusKey(root: string): string | undefined {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY;
  const candidates: string[] = [];
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    candidates.push(path.join(path.dirname(common), ".env"));
  } catch {
    /* not a git checkout */
  }
  candidates.push(path.join(root, ".env"));
  try {
    const origin = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const local = origin.startsWith("file://") ? fileURLToPath(origin) : origin;
    if (path.isAbsolute(local) && existsSync(local)) {
      const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: local, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      candidates.push(path.join(path.dirname(common), ".env"));
    }
  } catch {
    /* no usable local origin; never contact remote origins */
  }
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?HELIUS_API_KEY\s*=\s*["']?([^"'\s#]+)/.exec(line);
      if (m) return m[1];
    }
  }
  return undefined;
}

export const redact = (s: string): string => redactUrl(s);
