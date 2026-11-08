// X16: the real wallet is invoked only after a verified Continue, exactly once, with the analyzed bytes.
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { installBridge } from "../src/bridge/bridge.js";
import { installHook } from "../src/hook/install.js";
import { b58encode } from "../src/shared/codec.js";
import { AppReadyEvent, makeWin, registerWallet, startApp, wireTx } from "./helpers.js";

const rejected = expect.objectContaining({ code: 4001 });
const holdVerdict = { allow: false, hold: true, level: 2, reason: "review", report: null };
type Fn = (...a: unknown[]) => Promise<unknown>;

/** A report the test resolves by hand: the user's Continue/Block. */
function rigHeld(opts: { timeoutMs?: number; worker?: () => Promise<unknown> } = {}) {
  const win = makeWin();
  const reports: ((allow: boolean) => void)[] = [];
  installBridge(win, {
    sendToWorker: opts.worker ?? (async () => holdVerdict),
    showReport: () => new Promise<boolean>((res) => reports.push(res)),
    url: () => "https://dapp.example/",
    topFrame: true,
    getRandomValues: (a) => webcrypto.getRandomValues(a)
  });
  installHook(win, { timeoutMs: opts.timeoutMs ?? 2000 });
  const tick = () => new Promise((r) => setTimeout(r, 5));
  return { win, reports, tick, g: win as unknown as Record<string, unknown> };
}

function wsWallet(log: string[], bytes: Uint8Array[]) {
  const hit = (n: string) => async (...inputs: { transaction?: Uint8Array }[]) => {
    log.push(n);
    for (const i of inputs) if (i.transaction) bytes.push(i.transaction);
    return inputs.map(() => ({}));
  };
  return {
    name: "Fixture",
    version: "1.0.0",
    chains: ["solana:devnet"],
    accounts: [],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => { log.push("connect"); return { accounts: [] }; } },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signTransaction": { version: "1.0.0", signTransaction: hit("solana:signTransaction") },
      "solana:signAndSendTransaction": { version: "1.0.0", signAndSendTransaction: hit("solana:signAndSendTransaction") },
      "solana:signMessage": { version: "1.0.0", signMessage: hit("solana:signMessage") },
      "solana:signIn": { version: "1.0.0", signIn: hit("solana:signIn") },
      "phantom:signAllAndSend": { version: "1.0.0", doIt: hit("phantom:signAllAndSend") },
      "vendor:ops": { version: "1.0.0", approveThing: hit("vendor:approveThing"), label: () => "x" },
      "vendor:signBatch": { version: "1.0.0", run: hit("vendor:signBatch.run") },
      "vendor:info": { version: "1.0.0", describe: async () => { log.push("vendor:info"); return "ok"; } }
    }
  };
}
const feat = (w: unknown, k: string) => (w as { features: Record<string, Record<string, Fn>> }).features[k]!;

describe("Wallet Standard: held until Continue", () => {
  for (const [key, fn] of [["solana:signTransaction", "signTransaction"], ["solana:signAndSendTransaction", "signAndSendTransaction"]] as const) {
    it(`${key}: wallet not called before Continue, then exactly once with identical bytes`, async () => {
      const r = rigHeld();
      const app = startApp(r.win);
      const log: string[] = [];
      const bytes: Uint8Array[] = [];
      registerWallet(r.win, wsWallet(log, bytes));
      const tx = wireTx(3);
      const orig = Array.from(tx);
      const pending = feat(app[0], key)[fn]!({ transaction: tx }, { transaction: wireTx(4) });
      await r.tick();
      expect(r.reports.length).toBe(1);
      expect(log).toEqual([]);
      tx.fill(0);
      r.reports[0]!(true);
      await pending;
      expect(log).toEqual([key]);
      expect(Array.from(bytes[0]!)).toEqual(orig);
      expect(bytes.length).toBe(2);
    });
    it(`${key}: Block rejects with 4001 and the wallet is never called`, async () => {
      const r = rigHeld();
      const app = startApp(r.win);
      const log: string[] = [];
      registerWallet(r.win, wsWallet(log, []));
      const pending = feat(app[0], key)[fn]!({ transaction: wireTx() });
      await r.tick();
      r.reports[0]!(false);
      await expect(pending).rejects.toEqual(rejected);
      expect(log).toEqual([]);
    });
  }

  it("timeout rejects; a late Continue after the deadline never reaches the wallet", async () => {
    const r = rigHeld({ timeoutMs: 60 });
    const app = startApp(r.win);
    const log: string[] = [];
    registerWallet(r.win, wsWallet(log, []));
    const pending = feat(app[0], "solana:signTransaction").signTransaction!({ transaction: wireTx() });
    await expect(pending).rejects.toEqual(rejected);
    r.reports[0]!(true);
    await r.tick();
    expect(log).toEqual([]);
  });

  it("service worker failure during the hold blocks", async () => {
    const r = rigHeld({ worker: () => Promise.reject(new Error("worker restarted")) });
    const app = startApp(r.win);
    const log: string[] = [];
    registerWallet(r.win, wsWallet(log, []));
    await expect(feat(app[0], "solana:signAndSendTransaction").signAndSendTransaction!({ transaction: wireTx() })).rejects.toEqual(rejected);
    expect(log).toEqual([]);
  });

  it("page navigation during the hold: the call never settles and the wallet is never called", async () => {
    const r = rigHeld();
    const app = startApp(r.win);
    const log: string[] = [];
    registerWallet(r.win, wsWallet(log, []));
    void feat(app[0], "solana:signTransaction").signTransaction!({ transaction: wireTx() });
    await r.tick();
    expect(r.reports.length).toBe(1); // user never answers: the page is gone
    expect(log).toEqual([]);
  });

  it("two concurrent requests: only the continued one reaches the wallet, each exactly once", async () => {
    const r = rigHeld();
    const app = startApp(r.win);
    const log: string[] = [];
    const bytes: Uint8Array[] = [];
    registerWallet(r.win, wsWallet(log, bytes));
    const a = feat(app[0], "solana:signTransaction").signTransaction!({ transaction: wireTx(1) });
    const b = feat(app[0], "solana:signAndSendTransaction").signAndSendTransaction!({ transaction: wireTx(2) });
    await r.tick();
    expect(r.reports.length).toBe(2);
    expect(log).toEqual([]);
    r.reports[1]!(true);
    r.reports[0]!(false);
    await b;
    await expect(a).rejects.toEqual(rejected);
    expect(log).toEqual(["solana:signAndSendTransaction"]);
    expect(Array.from(bytes[0]!)).toEqual(Array.from(wireTx(2)));
  });

  it("wallet registered before the app (register first, app-ready later) is held", async () => {
    const r = rigHeld();
    const log: string[] = [];
    const wallet = wsWallet(log, []);
    registerWallet(r.win, wallet);
    const app = startApp(r.win);
    const pending = feat(app[0], "solana:signTransaction").signTransaction!({ transaction: wireTx() });
    await r.tick();
    expect(log).toEqual([]);
    r.reports[0]!(true);
    await pending;
    expect(log).toEqual(["solana:signTransaction"]);
  });

  it("wallet re-registering after the app is wrapped too", async () => {
    const r = rigHeld();
    const app = startApp(r.win);
    const log: string[] = [];
    const wallet = wsWallet(log, []);
    registerWallet(r.win, wallet);
    registerWallet(r.win, { ...wallet, name: "Again" });
    r.win.dispatchEvent(new AppReadyEvent(Object.freeze({ register: (...ws: unknown[]) => void app.push(...ws) })));
    for (const w of app) {
      const p = feat(w, "solana:signTransaction").signTransaction!({ transaction: wireTx() });
      await r.tick();
      expect(log).toEqual([]);
      r.reports.pop()!(false);
      await expect(p).rejects.toEqual(rejected);
    }
  });

  it.each([
    ["phantom:signAllAndSend", "doIt", {}],
    ["vendor:ops", "approveThing", {}],
    ["vendor:signBatch", "run", {}]
  ] as const)("%s.%s is blocked fail-closed: the wallet is never called, no report is needed", async (key, fn, input) => {
    const r = rigHeld();
    const app = startApp(r.win);
    const log: string[] = [];
    registerWallet(r.win, wsWallet(log, []));
    await expect(feat(app[0], key)[fn]!(input)).rejects.toEqual(rejected);
    expect(log).toEqual([]);
  });

  it("standard:connect, standard:events and non-signing vendor features still pass", async () => {
    const r = rigHeld();
    const app = startApp(r.win);
    const log: string[] = [];
    registerWallet(r.win, wsWallet(log, []));
    await feat(app[0], "standard:connect").connect!();
    expect(await feat(app[0], "vendor:info").describe!()).toBe("ok");
    expect(typeof feat(app[0], "vendor:ops").label).toBe("function");
    expect(log).toEqual(["connect", "vendor:info"]);
  });
});

class FakeTx {
  constructor(public bytes: Uint8Array) {}
  serialize() {
    return this.bytes.slice();
  }
}
function legacy(log: string[], bytes: unknown[]) {
  const hit = (n: string) => async (...args: unknown[]) => {
    log.push(n);
    bytes.push(args[0]);
    return {};
  };
  return {
    isPhantom: true,
    publicKey: null,
    signTransaction: hit("signTransaction"),
    signAllTransactions: hit("signAllTransactions"),
    signAndSendTransaction: hit("signAndSendTransaction"),
    signAndSendAllTransactions: hit("signAndSendAllTransactions"),
    sendTransaction: hit("sendTransaction"),
    signMessage: hit("signMessage"),
    signIn: hit("signIn"),
    signAndSendTransactionV0: hit("signAndSendTransactionV0"),
    connect: async () => { log.push("connect"); return {}; },
    request: async (req: unknown) => { log.push(`request:${(req as { method: string }).method}`); return {}; }
  };
}
type Legacy = ReturnType<typeof legacy>;
const sol = (r: { g: Record<string, unknown> }) => r.g.solana as Legacy & Record<string, Fn>;
const b58 = (b: Uint8Array) => b58encode(b);

describe("legacy providers: held until Continue", () => {
  const txCases: [string, (s: Legacy & Record<string, Fn>, tx: Uint8Array) => Promise<unknown>][] = [
    ["signTransaction", (s, tx) => s.signTransaction(new FakeTx(tx))],
    ["signAllTransactions", (s, tx) => s.signAllTransactions([new FakeTx(tx)])],
    ["signAndSendTransaction", (s, tx) => s.signAndSendTransaction(new FakeTx(tx))],
    ["signAndSendAllTransactions", (s, tx) => s.signAndSendAllTransactions([new FakeTx(tx)])],
    ["sendTransaction", (s, tx) => s.sendTransaction(new FakeTx(tx))],
    ["request:signTransaction", (s, tx) => s.request({ method: "signTransaction", params: { transaction: tx } })],
    ["request:signAndSendTransaction", (s, tx) => s.request({ method: "signAndSendTransaction", params: { transaction: tx } })],
    ["request:signAllTransactions", (s, tx) => s.request({ method: "signAllTransactions", params: { transactions: [tx] } })],
    ["request:signAndSendAllTransactions", (s, tx) => s.request({ method: "signAndSendAllTransactions", params: { transactions: [tx] } })],
    ["request:sendTransaction", (s, tx) => s.request({ method: "sendTransaction", params: { transaction: tx } })]
  ];
  for (const [name, call] of txCases) {
    it(`${name}: wallet not called before Continue, then exactly once`, async () => {
      const r = rigHeld();
      const log: string[] = [];
      r.g.solana = legacy(log, []);
      const pending = call(sol(r), wireTx(5));
      await r.tick();
      expect(r.reports.length).toBe(1);
      expect(log).toEqual([]);
      r.reports[0]!(true);
      await pending;
      expect(log.length).toBe(1);
    });
    it(`${name}: Block -> 4001, wallet count 0`, async () => {
      const r = rigHeld();
      const log: string[] = [];
      r.g.solana = legacy(log, []);
      const pending = call(sol(r), wireTx(5));
      await r.tick();
      r.reports[0]!(false);
      await expect(pending).rejects.toEqual(rejected);
      expect(log).toEqual([]);
    });
  }

  it("signTransaction forwards identical bytes after Continue", async () => {
    const r = rigHeld();
    const log: string[] = [];
    const seen: unknown[] = [];
    r.g.solana = legacy(log, seen);
    const tx = wireTx(6);
    const orig = Array.from(tx);
    const pending = sol(r).signTransaction(tx);
    await r.tick();
    r.reports[0]!(true);
    await pending;
    expect(Array.from(seen[0] as Uint8Array)).toEqual(orig);
  });

  it.each([
    ["signAndSendTransactionV0 (unknown signing-named method)", (s: Legacy & Record<string, Fn>) => s.signAndSendTransactionV0(wireTx())],
    ["request:vendorApproveSomething", (s: Legacy & Record<string, Fn>) => s.request({ method: "vendorApproveSomething" })],
    ["request without a method name that can be analyzed", (s: Legacy & Record<string, Fn>) => s.request({ method: "signTransaction", params: {} })]
  ])("%s is blocked fail-closed and never reaches the wallet", async (_n, call) => {
    const r = rigHeld();
    const log: string[] = [];
    r.g.solana = legacy(log, []);
    await expect(call(sol(r))).rejects.toEqual(rejected);
    expect(log).toEqual([]);
    expect(r.reports.length).toBe(0);
  });

  it("connect and request({method:'connect'}) pass", async () => {
    const r = rigHeld();
    const log: string[] = [];
    r.g.solana = legacy(log, []);
    await sol(r).connect();
    await sol(r).request({ method: "connect" });
    expect(log).toEqual(["connect", "request:connect"]);
  });

  it("Phantom request({method:'signTransaction', params:{message}}) with base58 message is held", async () => {
    const r = rigHeld();
    const log: string[] = [];
    r.g.solana = legacy(log, []);
    const msg = b58(Uint8Array.from([1, 0, 0, 0]));
    const pending = sol(r).request({ method: "signTransaction", params: { message: msg } }).catch(() => "x");
    await r.tick();
    expect(log).toEqual([]);
    r.reports[0]?.(false);
    await pending;
    expect(log).toEqual([]);
  });

  it("prototype-level bypass (Class.prototype.signTransaction.call(provider, tx)) is held too", async () => {
    const r = rigHeld();
    const log: string[] = [];
    class P {
      isPhantom = true;
      publicKey = null;
      async signTransaction(tx: unknown) { log.push("signTransaction"); return tx; }
      async signMessage(...a: unknown[]) { log.push(`signMessage${a.length}`); return {}; }
    }
    const inst = new P();
    r.g.solana = inst;
    const proto = Object.getPrototypeOf(sol(r)) as P;
    const pending = proto.signTransaction.call(inst, new FakeTx(wireTx(7)));
    await r.tick();
    expect(r.reports.length).toBe(1);
    expect(log).toEqual([]);
    r.reports[0]!(true);
    await pending;
    expect(log).toEqual(["signTransaction"]);
    const m = proto.signMessage.call(inst, new Uint8Array([1])).catch(() => "x");
    await r.tick();
    expect(log).toEqual(["signTransaction"]);
    r.reports[1]!(false);
    await m;
    expect(log).toEqual(["signTransaction"]);
  });

  it("pristine reference captured by the dApp after wrapping still goes through the hold", async () => {
    const r = rigHeld();
    const log: string[] = [];
    r.g.solana = legacy(log, []);
    const captured = sol(r).signTransaction;
    const pending = captured.call(r.g.solana, wireTx(8));
    await r.tick();
    expect(log).toEqual([]);
    r.reports[0]!(true);
    await pending;
    expect(log).toEqual(["signTransaction"]);
  });

  it.each(["solflare", "backpack", "braveSolana"])("late window.%s is held", async (key) => {
    const r = rigHeld();
    const log: string[] = [];
    r.g[key] = legacy(log, []);
    const s = r.g[key] as Legacy;
    const pending = s.signTransaction(wireTx(9));
    await r.tick();
    expect(log).toEqual([]);
    r.reports[0]!(true);
    await pending;
    expect(log).toEqual(["signTransaction"]);
  });

  it.each([["phantom", "solana"], ["glow", "solana"], ["exodus", "solana"], ["coin98", "sol"], ["okxwallet", "solana"], ["trustwallet", "solana"]])(
    "late window.%s.%s is held",
    async (holder, key) => {
      const r = rigHeld();
      const log: string[] = [];
      r.g[holder] = { [key]: legacy(log, []) };
      const s = (r.g[holder] as Record<string, Legacy>)[key]!;
      const pending = s.signAllTransactions([wireTx(9)]);
      await r.tick();
      expect(log).toEqual([]);
      r.reports[0]!(true);
      await pending;
      expect(log).toEqual(["signAllTransactions"]);
    }
  );

  it("second legacy request while one is held is independent; wallet sees only the continued one", async () => {
    const r = rigHeld();
    const log: string[] = [];
    r.g.solana = legacy(log, []);
    const a = sol(r).signTransaction(wireTx(1));
    const b = sol(r).signAndSendTransaction(wireTx(2));
    await r.tick();
    expect(r.reports.length).toBe(2);
    r.reports[0]!(false);
    r.reports[1]!(true);
    await expect(a).rejects.toEqual(rejected);
    await b;
    expect(log).toEqual(["signAndSendTransaction"]);
  });

  it("legacy timeout and worker failure block", async () => {
    const r = rigHeld({ timeoutMs: 60 });
    const log: string[] = [];
    r.g.solana = legacy(log, []);
    await expect(sol(r).signTransaction(wireTx())).rejects.toEqual(rejected);
    r.reports[0]!(true);
    const r2 = rigHeld({ worker: () => Promise.reject(new Error("sw gone")) });
    r2.g.solana = legacy(log, []);
    await expect(sol(r2).signTransaction(wireTx())).rejects.toEqual(rejected);
    await r.tick();
    expect(log).toEqual([]);
  });
});
