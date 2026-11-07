/* eslint-disable @typescript-eslint/no-explicit-any -- recorded JSON-RPC payloads are untyped JSON */
// E13: state reads and simulation over recorded real RPC responses (Helius mainnet and localnet
// after scenario:admin-local / scenario:trap-local). Recorded by scripts/record-state-fixtures.ts.
// Expected values are checked against independent sources: the scenarios' own records
// (scenario.json, attack.json), the scenarios' Squads clone metadata, and the fixture transactions.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createCachingAccountReader,
  createFixtureAccountReader,
  createRpcAccountReader,
  createRpcClient,
  createSquadsDecoder,
  decodeLoaderState,
  decodeMint,
  decodeNonceAccount,
  decodeTokenAccount,
  findAccountOrigin,
  fundingFromTransaction,
  ingestSession,
  readMint,
  readMints,
  readNonceAccount,
  readProgram,
  readSquadsAccount,
  simulateSessionTransaction,
  simulateTransaction,
  StateReadError,
  wireTransactionBytes,
  type AnchorIdlJson,
  type RpcJsonTransaction
} from "../src/index.js";
import { fromBase64 } from "../src/util/encoding.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
interface Recording {
  network: "mainnet" | "localnet";
  inputs: Record<string, any>;
  observed: Record<string, any>;
  calls: { method: string; params: unknown; result: unknown }[];
}
const load = (name: string): Recording => JSON.parse(readFileSync(path.join(here, "fixtures/state", name), "utf8")) as Recording;
const MAIN = load("mainnet.json");
const LOCAL = load("localnet.json");
const squadsIdl = JSON.parse(readFileSync(path.join(root, "packages/idls/raw/squads-v4.json"), "utf8")) as AnchorIdlJson;
const squads = createSquadsDecoder(squadsIdl);

/** Replays recorded calls; an unrecorded request fails the test instead of reaching the network. */
function replay(rec: Recording) {
  const map = new Map(rec.calls.map((c) => [`${c.method}:${JSON.stringify(c.params)}`, c.result]));
  const misses: string[] = [];
  const fetchFn = (async (_u: unknown, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown };
    const k = `${b.method}:${JSON.stringify(b.params)}`;
    if (!map.has(k)) {
      misses.push(k.slice(0, 200));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, error: { code: -32602, message: "not recorded" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: map.get(k) }), { status: 200 });
  }) as typeof fetch;
  const url = rec.network === "mainnet" ? "https://mainnet.helius-rpc.com/?api-key=replay" : "http://localhost:8899";
  const rpc = createRpcClient({ url, fetch: fetchFn, maxRps: 1000, sleep: async () => {} });
  return { rpc, reader: createRpcAccountReader(rpc), misses };
}

describe("mainnet reads (Helius recording)", () => {
  it("reads PYUSD as Token-2022 with permanent delegate, transfer hook, fees and metadata", async () => {
    const { reader, misses } = replay(MAIN);
    const [pyusd, usdc] = await readMints(reader, [MAIN.inputs.PYUSD, MAIN.inputs.USDC]);
    expect(misses).toEqual([]);
    if (pyusd instanceof StateReadError || usdc instanceof StateReadError) throw new Error("mint read failed");
    expect(pyusd.program).toBe("token-2022");
    expect(pyusd.decimals).toBe(6);
    expect(pyusd.metadata?.symbol).toBe("PYUSD");
    expect(pyusd.metadataPointer?.metadataAddress).toBe(MAIN.inputs.PYUSD);
    expect(pyusd.permanentDelegate).toBeTruthy();
    expect(pyusd.freezeAuthority).toBeTruthy();
    expect(pyusd.transferHook).not.toBeNull();
    expect(pyusd.transferFee).not.toBeNull();
    expect(pyusd.extensions.map((e) => e.name)).toEqual(
      expect.arrayContaining(["permanentDelegate", "transferHook", "transferFeeConfig", "mintCloseAuthority", "metadataPointer", "tokenMetadata"])
    );
    expect(pyusd.extensions.some((e) => e.fields.malformed)).toBe(false);
    // Classic SPL Token mint: no extensions, freeze authority set.
    expect(usdc.program).toBe("token");
    expect(usdc.decimals).toBe(6);
    expect(usdc.freezeAuthority).toBeTruthy();
    expect(usdc.extensions).toEqual([]);
    expect(usdc.permanentDelegate).toBeNull();
  });

  it("reads program data headers: Squads v4 immutable (matches the scenarios' clone), Drift upgradeable", async () => {
    const { reader, misses } = replay(MAIN);
    const sq = await readProgram(reader, MAIN.inputs.SQUADS);
    // Same values the scenarios recorded when cloning Squads for localnet (.localnet/state.json).
    expect(sq.programData).toBe("Fy3YMJCvwbAXUgUM5b91ucUVA3jYzwWLHL3MwBqKsh8n");
    expect(sq.deploySlot).toBe(302582236n);
    expect(sq.upgradeAuthority).toBeNull();
    expect(sq.upgradeable).toBe(false);
    const drift = await readProgram(reader, MAIN.inputs.DRIFT);
    expect(drift.upgradeable).toBe(true);
    expect(drift.upgradeAuthority).toBe(MAIN.observed.drift.upgradeAuthority);
    expect(misses).toEqual([]);
    // Only the 45-byte header was fetched, never the ELF.
    const slices = MAIN.calls.filter((c) => c.method === "getAccountInfo").map((c) => (c.params as any[])[1].dataSlice);
    expect(slices.every((s: any) => s.length === 45)).toBe(true);
  });

  it("reads the Drift attack nonce and names its funder from the oldest transaction", async () => {
    const { rpc, reader, misses } = replay(MAIN);
    const n = await readNonceAccount(reader, MAIN.inputs.nonce);
    expect(n.state).toBe("initialized");
    // The attack transaction's lifetime token was this nonce's value at the time; the nonce has advanced since,
    // but the authority is the AdvanceNonce authority named by the fixture transaction.
    const fx = JSON.parse(readFileSync(path.join(root, "fixtures/tx/drift-replay", `${MAIN.inputs.driftAttackTx}.json`), "utf8"));
    const session = await ingestSession([{ base64: fx.transaction }]);
    const adv = session.transactions[0]!.instructions.find((ix) => ix.programAddress === "11111111111111111111111111111111" && ix.data[0] === 4)!;
    expect(adv.accounts[0]!.address).toBe(MAIN.inputs.nonce);
    expect(adv.accounts[2]!.address).toBe(n.authority);
    const origin = await findAccountOrigin(rpc, MAIN.inputs.nonce, { maxPages: 3 });
    expect(origin).not.toBeNull();
    expect(origin!.complete).toBe(true);
    expect(origin!.method).toBe("createAccount");
    expect(origin!.funder).toBe(MAIN.observed.origin.funder);
    expect(misses).toEqual([]);
  });

  it("reads the Drift Squads multisig with zero time lock", async () => {
    const { reader } = replay(MAIN);
    const ms = await readSquadsAccount(reader, squads, MAIN.inputs.multisig, "Multisig");
    expect(ms.data.timeLock).toBe(0);
    expect(ms.data.threshold).toBe(MAIN.observed.multisig.threshold);
    await expect(readSquadsAccount(reader, squads, MAIN.inputs.multisig, "Proposal")).rejects.toMatchObject({ code: "wrong_kind" });
  });

  it("refuses wrong owners instead of guessing", async () => {
    // The recorded PYUSD mint account, served under its own address: a mint is not a nonce or a Squads account.
    const raw = (MAIN.calls[0]!.result as { value: { owner: string; data: [string, string]; lamports: number; executable: boolean }[] }).value[0]!;
    const reader = createFixtureAccountReader({ [MAIN.inputs.PYUSD]: { owner: raw.owner, dataBase64: raw.data[0], lamports: raw.lamports, executable: raw.executable } });
    await expect(readNonceAccount(reader, MAIN.inputs.PYUSD)).rejects.toMatchObject({ code: "wrong_owner" });
    await expect(readSquadsAccount(reader, squads, MAIN.inputs.PYUSD)).rejects.toMatchObject({ code: "wrong_owner" });
  });
});

describe("localnet reads (scenario state)", () => {
  it("$SHINY: permanent delegate and freeze authority are the creator", async () => {
    const { reader, misses } = replay(LOCAL);
    const m = await readMint(reader, LOCAL.inputs.shinyMint);
    expect(misses).toEqual([]);
    expect(m.program).toBe("token-2022");
    expect(m.permanentDelegate).toBe(LOCAL.inputs.trapCreator);
    expect(m.freezeAuthority).toBe(LOCAL.inputs.trapCreator);
    expect(m.metadata?.symbol).toBe("SHINY");
    expect(m.transferHook).toBeNull();
    expect(m.nonTransferable).toBe(false);
  });

  it("nonce: authority is member A and the outsider funded it", async () => {
    const { rpc, reader } = replay(LOCAL);
    const n = await readNonceAccount(reader, LOCAL.inputs.nonce);
    expect(n.authority).toBe(LOCAL.inputs.nonceAuthority);
    const origin = await findAccountOrigin(rpc, LOCAL.inputs.nonce);
    expect(origin).toMatchObject({ funder: LOCAL.inputs.nonceFunder, method: "createAccount", complete: true });
    expect(origin!.funder).not.toBe(n.authority);
  });

  it("demo program: upgrade authority moved to the attacker after the scenario ran", async () => {
    const { reader } = replay(LOCAL);
    const p = await readProgram(reader, LOCAL.inputs.demoProgram);
    expect(p.programData).toBe(LOCAL.inputs.programData);
    expect(p.upgradeAuthority).toBe(LOCAL.inputs.upgradeAuthorityAfterAttack);
  });

  it("Squads multisig, proposal and vault transaction", async () => {
    const { reader } = replay(LOCAL);
    const ms = await readSquadsAccount(reader, squads, LOCAL.inputs.multisig, "Multisig");
    expect(ms.data.threshold).toBe(LOCAL.inputs.threshold);
    expect(ms.data.timeLock).toBe(LOCAL.inputs.timeLock);
    const members = (ms.data.members as { key: string }[]).map((m) => m.key).sort();
    expect(members).toEqual(Object.values(LOCAL.inputs.members as Record<string, string>).sort());
    const proposal = await readSquadsAccount(reader, squads, LOCAL.inputs.proposal, "Proposal");
    expect((proposal.data.status as { __kind: string }).__kind).toBe("Executed");
    const vtx = await readSquadsAccount(reader, squads, LOCAL.inputs.vaultTransaction, "VaultTransaction");
    expect(String(vtx.data.index)).toBe("1");
  });
});

describe("simulation (localnet recording)", () => {
  it("a fresh SOL transfer: sigVerify false, inner/post-state requested, balance changes kept", async () => {
    const { rpc, reader, misses } = replay(LOCAL);
    const t = LOCAL.inputs.transfer;
    const sim = await simulateTransaction(rpc, fromBase64(t.wireBase64), { reader, accounts: [t.from, t.to] });
    expect(misses).toEqual([]);
    expect(sim.ok).toBe(true);
    expect(sim.blockhashReplaced).toBe(false);
    const req = LOCAL.calls.find((c) => c.method === "simulateTransaction" && (c.params as any[])[0] === t.wireBase64)!;
    expect((req.params as any[])[1]).toMatchObject({ sigVerify: false, innerInstructions: true, encoding: "base64", accounts: { encoding: "base64", addresses: [t.from, t.to] } });
    const to = sim.solChanges.find((c) => c.address === t.to)!;
    const from = sim.solChanges.find((c) => c.address === t.from)!;
    expect(to.delta).toBe(BigInt(t.lamports));
    expect(to.pre).toBe(0n);
    expect(from.delta).toBe(-(BigInt(t.lamports) + 5000n)); // amount + one signature fee
    expect(sim.tokenChanges).toEqual([]);
    expect(sim.stateChanges.find((c) => c.address === t.to && c.field === "owner")).toMatchObject({ before: null, after: "11111111111111111111111111111111" });
  });

  it("an expired approval: retries with replaceRecentBlockhash and reports the failure, no changes", async () => {
    const { rpc, reader, misses } = replay(LOCAL);
    const a = LOCAL.inputs.approval;
    const sim = await simulateTransaction(rpc, fromBase64(a.wireBase64), { reader, accounts: a.accounts });
    expect(misses).toEqual([]);
    expect(sim.blockhashReplaced).toBe(true);
    expect(sim.ok).toBe(false);
    expect(sim.err).toEqual(LOCAL.observed.approval.err);
    expect(sim.solChanges).toEqual([]);
    expect(sim.logs.length).toBeGreaterThan(0);
  });

  it("session transactions round-trip to the same wire bytes", async () => {
    const wire = fromBase64(LOCAL.inputs.approval.wireBase64);
    const session = await ingestSession([wire]);
    expect(Buffer.from(wireTransactionBytes(session.transactions[0]!))).toEqual(Buffer.from(wire));
    const t = fromBase64(LOCAL.inputs.transfer.wireBase64);
    const s2 = await ingestSession([t]);
    expect(Buffer.from(wireTransactionBytes(s2.transactions[0]!))).toEqual(Buffer.from(t));
    // A bare message gets zero signature slots, same length as the wire form.
    const bare = await ingestSession([{ bytes: s2.transactions[0]!.messageBytes, kind: "message" }]);
    expect(Buffer.from(wireTransactionBytes(bare.transactions[0]!))).toEqual(Buffer.from(t));
    // Simulating the session transaction defaults to its writable accounts (the recorded request).
    const { rpc, reader } = replay(LOCAL);
    const sim = await simulateSessionTransaction(rpc, s2.transactions[0]!, { reader });
    expect(sim.ok).toBe(true);
  });

  it("the cache serves the session's repeated account reads", async () => {
    const { rpc, reader } = replay(LOCAL);
    const cached = createCachingAccountReader(reader);
    await readMint(cached, LOCAL.inputs.shinyMint);
    await readMint(cached, LOCAL.inputs.shinyMint);
    await readMint(reader, LOCAL.inputs.shinyMint);
    expect(rpc.stats.requests).toBe(1);
    expect(rpc.stats.cacheHits).toBe(1);
  });
});

describe("layout decoders on recorded bytes", () => {
  const acct = (rec: Recording, address: string) => {
    for (const c of rec.calls) {
      if (c.method !== "getMultipleAccounts") continue;
      const i = ((c.params as any[])[0] as string[]).indexOf(address);
      const v = (c.result as any).value[i];
      if (i >= 0 && v) return { owner: v.owner as string, data: fromBase64(v.data[0]) };
    }
    throw new Error(`not recorded: ${address}`);
  };

  it("rejects truncated or extended bytes", () => {
    const nonce = acct(LOCAL, LOCAL.inputs.nonce);
    expect(decodeNonceAccount(nonce.data)).not.toBeNull();
    expect(decodeNonceAccount(nonce.data.subarray(0, 79))).toBeNull();
    const shiny = acct(LOCAL, LOCAL.inputs.shinyMint);
    expect(decodeMint(shiny.owner, shiny.data)).not.toBeNull();
    expect(decodeMint("11111111111111111111111111111111", shiny.data)).toBeNull();
    // Cutting into a TLV entry must fail, not decode a partial extension.
    expect(decodeMint(shiny.owner, shiny.data.subarray(0, 170))).toBeNull();
    expect(decodeTokenAccount(shiny.owner, shiny.data)).toBeNull();
    const usdc = acct(MAIN, MAIN.inputs.USDC);
    expect(decodeMint(usdc.owner, usdc.data)?.program).toBe("token");
    expect(decodeMint(usdc.owner, new Uint8Array([...usdc.data, 0]))).toBeNull();
    const prog = acct(MAIN, MAIN.inputs.DRIFT);
    expect(decodeLoaderState(prog.data)?.kind).toBe("program");
    expect(decodeLoaderState(prog.data.subarray(0, 20))).toBeNull();
  });

  it("decoders never throw on random bytes", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) & 0xff);
    const owners = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
    for (let i = 0; i < 1000; i++) {
      const len = [80, 82, 165, 166, 200, 45, 36, rnd() * 3][i % 8]!;
      const d = Uint8Array.from({ length: len }, rnd);
      if (len >= 166 && i % 2 === 0) d[165] = 1;
      expect(() => {
        decodeNonceAccount(d);
        decodeLoaderState(d);
        decodeMint(owners[i % 2]!, d);
        decodeTokenAccount(owners[i % 2]!, d);
      }).not.toThrow();
    }
  });

  it("funding falls back to the fee payer when no System call funds the account", () => {
    const tx = MAIN.calls.find((c) => c.method === "getTransaction")!.result as RpcJsonTransaction;
    expect(fundingFromTransaction(tx, MAIN.inputs.nonce).method).toBe("createAccount");
    const other = fundingFromTransaction(tx, MAIN.inputs.PYUSD);
    expect(other).toMatchObject({ method: "feePayer", funder: tx.transaction.message.accountKeys[0] });
  });
});
