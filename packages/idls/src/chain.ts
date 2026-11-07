// Reading the recorded chain state of registry programs (chain/programs.json) and Anchor IDL addresses.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
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

/** Helius mainnet RPC URL with HELIUS_API_KEY from the main checkout's .env (never printed). */
export function heliusMainnetUrl(cwd: string): string {
  const common = execSync("git rev-parse --path-format=absolute --git-common-dir", { cwd }).toString().trim();
  const key = readFileSync(path.join(common, "..", ".env"), "utf8").match(/^HELIUS_API_KEY=(.+)$/m)?.[1]?.trim();
  if (!key) throw new Error("HELIUS_API_KEY missing from .env");
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
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
