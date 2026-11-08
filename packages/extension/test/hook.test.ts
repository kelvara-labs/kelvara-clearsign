import { describe, expect, it } from "vitest";
import { b64encode } from "../src/shared/codec.js";
import {
  BRIDGE_READY_EVENT,
  HOOK_READY_EVENT,
  SW_ANALYZE,
  decisionEventName,
  randomId,
  requestEventName,
  type AnalyzeMessage
} from "../src/shared/protocol.js";
import { webcrypto } from "node:crypto";
import {
  FixtureWallet,
  allow,
  block,
  makeWin,
  never,
  registerWallet,
  rig,
  signFeature,
  startApp,
  wireTx
} from "./helpers.js";

const rejected = expect.objectContaining({ code: 4001 });

describe("channel handshake", () => {
  it("pairs when the bridge is listening first (manifest order)", () => {
    const r = rig(allow);
    expect(r.hook.channel.paired).toBe(true);
    expect(r.bridge!.paired).toBe(true);
  });

  it("stays unpaired, and blocks, when no bridge answered during install", async () => {
    const r = rig(allow, { hookFirst: true });
    expect(r.hook.channel.paired).toBe(false);
    const app = startApp(r.win);
    const w = new FixtureWallet();
    registerWallet(r.win, w);
    await expect(signFeature(app[0]).signTransaction({ transaction: wireTx() })).rejects.toEqual(rejected);
    expect(w.calls.length).toBe(0);
    expect(r.sent.length).toBe(0);
  });

  it("ignores a page that announces itself as the bridge after install", async () => {
    const win = makeWin();
    const { installHook } = await import("../src/hook/install.js");
    const hook = installHook(win, { timeoutMs: 200 })!;
    // Page script runs now: plays bridge with its own channel and approves everything.
    const fake = randomId((a) => webcrypto.getRandomValues(a));
    win.addEventListener(requestEventName(fake), (e) => {
      const id = JSON.parse((e as CustomEvent).detail).id;
      win.dispatchEvent(new CustomEvent(decisionEventName(fake), { detail: JSON.stringify({ v: 1, kind: "decision", id, allow: true }) }));
    });
    win.addEventListener(HOOK_READY_EVENT, () => {});
    win.dispatchEvent(new CustomEvent(BRIDGE_READY_EVENT, { detail: JSON.stringify({ v: 1, channel: fake }) }));
    expect(hook.channel.paired).toBe(false);
    const app = startApp(win);
    const w = new FixtureWallet();
    registerWallet(win, w);
    await expect(signFeature(app[0]).signTransaction({ transaction: wireTx() })).rejects.toEqual(rejected);
    expect(w.calls.length).toBe(0);
  });
});

describe("forged approval (G7 case)", () => {
  it("a page posting approvals on old sol-sign-preview tags and guessed ids never reaches the wallet", async () => {
    const r = rig(never, { timeoutMs: 300 });
    const app = startApp(r.win);
    const w = new FixtureWallet();
    registerWallet(r.win, w);
    const p = signFeature(app[0]).signTransaction({ transaction: wireTx() });
    // The page sees nothing of the channel; it tries every trick it can name.
    const id = randomId((a) => webcrypto.getRandomValues(a));
    for (const type of ["message", "sol-tx-inspector:content", HOOK_READY_EVENT, BRIDGE_READY_EVENT, decisionEventName(id)]) {
      r.win.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify({ v: 1, kind: "decision", id, allow: true }) }));
    }
    await expect(p).rejects.toEqual(rejected);
    expect(w.calls.length).toBe(0);
  });

  it("drops decisions that are not exactly the decision shape", async () => {
    const r = rig(never, { timeoutMs: 300 });
    const app = startApp(r.win);
    const w = new FixtureWallet();
    registerWallet(r.win, w);
    const p = signFeature(app[0]).signTransaction({ transaction: wireTx() });
    await Promise.resolve();
    const req = r.sent[0] as AnalyzeMessage;
    const ch = r.bridge!.channel;
    for (const detail of [
      { v: 1, kind: "decision", id: req.request.id, allow: "true" },
      { v: 1, kind: "decision", id: req.request.id, allow: true, extra: 1 },
      { v: 2, kind: "decision", id: req.request.id, allow: true }
    ]) {
      r.win.dispatchEvent(new CustomEvent(decisionEventName(ch), { detail: JSON.stringify(detail) }));
    }
    r.win.dispatchEvent(new CustomEvent(decisionEventName(ch), { detail: { v: 1, kind: "decision", id: req.request.id, allow: true } }));
    await expect(p).rejects.toEqual(rejected);
    expect(w.calls.length).toBe(0);
  });
});

describe("Wallet Standard", () => {
  it("register-wallet path: app present first; allow forwards identical bytes once", async () => {
    const r = rig(allow);
    const app = startApp(r.win);
    const w = new FixtureWallet();
    registerWallet(r.win, w);
    expect(app.length).toBe(1);
    expect(app[0]).not.toBe(w);
    const tx = wireTx(3);
    await signFeature(app[0]).signTransaction({ transaction: tx, chain: "solana:devnet", account: { address: "HH7x3VCwrHQKWHLy11TNd6zd3AL1VSzD2nLsAGgUaZez" } });
    expect(w.calls.length).toBe(1);
    expect(Array.from(w.calls[0]!)).toEqual(Array.from(tx));
    const m = r.sent[0] as AnalyzeMessage;
    expect(m.type).toBe(SW_ANALYZE);
    expect(m.request).toMatchObject({ method: "solana:signTransaction", wallet: "Fixture Wallet", account: "HH7x3VCwrHQKWHLy11TNd6zd3AL1VSzD2nLsAGgUaZez", chain: "solana:devnet", txs: [b64encode(tx)] });
    expect(m.url).toBe("https://dapp.example/");
  });

  it("app-ready path: wallet present first; block rejects with 4001 and the wallet is never called", async () => {
    const r = rig(block);
    const w = new FixtureWallet();
    registerWallet(r.win, w);
    const app = startApp(r.win);
    expect(app.length).toBe(1);
    await expect(signFeature(app[0]).signTransaction({ transaction: wireTx() })).rejects.toEqual(rejected);
    const sas = (app[0] as { features: Record<string, { signAndSendTransaction: (i: unknown) => Promise<unknown> }> }).features[
      "solana:signAndSendTransaction"
    ]!;
    await expect(sas.signAndSendTransaction({ transaction: wireTx(), chain: "solana:devnet" })).rejects.toEqual(rejected);
    expect(w.calls.length).toBe(0);
    expect(r.sent.map((m) => (m as AnalyzeMessage).request.method)).toEqual(["solana:signTransaction", "solana:signAndSendTransaction"]);
  });

  it("account is reported only when every input names the same address", async () => {
    const r = rig(block);
    const app = startApp(r.win);
    registerWallet(r.win, new FixtureWallet());
    const A = "HH7x3VCwrHQKWHLy11TNd6zd3AL1VSzD2nLsAGgUaZez";
    const B = "EZwZ2ZSo4E42DFwuvk4HuGUFCnkKom9e7ex7EBuCBd7o";
    const sign = signFeature(app[0]).signTransaction as (...i: unknown[]) => Promise<unknown>;
    await expect(sign({ transaction: wireTx(), account: { address: A } }, { transaction: wireTx(2), account: { address: B } })).rejects.toEqual(rejected);
    await expect(sign({ transaction: wireTx(), account: { address: A } }, { transaction: wireTx(2) })).rejects.toEqual(rejected);
    await expect(sign({ transaction: wireTx(), account: { address: 42 } })).rejects.toEqual(rejected);
    await expect(sign({ transaction: wireTx(), account: { address: A } }, { transaction: wireTx(2), account: { address: A } })).rejects.toEqual(rejected);
    expect(r.sent.map((m) => (m as AnalyzeMessage).request.account)).toEqual([null, null, null, A]);
  });

  it("forwards our private copy: mutating the page's array during the hold changes nothing", async () => {
    let release!: (v: unknown) => void;
    const r = rig(() => new Promise((res) => (release = res)));
    const app = startApp(r.win);
    const w = new FixtureWallet();
    registerWallet(r.win, w);
    const tx = wireTx(5);
    const orig = Array.from(tx);
    const p = signFeature(app[0]).signTransaction({ transaction: tx });
    await Promise.resolve();
    tx.fill(9);
    release({ allow: false, hold: true, level: 0, reason: "ok", report: null });
    await p;
    expect(Array.from(w.calls[0]!)).toEqual(orig);
  });

  it("times out to a block", async () => {
    const r = rig(never, { timeoutMs: 100 });
    const app = startApp(r.win);
    const w = new FixtureWallet();
    registerWallet(r.win, w);
    await expect(signFeature(app[0]).signTransaction({ transaction: wireTx() })).rejects.toEqual(rejected);
    expect(w.calls.length).toBe(0);
  });

  it("rejects input it cannot serialize instead of passing it through", async () => {
    const r = rig(allow);
    const app = startApp(r.win);
    const w = new FixtureWallet();
    registerWallet(r.win, w);
    await expect(signFeature(app[0]).signTransaction({ transaction: "not bytes" })).rejects.toEqual(rejected);
    expect(w.calls.length).toBe(0);
  });

  it("signMessage is held for review, then forwarded once with the same bytes", async () => {
    const r = rig(allow);
    const app = startApp(r.win);
    const w = new FixtureWallet();
    registerWallet(r.win, w);
    const f = (app[0] as { features: Record<string, { signMessage: (i: unknown) => Promise<unknown> }> }).features["solana:signMessage"]!;
    await f.signMessage({ message: new Uint8Array([104, 105]) });
    expect(w.messageCalls).toBe(1);
    expect(r.sent[0]).toMatchObject({ type: "kelvara-signguard/message", request: { method: "solana:signMessage", message: "aGk=" } });
  });

  it("wraps a frozen wallet with a frozen own features property", async () => {
    const r = rig(block);
    const calls: unknown[] = [];
    const wallet = Object.freeze({
      name: "Frozen",
      features: Object.freeze({
        "solana:signTransaction": Object.freeze({ version: "1.0.0", signTransaction: async (...i: unknown[]) => calls.push(...i) })
      })
    });
    const app = startApp(r.win);
    registerWallet(r.win, wallet);
    await expect(signFeature(app[0]).signTransaction({ transaction: wireTx() })).rejects.toEqual(rejected);
    expect(calls.length).toBe(0);
    expect((app[0] as { name: string }).name).toBe("Frozen");
  });
});

class FakeTx {
  constructor(public bytes: Uint8Array) {}
  serialize() {
    return this.bytes.slice();
  }
}

function legacyProvider(flag: string) {
  const calls: unknown[] = [];
  return {
    calls,
    provider: {
      [flag]: true,
      publicKey: null,
      async signTransaction(tx: unknown) {
        calls.push(tx);
        return tx;
      },
      async signAllTransactions(txs: unknown[]) {
        calls.push(...txs);
        return txs;
      },
      async signMessage(m: unknown) {
        calls.push(m);
        return { signature: new Uint8Array(64) };
      },
      async request(req: unknown) {
        calls.push(req);
        return {};
      }
    }
  };
}

describe("legacy providers", () => {
  it("window.solana assigned after the hook (late injection) is caught", async () => {
    const r = rig(block);
    const { provider, calls } = legacyProvider("isPhantom");
    (r.win as Record<string, unknown>).solana = provider;
    const s = (r.win as Record<string, unknown>).solana as typeof provider;
    await expect(s.signTransaction(new FakeTx(wireTx()))).rejects.toEqual(rejected);
    expect(calls.length).toBe(0);
    expect((r.sent[0] as AnalyzeMessage).request).toMatchObject({ method: "legacy:signTransaction", wallet: "Phantom", account: null, chain: null });
  });

  it("reports the connected account from publicKey (toBase58 or raw bytes) as a hint; junk is null", async () => {
    const r = rig(block);
    const { provider } = legacyProvider("isPhantom");
    (provider as Record<string, unknown>).publicKey = { toBase58: () => "HH7x3VCwrHQKWHLy11TNd6zd3AL1VSzD2nLsAGgUaZez" };
    (r.win as Record<string, unknown>).solana = provider;
    const s = (r.win as Record<string, unknown>).solana as typeof provider;
    await expect(s.signTransaction(new FakeTx(wireTx()))).rejects.toEqual(rejected);
    expect((r.sent[0] as AnalyzeMessage).request.account).toBe("HH7x3VCwrHQKWHLy11TNd6zd3AL1VSzD2nLsAGgUaZez");
    (provider as Record<string, unknown>).publicKey = new Uint8Array(32);
    await expect(s.signTransaction(new FakeTx(wireTx()))).rejects.toEqual(rejected);
    expect((r.sent[1] as AnalyzeMessage).request.account).toBe("11111111111111111111111111111111");
    (provider as Record<string, unknown>).publicKey = { toBase58: () => "not an address!" };
    await expect(s.signTransaction(new FakeTx(wireTx()))).rejects.toEqual(rejected);
    expect((r.sent[2] as AnalyzeMessage).request.account).toBeNull();
    (provider as Record<string, unknown>).publicKey = { toBase58: () => { throw new Error("x"); } };
    await expect(s.signTransaction(new FakeTx(wireTx()))).rejects.toEqual(rejected);
    expect((r.sent[3] as AnalyzeMessage).request.account).toBeNull();
  });

  it("window.phantom.solana, solflare and backpack are caught, before and after the hook", async () => {
    const win = makeWin();
    const early = legacyProvider("isSolflare");
    (win as Record<string, unknown>).solflare = early.provider;
    const { installBridge } = await import("../src/bridge/bridge.js");
    const { installHook } = await import("../src/hook/install.js");
    const sent: unknown[] = [];
    installBridge(win, {
      sendToWorker: async (m) => (sent.push(m), { allow: false, hold: false, level: 4, reason: "x", report: null }),
      url: () => "https://x/",
      topFrame: true,
      getRandomValues: (a) => webcrypto.getRandomValues(a)
    });
    installHook(win);
    const ph = legacyProvider("isPhantom");
    const bp = legacyProvider("isBackpack");
    (win as Record<string, unknown>).phantom = { solana: ph.provider };
    (win as Record<string, unknown>).backpack = bp.provider;
    const w = win as unknown as Record<string, { signTransaction?: (t: unknown) => Promise<unknown>; solana?: { signTransaction: (t: unknown) => Promise<unknown> } }>;
    await expect(w.solflare!.signTransaction!(wireTx())).rejects.toEqual(rejected);
    await expect(w.phantom!.solana!.signTransaction(wireTx())).rejects.toEqual(rejected);
    await expect(w.backpack!.signTransaction!(wireTx())).rejects.toEqual(rejected);
    expect(early.calls.length + ph.calls.length + bp.calls.length).toBe(0);
    expect(sent.length).toBe(3);
  });

  it("allow forwards; a transaction swapped during the hold is rejected", async () => {
    let release!: (v: unknown) => void;
    const r = rig(() => new Promise((res) => (release = res)));
    const { provider, calls } = legacyProvider("isPhantom");
    (r.win as Record<string, unknown>).solana = provider;
    const s = (r.win as Record<string, unknown>).solana as typeof provider;
    const tx = new FakeTx(wireTx(1));
    const p = s.signTransaction(tx);
    await Promise.resolve();
    tx.bytes = wireTx(2);
    release({ allow: false, hold: true, level: 0, reason: "ok", report: null });
    await expect(p).rejects.toEqual(rejected);
    expect(calls.length).toBe(0);

    const r2 = rig(allow);
    const l2 = legacyProvider("isPhantom");
    (r2.win as Record<string, unknown>).solana = l2.provider;
    const s2 = (r2.win as Record<string, unknown>).solana as typeof provider;
    const txs = [wireTx(1), wireTx(2)];
    await s2.signAllTransactions(txs);
    expect(l2.calls.length).toBe(2);
    expect((r2.sent[0] as AnalyzeMessage).request.txs.length).toBe(2);
  });

  it("Phantom request({ method: 'signTransaction', params: { message } }) is held", async () => {
    const r = rig(block);
    const { provider, calls } = legacyProvider("isPhantom");
    (r.win as Record<string, unknown>).solana = provider;
    const s = (r.win as Record<string, unknown>).solana as typeof provider;
    // base58 of a tiny legacy message: header 1,0,0 then zero keys
    await expect(s.request({ method: "signTransaction", params: { message: "LUw" } })).rejects.toEqual(rejected);
    await s.request({ method: "connect" });
    expect(calls.length).toBe(1);
  });

  it("wraps a frozen provider through a shim exposed by the window trap", async () => {
    const r = rig(block);
    const { provider, calls } = legacyProvider("isSolflare");
    (r.win as Record<string, unknown>).solflare = Object.freeze(provider);
    const s = (r.win as Record<string, unknown>).solflare as typeof provider;
    expect(s).not.toBe(provider);
    expect((s as Record<string, unknown>).isSolflare).toBe(true);
    await expect(s.signTransaction(wireTx())).rejects.toEqual(rejected);
    expect(calls.length).toBe(0);
  });
});
