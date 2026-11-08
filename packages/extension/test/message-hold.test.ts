// X17: message signing (signMessage / signIn) is held and reviewed; the wallet runs only after Continue.
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { installBridge } from "../src/bridge/bridge.js";
import { installHook } from "../src/hook/install.js";
import { b58encode } from "../src/shared/codec.js";
import { MAX_MESSAGE_BYTES, type MessageRequest } from "../src/shared/protocol.js";
import { messageVerdict, reviewMessage } from "../src/sw/message-review.js";
import { makeWin, registerWallet, startApp } from "./helpers.js";

const rejected = expect.objectContaining({ code: 4001 });
type Fn = (...a: unknown[]) => Promise<unknown>;

function rigMsg(opts: { timeoutMs?: number; fail?: boolean } = {}) {
  const win = makeWin();
  const reports: ((allow: boolean) => void)[] = [];
  const sent: MessageRequest[] = [];
  installBridge(win, {
    sendToWorker: async (m) => {
      if (opts.fail) throw new Error("sw restarted");
      if ("request" in m && m.request.kind === "message") {
        sent.push(m.request);
        return messageVerdict(reviewMessage(m.request, "https://dapp.example/"));
      }
      return null;
    },
    showReport: () => new Promise<boolean>((res) => reports.push(res)),
    url: () => "https://dapp.example/",
    topFrame: true,
    getRandomValues: (a) => webcrypto.getRandomValues(a)
  });
  installHook(win, { timeoutMs: opts.timeoutMs ?? 2000 });
  return { win, reports, sent, tick: () => new Promise((r) => setTimeout(r, 5)), g: win as unknown as Record<string, unknown> };
}

const text = (s: string) => new TextEncoder().encode(s);
const ACCOUNT = "HH7x3VCwrHQKWHLy11TNd6zd3AL1VSzD2nLsAGgUaZez";

function wsWallet(calls: unknown[][]) {
  return {
    name: "Fixture", version: "1.0.0", chains: ["solana:devnet"],
    accounts: [{ address: ACCOUNT }],
    features: {
      "solana:signMessage": { version: "1.0.0", signMessage: async (...a: unknown[]) => (calls.push(["ws:signMessage", ...a]), [{}]) },
      "solana:signIn": { version: "1.0.0", signIn: async (...a: unknown[]) => (calls.push(["ws:signIn", ...a]), [{}]) }
    }
  };
}
const ws = (app: unknown, k: string) => (app as { features: Record<string, Record<string, Fn>> }).features[k]!;

function legacy(calls: unknown[][]) {
  return {
    isPhantom: true,
    publicKey: null,
    signMessage: async (...a: unknown[]) => (calls.push(["signMessage", ...a]), {}),
    signIn: async (...a: unknown[]) => (calls.push(["signIn", ...a]), {}),
    request: async (...a: unknown[]) => (calls.push(["request", ...a]), {})
  };
}
type L = ReturnType<typeof legacy>;

const signIn = { domain: "dapp.example", uri: "https://dapp.example/login", version: "1", nonce: "abc12345", issuedAt: "2026-11-08T10:00:00.000Z", statement: "Sign in" };

type Case = { name: string; call: (r: ReturnType<typeof rigMsg>, calls: unknown[][]) => Promise<unknown>; expectCall: (calls: unknown[][]) => void };
const cases: Case[] = [
  {
    name: "Wallet Standard solana:signMessage",
    call: async (r, calls) => {
      const app = startApp(r.win);
      registerWallet(r.win, wsWallet(calls));
      return ws(app[0], "solana:signMessage").signMessage!({ account: { address: ACCOUNT }, message: text("hello") });
    },
    expectCall: (calls) => {
      expect(calls.length).toBe(1);
      const input = calls[0]![1] as { message: Uint8Array; account: { address: string } };
      expect(Array.from(input.message)).toEqual(Array.from(text("hello")));
      expect(input.account.address).toBe(ACCOUNT);
    }
  },
  {
    name: "Wallet Standard solana:signIn",
    call: async (r, calls) => {
      const app = startApp(r.win);
      registerWallet(r.win, wsWallet(calls));
      return ws(app[0], "solana:signIn").signIn!({ ...signIn });
    },
    expectCall: (calls) => expect(calls).toEqual([["ws:signIn", signIn]])
  },
  {
    name: "legacy signMessage",
    call: async (r, calls) => ((r.g.solana = legacy(calls)), (r.g.solana as L).signMessage(text("hello"), "utf8")),
    expectCall: (calls) => {
      expect(calls.length).toBe(1);
      expect(Array.from(calls[0]![1] as Uint8Array)).toEqual(Array.from(text("hello")));
      expect(calls[0]![2]).toBe("utf8");
    }
  },
  {
    name: "legacy signIn",
    call: async (r, calls) => ((r.g.solana = legacy(calls)), (r.g.solana as L).signIn({ ...signIn })),
    expectCall: (calls) => expect(calls).toEqual([["signIn", signIn]])
  },
  {
    name: "request({method:'signMessage'}) with bytes",
    call: async (r, calls) => ((r.g.solana = legacy(calls)), (r.g.solana as L).request({ method: "signMessage", params: { message: text("hello") } })),
    expectCall: (calls) => expect(calls.length).toBe(1)
  },
  {
    name: "request({method:'signMessage'}) with a base58 message",
    call: async (r, calls) => ((r.g.solana = legacy(calls)), (r.g.solana as L).request({ method: "signMessage", params: { message: b58encode(text("hello")) } })),
    expectCall: (calls) => expect(calls.length).toBe(1)
  },
  {
    name: "request({method:'signIn'})",
    call: async (r, calls) => ((r.g.solana = legacy(calls)), (r.g.solana as L).request({ method: "signIn", params: { ...signIn } })),
    expectCall: (calls) => expect(calls.length).toBe(1)
  }
];

describe("message signing: held until Continue", () => {
  for (const c of cases) {
    it(`${c.name}: wallet not called before Continue; once, identical arguments, after`, async () => {
      const r = rigMsg();
      const calls: unknown[][] = [];
      const pending = c.call(r, calls);
      await r.tick();
      expect(r.reports.length).toBe(1);
      expect(calls).toEqual([]);
      r.reports[0]!(true);
      await pending;
      c.expectCall(calls);
    });
    it(`${c.name}: Block -> 4001 and the wallet is never called`, async () => {
      const r = rigMsg();
      const calls: unknown[][] = [];
      const pending = c.call(r, calls);
      await r.tick();
      r.reports[0]!(false);
      await expect(pending).rejects.toEqual(rejected);
      expect(calls).toEqual([]);
    });
    it(`${c.name}: timeout -> 4001, a late Continue changes nothing`, async () => {
      const r = rigMsg({ timeoutMs: 60 });
      const calls: unknown[][] = [];
      await expect(c.call(r, calls)).rejects.toEqual(rejected);
      r.reports[0]!(true);
      await r.tick();
      expect(calls).toEqual([]);
    });
    it(`${c.name}: service worker failure during the hold -> 4001`, async () => {
      const r = rigMsg({ fail: true });
      const calls: unknown[][] = [];
      await expect(c.call(r, calls)).rejects.toEqual(rejected);
      expect(calls).toEqual([]);
    });
  }

  it("bytes edited during the hold: the worker saw the original, the call is rejected", async () => {
    const r = rigMsg();
    const calls: unknown[][] = [];
    r.g.solana = legacy(calls);
    const bytes = text("hello");
    const p = (r.g.solana as L).signMessage(bytes);
    await r.tick();
    bytes.fill(0);
    r.reports[0]!(true);
    await expect(p).rejects.toEqual(rejected);
    expect(r.sent[0]).toMatchObject({ method: "legacy:signMessage", message: "aGVsbG8=", signIn: null });
    expect(calls).toEqual([]);
  });

  it("request() arguments changed during the hold are rejected, not forwarded", async () => {
    const r = rigMsg();
    const calls: unknown[][] = [];
    r.g.solana = legacy(calls);
    const params = { message: text("hello") };
    const p = (r.g.solana as L).request({ method: "signMessage", params });
    await r.tick();
    params.message = text("send everything");
    r.reports[0]!(true);
    await expect(p).rejects.toEqual(rejected);
    expect(calls).toEqual([]);
  });

  it("two concurrent message requests: only the continued one reaches the wallet", async () => {
    const r = rigMsg();
    const calls: unknown[][] = [];
    r.g.solana = legacy(calls);
    const a = (r.g.solana as L).signMessage(text("a"));
    const b = (r.g.solana as L).signIn({ ...signIn });
    await r.tick();
    expect(r.reports.length).toBe(2);
    r.reports[0]!(false);
    r.reports[1]!(true);
    await expect(a).rejects.toEqual(rejected);
    await b;
    expect(calls.map((c) => c[0])).toEqual(["signIn"]);
  });

  it("signIn without a domain forwards the original input; the worker sees the page host as default", async () => {
    const r = rigMsg();
    const calls: unknown[][] = [];
    const app = startApp(r.win);
    registerWallet(r.win, wsWallet(calls));
    const p = ws(app[0], "solana:signIn").signIn!();
    await r.tick();
    r.reports[0]!(true);
    await p;
    expect(calls).toEqual([["ws:signIn"]]);
    expect(r.sent[0]).toMatchObject({ method: "solana:signIn", account: ACCOUNT, signIn: {} });
  });

  it.each([
    ["empty message", () => new Uint8Array(0)],
    ["oversized message", () => new Uint8Array(MAX_MESSAGE_BYTES + 1)],
    ["a string instead of bytes", () => "hello" as unknown as Uint8Array]
  ])("legacy signMessage with %s is rejected without a hold", async (_n, make) => {
    const r = rigMsg();
    const calls: unknown[][] = [];
    r.g.solana = legacy(calls);
    await expect((r.g.solana as L).signMessage(make())).rejects.toEqual(rejected);
    expect(calls).toEqual([]);
    expect(r.reports.length).toBe(0);
  });

  it.each([
    ["an unknown key", { ...signIn, extra: "x" }],
    ["a non-string field", { ...signIn, nonce: 5 }],
    ["an over-long field", { ...signIn, statement: "x".repeat(3000) }],
    ["bad resources", { ...signIn, resources: "not a list" }]
  ])("signIn with %s is rejected without a hold", async (_n, input) => {
    const r = rigMsg();
    const calls: unknown[][] = [];
    r.g.solana = legacy(calls);
    await expect((r.g.solana as L).signIn(input)).rejects.toEqual(rejected);
    expect(calls).toEqual([]);
    expect(r.reports.length).toBe(0);
  });

  it("several inputs in one Wallet Standard call are rejected (one reviewed message per call)", async () => {
    const r = rigMsg();
    const calls: unknown[][] = [];
    const app = startApp(r.win);
    registerWallet(r.win, wsWallet(calls));
    await expect(ws(app[0], "solana:signMessage").signMessage!({ message: text("a") }, { message: text("b") })).rejects.toEqual(rejected);
    await expect(ws(app[0], "solana:signIn").signIn!({ ...signIn }, { ...signIn })).rejects.toEqual(rejected);
    expect(calls).toEqual([]);
  });
});
