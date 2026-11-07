import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDecoder, createFixtureAccountReader, createSquadsDecoder, decodeSquadsMessage, ingestSession, SQUADS_V4_PROGRAM, type AnchorIdlJson, type RecordedAccount } from "../src/index.js";
import { sha256 } from "../src/util/sha256.js";
import spike from "./fixtures/decode/spike.json" with { type: "json" };

const idl = JSON.parse(readFileSync(new URL("../../idls/raw/squads-v4.json", import.meta.url), "utf8")) as AnchorIdlJson;
const squads = createSquadsDecoder(idl);
const decoder = createDecoder([{ name: "squads-v4", programId: SQUADS_V4_PROGRAM, idl }]);
const u32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];
const key = Array<number>(32).fill(0);
const disc = (name: string): number[] => [...sha256(new TextEncoder().encode(`account:${name}`)).slice(0, 8)];
// Deliberately constructed layout unit inputs, not chain fixtures or transaction evidence.
const emptyStoredMessage = [0, 0, 0, ...u32(0), ...u32(0), ...u32(0)];

describe("E3 Squads", () => {
  it("decodes the real attack creation message through both IDL argument shapes", async () => {
    const tx = spike.transactions.find((t) => t.label === "drift-attack create and approve")!;
    const session = await ingestSession([{ base64: tx.wireBase64 }], { reader: createFixtureAccountReader(spike.lookupTables as Record<string, RecordedAccount | null>) });
    const ix = decoder.decodeSession(session)[0]!.find((i) => i.name === "vaultTransactionCreate")!;
    const message = squads.decodeCreateMessage(ix)!;
    expect(message.instructions.length).toBeGreaterThan(0);
    expect(message.accountKeys.length).toBeGreaterThan(0);
    const bytes = ix.args!.transactionMessage as Uint8Array;
    for (let n = 0; n < bytes.length; n++) expect(() => decodeSquadsMessage(bytes.slice(0, n))).toThrow();
    expect(squads.decodeCreateMessage({ ...ix, args: { args: { transaction_message: ix.args!.transactionMessage } } })).toEqual(message);
  });

  it("decodes stored account layouts with lossless u64 and proposal status", () => {
    const index = Array(8).fill(255) as number[];
    const multisig = squads.decodeAccount(Uint8Array.from([...disc("Multisig"), ...key, ...key, 1, 0, ...u32(0), ...index, ...index, 0, 255, ...u32(0)]))!;
    expect(multisig.name).toBe("Multisig");
    expect(multisig.data.transactionIndex).toBe(2n ** 64n - 1n);
    const proposal = squads.decodeAccount(Uint8Array.from([...disc("Proposal"), ...key, ...index, 0, ...Array(8).fill(0), 255, ...u32(0), ...u32(0), ...u32(0)]))!;
    expect(proposal.name).toBe("Proposal");
    expect(proposal.data.transactionIndex).toBe(2n ** 64n - 1n);
    expect(proposal.data.status).toMatchObject({ __kind: "Draft" });
    const vault = squads.decodeAccount(Uint8Array.from([...disc("VaultTransaction"), ...key, ...key, ...index, 255, 0, 255, ...u32(0), ...emptyStoredMessage]))!;
    expect(vault.name).toBe("VaultTransaction");
    expect(vault.data.index).toBe(2n ** 64n - 1n);
    expect(vault.data.message).toMatchObject({ instructions: [], addressTableLookups: [] });
  });

  it("rejects truncation, invalid headers, indices, and trailing compact bytes", () => {
    expect(decodeSquadsMessage(Uint8Array.from([0, 0, 0, 0, 0, 0])).instructions).toEqual([]);
    for (const bytes of [[1], [1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 1]]) expect(() => decodeSquadsMessage(Uint8Array.from(bytes))).toThrow();
    expect(squads.decodeAccount(new Uint8Array(8))).toBeNull();
    for (const name of ["Multisig", "Proposal", "VaultTransaction"]) expect(() => squads.decodeAccount(Uint8Array.from(disc(name)))).toThrow();
  });
});
