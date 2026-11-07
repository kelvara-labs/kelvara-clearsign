import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { installBridge } from "../src/bridge/bridge.js";
import { b58decode, b58encode, b64encode, messageToWireTx, wireMessage } from "../src/shared/codec.js";
import { decisionEventName, requestEventName, SW_ANALYZE, SW_DECIDED, type WorkerVerdict } from "../src/shared/protocol.js";
import { rankedCapabilities, validateReportView, type ReportView } from "../src/shared/report-view.js";
import { buttonsFor, HOLD_MS, HoldGesture, MIN_VISIBLE_MS, reportMode, VisibilityGate } from "../src/report/model.js";
import { parseFrameAnswer } from "../src/report/overlay.js";
import { stubEngine } from "../src/sw/engine-stub.js";
import { decide, messageHashes } from "../src/sw/policy.js";
import { makeWin } from "./helpers.js";

const base = { allow: false, hold: false, reason: "r", report: null };
const v = (level: WorkerVerdict["level"], over: Partial<WorkerVerdict> = {}): WorkerVerdict => ({ ...base, level, ...over });

const view: ReportView = {
  title: "Upgrade authority passes to a key outside the session",
  summary: "s",
  simulation: "0 tokens move",
  authorizes: "control of program X",
  capabilities: [
    { rank: 2, change: "revoked", authority: "upgrade authority of X", holder: "you", risk: "high" },
    { rank: 1, change: "granted", authority: "upgrade authority of X", holder: "Attacker111", risk: "critical" }
  ],
  preview: [{ authority: "upgrade authority of X", confidence: "verified", can: [{ name: "can deploy any code", detail: "" }] }],
  claims: [{ id: "c1", kind: "Fact", text: "t", evidence: ["e1"] }],
  messageHashes: ["11111111111111111111111111111111"],
  limited: false
};

describe("per-level behavior (PLAN M5)", () => {
  it("L4 and failures: report only, modal, no Sign anyway element", () => {
    expect(reportMode(v(4))).toBe("info");
    expect(reportMode(v(null))).toBe("info");
    expect(buttonsFor(v(4))).toEqual({ block: "Dismiss", signAnyway: null, modal: true });
    expect(buttonsFor(v(null)).signAnyway).toBeNull();
  });
  it("L3 holds with hold-to-confirm; L2 holds with a plain Sign anyway", () => {
    expect(buttonsFor(v(3, { hold: true }))).toEqual({ block: "Block", signAnyway: { holdMs: HOLD_MS }, modal: true });
    expect(buttonsFor(v(2, { hold: true }))).toEqual({ block: "Block", signAnyway: { holdMs: null }, modal: true });
  });
  it("L1 small non-modal notice, L0 and pass-through silent", () => {
    expect(reportMode(v(1, { allow: true }))).toBe("notice");
    expect(buttonsFor(v(1, { allow: true })).modal).toBe(false);
    expect(reportMode(v(0, { allow: true }))).toBe("silent");
    expect(reportMode(v(null, { allow: true }))).toBe("silent");
  });
  it("a held flag above L3 or below L2 is never a hold", () => {
    expect(reportMode(v(4, { hold: true }))).toBe("info");
    expect(reportMode(v(1, { hold: true }))).toBe("info");
  });
});

describe("hold to confirm and visibility gate", () => {
  it("a plain click never confirms; a full hold does; release resets", () => {
    const g = new HoldGesture(HOLD_MS);
    g.press(0);
    expect(g.done(150)).toBe(false);
    g.cancel();
    expect(g.done(HOLD_MS + 10)).toBe(false);
    g.press(1000);
    g.press(1500); // a second press does not restart the clock
    expect(g.done(1000 + HOLD_MS - 1)).toBe(false);
    expect(g.done(1000 + HOLD_MS)).toBe(true);
  });
  it("opens only after the report has been visible MIN_VISIBLE_MS; occlusion or no IOv2 closes it", () => {
    const gate = new VisibilityGate();
    expect(gate.open(10_000)).toBe(false);
    gate.update(undefined, 0); // browser without IntersectionObserver v2
    expect(gate.open(10_000)).toBe(false);
    gate.update(true, 100);
    expect(gate.open(100 + MIN_VISIBLE_MS - 1)).toBe(false);
    expect(gate.open(100 + MIN_VISIBLE_MS)).toBe(true);
    gate.update(true, 900); // still visible: keeps the original start
    expect(gate.open(100 + MIN_VISIBLE_MS)).toBe(true);
    gate.update(false, 1000);
    expect(gate.open(5000)).toBe(false);
  });
});

describe("report view contract", () => {
  it("accepts a full view and ranks capabilities, most dangerous first", () => {
    expect(validateReportView(view)).not.toBeNull();
    expect(rankedCapabilities(view).map((c) => c.rank)).toEqual([1, 2]);
  });
  it("rejects extra keys, bad enums, oversize text and non-base58 hashes", () => {
    expect(validateReportView({ ...view, extra: 1 })).toBeNull();
    expect(validateReportView({ ...view, claims: [{ ...view.claims[0], kind: "Safe" }] })).toBeNull();
    expect(validateReportView({ ...view, title: "x".repeat(201) })).toBeNull();
    expect(validateReportView({ ...view, messageHashes: ["0OIl".repeat(10)] })).toBeNull();
    expect(validateReportView({ ...view, capabilities: [{ ...view.capabilities[0], rank: 0 }] })).toBeNull();
  });
  it("frame answers are exactly { allow: boolean }", () => {
    expect(parseFrameAnswer({ allow: true })).toBe(true);
    expect(parseFrameAnswer({ allow: false })).toBe(false);
    expect(parseFrameAnswer({ allow: "true" })).toBeNull();
    expect(parseFrameAnswer({ allow: true, secret: "x" })).toBeNull();
    expect(parseFrameAnswer([true])).toBeNull();
  });
});

describe("message hash (match on a Ledger)", () => {
  it("base58 round-trips known vectors", () => {
    expect(b58encode(new TextEncoder().encode("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
    expect(b58encode(new Uint8Array([0, 0, 0x28, 0x7f, 0xb4, 0xcd]))).toBe("11233QC4");
    expect(b58encode(new Uint8Array(32))).toBe("1".repeat(32));
    const r = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
    expect(Array.from(b58decode(b58encode(r)))).toEqual(Array.from(r));
  });
  it("is base58(sha256(message)), skipping the signatures", async () => {
    const msg = new Uint8Array([2, 1, 1, 0, 5, 9, 9]);
    const wire = messageToWireTx(msg);
    expect(Array.from(wireMessage(wire))).toEqual(Array.from(msg));
    const expected = b58encode(createHash("sha256").update(msg).digest());
    expect(await messageHashes([b64encode(wire)])).toEqual([expected]);
  });
  it("a wire tx with no message is refused", () => {
    expect(() => wireMessage(new Uint8Array([1, ...new Array(64).fill(0)]))).toThrow();
    expect(() => wireMessage(new Uint8Array([0, 1, 2]))).toThrow();
  });
});

describe("stub engine through decide()", () => {
  it("holds at L2 with an Unknown claim and the message hash; never claims safe", async () => {
    const wire = b64encode(messageToWireTx(new Uint8Array([1, 0, 0, 0])));
    const req = { v: 1, kind: "sign", id: "0".repeat(32), method: "solana:signTransaction", wallet: "W", chain: "solana:localnet", txs: [wire] } as const;
    const out = await decide(req as never, { network: "mainnet", passThrough: false }, stubEngine);
    expect(out).toMatchObject({ allow: false, hold: true, level: 2 });
    expect(out.report?.claims.map((c) => c.kind)).toEqual(["Unknown"]);
    expect(out.report?.messageHashes).toHaveLength(1);
  });
});

describe("bridge: held requests go to the report UI", () => {
  async function run(verdict: WorkerVerdict, showReport?: (v: WorkerVerdict, deadline: number) => Promise<boolean>) {
    const win = makeWin();
    const sent: unknown[] = [];
    const bridge = installBridge(win, {
      sendToWorker: async (m) => {
        sent.push(m);
        return m.type === SW_ANALYZE ? verdict : undefined;
      },
      url: () => "https://dapp.example/",
      topFrame: true,
      getRandomValues: (a) => crypto.getRandomValues(a),
      now: () => 1000,
      ...(showReport ? { showReport } : {})
    });
    win.dispatchEvent(new CustomEvent("kelvara-signguard:hook-ready"));
    const reqId = "ab".repeat(16);
    const decided = new Promise<boolean>((resolve) =>
      win.addEventListener(decisionEventName(bridge.channel), (e) => resolve(JSON.parse((e as CustomEvent).detail).allow))
    );
    win.dispatchEvent(
      new CustomEvent(requestEventName(bridge.channel), {
        detail: JSON.stringify({ v: 1, kind: "sign", id: reqId, method: "solana:signTransaction", wallet: "W", chain: null, txs: ["AQID"] })
      })
    );
    const allow = await decided;
    await new Promise((r) => setTimeout(r, 0));
    return { allow, sent, reqId };
  }

  it("held: the user's choice decides, the deadline is arrival + 90 s, and the worker hears the choice", async () => {
    const show = vi.fn(async () => true);
    const r = await run(v(3, { hold: true, report: view }), show);
    expect(r.allow).toBe(true);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ level: 3 }), 1000 + 90_000);
    expect(r.sent).toContainEqual({ type: SW_DECIDED, id: r.reqId, allow: true });
    expect((await run(v(2, { hold: true }), async () => false)).allow).toBe(false);
  });
  it("held without a report UI, or the UI failing, is blocked", async () => {
    expect((await run(v(3, { hold: true }))).allow).toBe(false);
    expect((await run(v(3, { hold: true }), async () => Promise.reject(new Error("frame gone")))).allow).toBe(false);
  });
  it("L4 is rejected at once and the report is shown; a UI saying allow cannot change it", async () => {
    const show = vi.fn(async () => true);
    const r = await run(v(4, { report: view }), show);
    expect(r.allow).toBe(false);
    expect(show).toHaveBeenCalledTimes(1);
    expect(r.sent.some((m) => (m as { type: string }).type === SW_DECIDED)).toBe(false);
  });
  it("L1 passes with a notice; L0 passes silently", async () => {
    const show = vi.fn(async () => false);
    expect((await run(v(1, { allow: true }), show)).allow).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
    const silent = vi.fn(async () => false);
    expect((await run(v(0, { allow: true }), silent)).allow).toBe(true);
    expect(silent).not.toHaveBeenCalled();
  });
});
