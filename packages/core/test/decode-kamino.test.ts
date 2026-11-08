// E28: Kamino programs on real mainnet transactions recorded over Helius (lending, vaults, farms, liquidity, scope).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RootNode } from "@codama/nodes";
import { createDecoder, explainReport, readTokenMeta, type DecodedInstruction } from "../src/index.js";
import { analyze, decoder, here, json, replay, sessionFromRuntime, type Recording } from "./rules-helpers.js";

const KAMINO = ["kamino-lending", "kamino-vault", "kamino-farms", "kamino-liquidity", "kamino-scope"];
const dir = path.join(here, "fixtures/kamino");
const sessions = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
  const fx = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { transaction: string; meta: { loadedAddresses?: { writable: string[]; readonly: string[] } } };
  return { f, session: sessionFromRuntime(fx.transaction, fx.meta.loadedAddresses ?? { writable: [], readonly: [] }) };
});
const kaminoIxs = (d: DecodedInstruction[][]) => d.flat().filter((i) => i.programName && KAMINO.includes(i.programName));

describe("Kamino on real transactions", () => {
  it("names every Kamino instruction, with named accounts, for all five programs", () => {
    const seen = new Set<string>();
    for (const s of sessions) {
      for (const ix of kaminoIxs(decoder.decodeSession(s.session))) {
        expect(ix.status, `${s.f} ix ${ix.index} ${ix.programName}`).toBe("named");
        expect(ix.accounts.filter((a) => a.name).length, s.f).toBeGreaterThan(0);
        seen.add(`${ix.programName}.${ix.name}`);
      }
    }
    for (const p of KAMINO) expect([...seen].some((x) => x.startsWith(`${p}.`)), p).toBe(true);
    for (const name of ["kamino-lending.repayObligationLiquidityV2", "kamino-lending.borrowObligationLiquidityV2", "kamino-lending.refreshObligation", "kamino-vault.deposit", "kamino-farms.stake", "kamino-liquidity.withdraw", "kamino-scope.refreshPriceList"]) expect(seen.has(name), name).toBe(true);
  });

  it("decodes the same from the compact Codama roots alone (the extension can skip the raw Anchor IDLs)", () => {
    const manifest = json<{ idls: { name: string; programId: string }[] }>("packages/idls/manifest.json");
    const rootsOnly = createDecoder(manifest.idls.filter((e) => KAMINO.includes(e.name)).map((e) => ({ name: e.name, programId: e.programId, root: json<RootNode>(`packages/idls/roots/${e.name}.json`) })));
    for (const s of sessions) {
      const full = decoder.decodeSession(s.session);
      for (const ix of kaminoIxs(full)) {
        const d = rootsOnly.decodeInstruction({ index: ix.index, programIdIndex: 0, programAddress: ix.programAddress, accounts: ix.accounts.map((a, i) => ({ index: i, address: a.address, signer: a.signer, writable: a.writable, source: { kind: "static" as const } })), data: ix.data });
        expect(d.status, `${s.f} ${ix.name}`).toBe("named");
        expect(d.name).toBe(ix.name);
      }
    }
  });

  it("reports program calls with the program and instruction, levels stay low, headline names the call", () => {
    let calls = 0;
    for (const s of sessions) {
      const r = analyze(s.session);
      expect(r.alert.level, s.f).toBe("L0");
      const text = r.claims.filter((c) => c.ruleId === "fact.program_call").map((c) => c.statement);
      const kamino = text.filter((t) => /^Kamino /.test(t));
      for (const t of kamino) expect(t).toMatch(/^Kamino (Lending|Vault|Farms|Liquidity|Scope) · [A-Z][a-z]+( [a-z0-9]+)*(: .+)?\.$/);
      calls += kamino.length;
      if (kamino.length && kamino.length === text.length && !r.claims.some((c) => c.ruleId === "fact.unknown_instruction")) expect(explainReport(r).headline).toMatch(/^Kamino /);
    }
    expect(calls).toBeGreaterThan(0);
  });

  it("amounts use the token's decimals and name when metadata was read (replayed real Helius responses)", async () => {
    const rec = json<Recording>("packages/core/test/fixtures/tokens/kamino.json");
    let human = 0;
    for (const s of sessions) {
      const { rpc, reader } = replay(rec);
      const m = await readTokenMeta(rpc, reader, s.session, decoder.decodeSession(s.session));
      const r = analyze(s.session, { tokens: m.tokens, tokenAccountMints: m.tokenAccountMints });
      for (const c of r.claims.filter((c) => c.ruleId === "fact.program_call" && /^Kamino /.test(c.statement))) {
        // Instructions that name no token account or mint (e.g. set stake delegated) keep raw units: never guessed.
        if (/amount [\d.]+ [A-Za-z]/.test(c.statement) && !/base units|token mint/.test(c.statement)) human++;
      }
    }
    expect(human).toBeGreaterThan(1);
  });
});
