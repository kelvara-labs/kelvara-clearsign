// Reading the recorded chain state of registry programs (chain/programs.json) and Anchor IDL addresses.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAddressWithSeed, getBase58Decoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { UPGRADEABLE_LOADER_PROGRAM } from "@kelvara/core";

const b58 = getBase58Decoder();

/** One recorded JSON-RPC call (no URL, no key). */
export interface Recorded { method: string; params: unknown[]; result: unknown }
export type AccountResult = { context: { slot: number }; value: { data: [string, string]; executable: boolean; owner: string; lamports: number; space?: number } | null };

export interface ProgramChain { executable: boolean; owner: string; programData: string | null; upgradeAuthority: string | null; deploySlot: number | null }
/** Program account + ProgramData header from recorded getAccountInfo responses. */
export function programChain(responses: Record<string, Recorded>, programId: string): ProgramChain | null {
  const acct = (responses[`program:${programId}`]?.result as AccountResult | undefined)?.value;
  if (!acct) return null;
  let programData: string | null = null;
  let upgradeAuthority: string | null = null;
  let deploySlot: number | null = null;
  if (acct.owner === UPGRADEABLE_LOADER_PROGRAM) {
    const data = Buffer.from(acct.data[0], "base64");
    if (data.readUInt32LE(0) === 2) programData = b58.decode(data.subarray(4, 36));
    const pd = (responses[`programData:${programId}`]?.result as AccountResult | undefined)?.value;
    if (pd) {
      const d = Buffer.from(pd.data[0], "base64");
      if (d.readUInt32LE(0) === 3) {
        deploySlot = Number(d.readBigUInt64LE(4));
        upgradeAuthority = d[12] === 1 ? b58.decode(d.subarray(13, 45)) : null;
      }
    }
  }
  return { executable: acct.executable, owner: acct.owner, programData, upgradeAuthority, deploySlot };
}

export async function anchorIdlAddress(programId: string): Promise<Address> {
  const [base] = await getProgramDerivedAddress({ programAddress: programId as Address, seeds: [] });
  return createAddressWithSeed({ baseAddress: base, programAddress: programId as Address, seed: "anchor:idl" });
}


export const redact = (s: unknown): string => String(s).replace(/api-key=[^&\s"']+/gi, "api-key=REDACTED");

/** Helius mainnet RPC URL from the environment or a main checkout's .env (never printed). */
export function heliusMainnetUrl(cwd: string): string {
  const url = (key: string) => `https://mainnet.helius-rpc.com/?api-key=${key}`;
  if (process.env.HELIUS_API_KEY) return url(process.env.HELIUS_API_KEY);
  const candidates: string[] = [];
  const git = (dir: string, args: string[]) => execFileSync("git", args, {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  const mainEnv = (dir: string) => path.join(path.dirname(git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])), ".env");
  try {
    candidates.push(mainEnv(cwd));
  } catch {
    /* not a git checkout */
  }
  try {
    const origin = git(cwd, ["config", "--get", "remote.origin.url"]);
    const local = origin.startsWith("file://") ? fileURLToPath(origin) : origin;
    if (path.isAbsolute(local) && existsSync(local)) candidates.push(mainEnv(local));
  } catch {
    /* no usable local origin; never contact remote origins */
  }
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?HELIUS_API_KEY\s*=\s*["']?([^"'\s#]+)/.exec(line);
      if (match) return url(match[1]!);
    }
  }
  throw new Error("HELIUS_API_KEY missing from environment or main checkout .env");
}

/** One JSON-RPC call with retries on network errors, 429 and 5xx; errors are redacted. */
export async function heliusCall(url: string, method: string, params: unknown[]): Promise<Recorded> {
  for (let attempt = 0; attempt < 6; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      if (attempt === 5) throw new Error(redact(`${method}: ${(e as Error).message}`));
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    if (body.error) throw new Error(redact(`${method}: ${JSON.stringify(body.error)}`));
    return { method, params, result: body.result };
  }
  throw new Error(`${method}: rate limited or unavailable`);
}
