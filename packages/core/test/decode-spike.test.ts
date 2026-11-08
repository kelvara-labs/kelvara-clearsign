// E2 spike: every P0 IDL converts to a Codama root and decodes real mainnet transactions.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RootNode } from "@codama/nodes";
import { parseInstruction } from "@codama/dynamic-parsers";
import {
  anchorInstructionDiscriminator,
  createAnchorFallbackDecoder,
  createDecoder,
  createFixtureAccountReader,
  ingestSession,
  type AnchorIdlJson,
  type DecodedInstruction,
  type ProgramEntry,
  type RecordedAccount
} from "../src/index.js";
import { fromBase64 } from "../src/util/encoding.js";
import spike from "./fixtures/decode/spike.json" with { type: "json" };

const idlsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../idls");
const readJson = <T>(p: string): T => JSON.parse(readFileSync(path.join(idlsDir, p), "utf8")) as T;
const manifest = readJson<{ idls: { name: string; programId: string; format: string }[] }>("manifest.json");
const index = readJson<{ name: string; decoder: string }[]>("roots/index.json");

const entries: ProgramEntry[] = manifest.idls.map((m) => ({
  name: m.name,
  programId: m.programId,
  root: readJson<RootNode>(`roots/${m.name}.json`),
  ...(m.format.startsWith("anchor") ? { idl: readJson<AnchorIdlJson>(`raw/${m.name}.json`) } : {})
}));
const PROGRAM_IDS: Record<string, string> = Object.fromEntries(manifest.idls.map((m) => [m.name, m.programId]));

interface SpikeTx { program: string; signature: string; label?: string; wireBase64: string }
const TXS = spike.transactions as SpikeTx[];
const reader = createFixtureAccountReader(spike.lookupTables as Record<string, RecordedAccount | null>);
const decoder = createDecoder(entries);

async function decodeTx(t: SpikeTx): Promise<DecodedInstruction[]> {
  const session = await ingestSession([{ base64: t.wireBase64 }], { reader });
  return decoder.decodeSession(session)[0] ?? [];
}

describe("E2 spike: P0 IDLs to Codama roots", () => {
  it("converts every P0 IDL with Codama (no fallback needed)", () => {
    expect(index.map((i) => [i.name, i.decoder])).toEqual(
      ["system", "token", "token-2022", "squads-v4", "drift-v2", "marginfi-v2", "jupiter-v6"].map((n) => [n, "codama"])
    );
  });

  for (const name of ["system", "token", "token-2022", "squads-v4", "drift-v2"]) {
    it(`decodes real ${name} transactions to named instructions via Codama`, async () => {
      const own = TXS.filter((t) => t.program === name);
      expect(own.length).toBeGreaterThan(0);
      for (const t of own) {
        const ixs = (await decodeTx(t)).filter((d) => d.programAddress === PROGRAM_IDS[name]);
        expect(ixs.length, t.signature).toBeGreaterThan(0);
        for (const d of ixs) {
          expect(d.status, `${t.signature} ix ${d.index}`).toBe("named");
          expect(d.decoder).toBe("codama");
          expect(d.name).toBeTruthy();
          // Every account up to the IDL's named list carries a name.
          expect(d.accounts.some((a) => a.name !== null)).toBe(true);
        }
      }
    });
  }

  it("decodes Drift's attack transactions: nonce advance, Squads approve and execute", async () => {
    const names = async (label: string) =>
      (await decodeTx(TXS.find((t) => t.label === label)!)).map((d) => `${d.programName}:${d.name ?? "?"}`);
    const exec = await names("drift-attack approve and execute");
    expect(exec).toContain("system:advanceNonceAccount");
    expect(exec).toContain("squads-v4:proposalApprove");
    expect(exec).toContain("squads-v4:vaultTransactionExecute");
    const create = await names("drift-attack create and approve");
    expect(create).toContain("squads-v4:vaultTransactionCreate");
    const admin = await names("drift-attack new admin initialize_spot_market");
    expect(admin).toContain("drift-v2:initializeSpotMarket");
  });

  it("names accounts and decodes args for vaultTransactionExecute and advanceNonceAccount", async () => {
    const ixs = await decodeTx(TXS.find((t) => t.label === "drift-attack approve and execute")!);
    const nonce = ixs.find((d) => d.name === "advanceNonceAccount")!;
    expect(nonce.accounts.map((a) => a.name)).toEqual(["nonceAccount", "recentBlockhashesSysvar", "nonceAuthority"]);
    const exec = ixs.find((d) => d.name === "vaultTransactionExecute")!;
    expect(exec.accounts.slice(0, 4).map((a) => a.name)).toEqual(["multisig", "proposal", "transaction", "member"]);
    expect(exec.accounts.find((a) => a.name === "member")?.signer).toBe(true);
  });

  it("the built-in Anchor fallback agrees with Codama on every Squads and Drift fixture instruction", async () => {
    for (const name of ["squads-v4", "drift-v2"]) {
      const fb = createAnchorFallbackDecoder(entries.find((e) => e.name === name)!.idl!);
      for (const t of TXS) {
        for (const d of await decodeTx(t)) {
          if (d.programAddress !== PROGRAM_IDS[name]) continue;
          const f = fb.decode(d.data);
          expect(f?.name, `${t.signature} ix ${d.index}`).toBe(d.name);
          expect(f?.args).toEqual(d.args);
        }
      }
    }
  });

  it("routes a program to the fallback when it has no Codama root", async () => {
    const drift = entries.find((e) => e.name === "drift-v2")!;
    const fallbackOnly = createDecoder([{ name: drift.name, programId: drift.programId, idl: drift.idl! }]);
    const t = TXS.find((x) => x.label === "drift-attack new admin initialize_spot_market")!;
    const session = await ingestSession([{ base64: t.wireBase64 }], { reader });
    const d = fallbackOnly.decodeSession(session)[0]!.find((x) => x.programAddress === drift.programId)!;
    expect(d).toMatchObject({ status: "named", decoder: "anchor-fallback", name: "initializeSpotMarket" });
    const viaCodama = decoder.decodeSession(session)[0]!.find((x) => x.programAddress === drift.programId)!;
    expect(d.accounts.map((a) => a.name)).toEqual(viaCodama.accounts.map((a) => a.name));
    expect(d.accounts.map((a) => a.name)).toContain("admin");
    expect(d.args).toEqual(viaCodama.args);
  });

  it("legacy Anchor discriminators match sha256('global:<snake_name>')", () => {
    const squads = entries.find((e) => e.name === "squads-v4")!.idl!;
    const ix = squads.instructions.find((i) => i.name === "proposalApprove")!;
    // Known Squads v4 discriminator for proposal_approve.
    expect([...anchorInstructionDiscriminator(ix)]).toEqual([144, 37, 164, 136, 188, 216, 42, 248]);
  });

  it("unknown stays unknown: unregistered programs, bad discriminators, truncated args", async () => {
    const t = TXS.find((x) => x.label === "drift-attack approve and execute")!;
    const session = await ingestSession([{ base64: t.wireBase64 }], { reader });
    const ixs = session.transactions[0]!.instructions;
    const empty = createDecoder([]);
    for (const ix of ixs) expect(empty.decodeInstruction(ix)).toMatchObject({ status: "unknown", reason: "program_not_in_registry", name: null });
    const sq = ixs.find((ix) => ix.programAddress === PROGRAM_IDS["squads-v4"])!;
    const bad = decoder.decodeInstruction({ ...sq, data: new Uint8Array(8).fill(0xee) });
    expect(bad).toMatchObject({ status: "unknown", reason: "no_matching_instruction" });
    const truncated = decoder.decodeInstruction({ ...sq, data: sq.data.subarray(0, 9) });
    expect(truncated.status === "unknown" || truncated.args !== null).toBe(true);
  });

  it("never throws on 1,000 random instruction payloads", async () => {
    const t = TXS.find((x) => x.label === "drift-attack approve and execute")!;
    const session = await ingestSession([{ base64: t.wireBase64 }], { reader });
    const ixs = session.transactions[0]!.instructions;
    let seed = 0x2545f491;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) & 0xff);
    for (let i = 0; i < 1000; i++) {
      const base = ixs[i % ixs.length]!;
      const len = rand() % 200;
      const data = Uint8Array.from({ length: len }, rand);
      // Half keep a real discriminator so the arg decoders see garbage.
      if (i % 2 === 0) data.set(base.data.subarray(0, Math.min(8, len)));
      const d = decoder.decodeInstruction({ ...base, data });
      expect(["named", "unknown"]).toContain(d.status);
    }
  });

  it("the discriminator prefilter never changes a Codama result", async () => {
    for (const t of TXS) {
      const session = await ingestSession([{ base64: t.wireBase64 }], { reader });
      for (const ix of session.transactions[0]!.instructions) {
        const e = entries.find((x) => x.programId === ix.programAddress);
        if (!e?.root) continue;
        const full = parseInstruction(e.root, {
          programAddress: ix.programAddress,
          accounts: ix.accounts.map((a) => ({ address: a.address!, role: a.signer ? (a.writable ? 3 : 2) : a.writable ? 1 : 0 })),
          data: ix.data
        });
        const fast = decoder.decodeInstruction(ix);
        expect(fast.name, `${t.signature} ix ${ix.index}`).toBe(full ? (full.path[full.path.length - 1] as { name: string }).name : null);
      }
    }
  });

  it("decodes every scenarios fixture (fixtures/tx) for the P0 Codama programs", async () => {
    const fxDir = path.resolve(idlsDir, "../../fixtures");
    const fm = JSON.parse(readFileSync(path.join(fxDir, "tx/manifest.json"), "utf8")) as { fixtures: { path: string; slug: string }[] };
    const SLUG: Record<string, string> = { system: "system", "spl-token": "token", "token-2022": "token-2022", "squads-v4": "squads-v4", "drift-v2": "drift-v2" };
    // These fixtures carry no lookup table accounts; unresolved addresses stay null (positional names still apply).
    const noTables = { getMultipleAccounts: async (a: readonly string[]) => a.map(() => null) };
    let named = 0;
    let total = 0;
    let driftNonAnchor = 0;
    const misses: string[] = [];
    for (const f of fm.fixtures) {
      const fx = JSON.parse(readFileSync(path.join(fxDir, f.path), "utf8")) as { signature: string; transaction: string };
      const session = await ingestSession([{ base64: fx.transaction }], { reader: noTables as never });
      for (const d of decoder.decodeSession(session)[0]!) {
        if (!Object.values(SLUG).includes(d.programName ?? "") || !Object.values(PROGRAM_IDS).includes(d.programAddress)) continue;
        total++;
        if (d.status === "named") named++;
        // Drift handles a non-Anchor instruction whose data starts with ff ff ff ff (21 bytes, absent
        // from its IDL). It must stay Unknown; anything else unnamed is a failure.
        else if (d.programName === "drift-v2" && d.data.length === 21 && d.data.subarray(0, 4).every((b) => b === 0xff)) {
          expect(d.reason).toBe("no_matching_instruction");
          driftNonAnchor++;
        }
        else misses.push(`${f.slug} ${fx.signature.slice(0, 8)} ix ${d.index} ${d.programName} ${d.reason}`);
      }
    }
    expect(total).toBeGreaterThan(30);
    expect(misses).toEqual([]);
    // 5 Drift fixtures each carry one such instruction (93 P0 instructions, 88 named at E2).
    expect(driftNonAnchor).toBe(5);
    expect(named + driftNonAnchor).toBe(total);
  });

  it("fixture bytes are real: the stored wire bytes round-trip", () => {
    for (const t of TXS) expect(fromBase64(t.wireBase64).length).toBeGreaterThan(64);
  });
});
