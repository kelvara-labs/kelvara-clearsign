import { describe, expect, it } from "vitest";
import { b64encode } from "../src/shared/codec.js";
import { validateMessageReview } from "../src/shared/message-view.js";
import { validateMessageRequest, validateWorkerVerdict, type MessageRequest, type SignInInput } from "../src/shared/protocol.js";
import { validateReportView } from "../src/shared/report-view.js";
import { MESSAGE_RULES, defaultDeps, formatSiws, messageVerdict, parseSiws, reviewMessage } from "../src/sw/message-review.js";
import { MINIMAL_MESSAGE } from "./helpers.js";

const wire = Uint8Array.from([1, ...new Uint8Array(64), ...MINIMAL_MESSAGE]);

const ACCOUNT = "HH7x3VCwrHQKWHLy11TNd6zd3AL1VSzD2nLsAGgUaZez";
const OTHER = "11111111111111111111111111111111";
const URL = "https://dapp.example/app";
const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const deps = { ...defaultDeps, now: () => NOW };
const id = "0123456789abcdef0123456789abcdef";

const msg = (bytes: Uint8Array, extra: Partial<MessageRequest> = {}): MessageRequest => ({ v: 1, kind: "message", id, method: "solana:signMessage", wallet: "W", account: ACCOUNT, chain: null, message: b64encode(bytes), signIn: null, ...extra });
const text = (s: string) => new TextEncoder().encode(s);
const signIn = (input: SignInInput, extra: Partial<MessageRequest> = {}): MessageRequest => ({ v: 1, kind: "message", id, method: "solana:signIn", wallet: "W", account: ACCOUNT, chain: null, message: null, signIn: input, ...extra });
const good: SignInInput = { domain: "dapp.example", address: ACCOUNT, statement: "Welcome", uri: "https://dapp.example/login", version: "1", chainId: "mainnet", nonce: "abcd1234", issuedAt: "2026-11-08T11:59:00.000Z", expirationTime: "2026-11-08T13:00:00.000Z" };
const review = (r: MessageRequest) => reviewMessage(r, URL, deps);
const rulesOf = (r: MessageRequest) => review(r).findings.map((f) => f.rule);

describe("message review rules", () => {
  it("message.text: readable text -> L1, shows the full text", () => {
    const r = review(msg(text("Please confirm you own this account.")));
    expect(r).toMatchObject({ kind: "text", rule: "message.text", text: "Please confirm you own this account.", origin: "dapp.example", truncated: false });
    expect(messageVerdict(r)).toMatchObject({ allow: false, hold: true, level: 1, reason: "Message signature" });
  });

  it("message.binary: non-UTF-8 bytes -> L3, content not shown", () => {
    const r = review(msg(Uint8Array.from([0xff, 0xfe, 0x00, 0x01])));
    expect(r).toMatchObject({ kind: "binary", rule: "message.binary", text: null, size: 4 });
    expect(messageVerdict(r)).toMatchObject({ hold: true, level: 3, reason: "Unreadable binary message" });
  });

  it("message.binary: control characters make text unreadable", () => {
    expect(review(msg(text("ok\u0000hidden"))).kind).toBe("binary");
  });

  it("message.hidden-tx: a serialized transaction passed as a message -> L4, no hold", () => {
    const r = review(msg(wire));
    expect(r).toMatchObject({ kind: "hidden-tx", rule: "message.hidden-tx", text: null });
    expect(messageVerdict(r)).toMatchObject({ allow: false, hold: false, level: 4, reason: "Hidden transaction in a message signature" });
  });

  it("ordinary text and SIWS text are not mistaken for transactions", () => {
    for (const t of ["hello", "x".repeat(300), formatSiws(good, "dapp.example")]) expect(review(msg(text(t))).kind).not.toBe("hidden-tx");
  });

  describe("sign-in", () => {
    it("siws.ok: well-formed, matching the page and account -> L1 Sign-in request (object and text)", () => {
      for (const r of [signIn(good), msg(text(formatSiws(good, "dapp.example")))]) {
        const v = review(r);
        expect(v).toMatchObject({ kind: "siws", rule: "siws.ok" });
        expect(v.findings.map((f) => f.rule)).toEqual(["siws.ok"]);
        expect(v.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["domain", "address", "uri", "nonce"]));
        expect(messageVerdict(v)).toMatchObject({ hold: true, level: 1, reason: "Sign-in request" });
      }
    });
    it("siws.domain-mismatch: -> L3", () => {
      expect(rulesOf(signIn({ ...good, domain: "evil.example" }))).toContain("siws.domain-mismatch");
      expect(messageVerdict(review(signIn({ ...good, domain: "evil.example" })))).toMatchObject({ level: 3, hold: true });
      expect(rulesOf(msg(text(formatSiws({ ...good, domain: "dapp.example.evil.com" }, "x"))))).toContain("siws.domain-mismatch");
    });
    it("siws.uri-mismatch: URI host differs -> L3", () => {
      expect(rulesOf(signIn({ ...good, uri: "https://evil.example/login" }))).toContain("siws.uri-mismatch");
    });
    it("siws.address-mismatch: -> L2", () => {
      const v = review(signIn({ ...good, address: OTHER }));
      expect(v.rule).toBe("siws.address-mismatch");
      expect(messageVerdict(v).level).toBe(2);
    });
    it("address is not checked when the wallet exposes no account", () => {
      expect(rulesOf(signIn({ ...good, address: OTHER }, { account: null }))).toEqual(["siws.ok"]);
    });
    it("siws.expired: -> L2", () => {
      expect(review(signIn({ ...good, expirationTime: "2026-11-08T11:00:00.000Z" })).rule).toBe("siws.expired");
    });
    it("siws.not-yet-valid: -> L2", () => {
      expect(review(signIn({ ...good, notBefore: "2026-11-08T12:30:00.000Z" })).rule).toBe("siws.not-yet-valid");
    });
    it("siws.chain-mismatch: -> L2 (only when the wallet chain is known)", () => {
      expect(review(signIn({ ...good, chainId: "devnet" }, { chain: "solana:mainnet" })).rule).toBe("siws.chain-mismatch");
      expect(rulesOf(signIn({ ...good, chainId: "solana:mainnet" }, { chain: "solana:mainnet" }))).toEqual(["siws.ok"]);
      expect(rulesOf(signIn({ ...good, chainId: "devnet" }))).toEqual(["siws.ok"]);
    });
    it("siws.malformed: SIWS lookalike or unreadable time/URI -> L2", () => {
      expect(rulesOf(msg(text("dapp.example wants you to sign in with your Solana account:\nnot-an-address\n")))).toEqual(["siws.malformed"]);
      expect(rulesOf(signIn({ ...good, expirationTime: "tomorrow" }))).toContain("siws.malformed");
      expect(rulesOf(signIn({ ...good, uri: "not a url" }))).toContain("siws.malformed");
    });
    it("the strictest finding sets the level; all findings are listed, strictest first", () => {
      const v = review(signIn({ ...good, domain: "evil.example", address: OTHER, expirationTime: "2026-01-01T00:00:00Z" }));
      expect(v.findings.map((f) => f.rule)).toEqual(["siws.domain-mismatch", "siws.address-mismatch", "siws.expired"]);
      expect(v.rule).toBe("siws.domain-mismatch");
    });
    it("port in the domain must match the page host", () => {
      const at = (domain: string) => reviewMessage(signIn({ ...good, domain, uri: "http://localhost:5174/" }), "http://localhost:5174/", deps).findings.map((f) => f.rule);
      expect(at("localhost:5174")).toEqual(["siws.ok"]);
      expect(at("localhost:9999")).toContain("siws.domain-mismatch");
    });
    it("signIn without a domain defaults to the page host", () => {
      const noDomain = { ...good };
      delete noDomain.domain;
      expect(rulesOf(signIn(noDomain))).toEqual(["siws.ok"]);
    });
  });

  it("parses the standard SIWS text with and without statement, scheme and resources", () => {
    const full: SignInInput = { ...good, notBefore: "2026-11-08T11:00:00.000Z", requestId: "r1", resources: ["https://a.example/x", "ipfs://b"] };
    expect(parseSiws(formatSiws(full, "dapp.example"))).toEqual(full);
    const bare = { ...good };
    delete bare.statement;
    expect(parseSiws(formatSiws(bare, "dapp.example"))).toEqual(bare);
    expect(parseSiws(`https://dapp.example wants you to sign in with your Solana account:\n${ACCOUNT}\n\nURI: https://dapp.example\nVersion: 1\nNonce: n12345678\nIssued At: 2026-11-08T11:00:00Z`)).toMatchObject({ domain: "dapp.example", nonce: "n12345678" });
    expect(parseSiws("hello")).toBeNull();
    expect(parseSiws(formatSiws(good, "d") + "\nURI: again")).toBeNull();
  });

  it("long text is bounded and flagged", () => {
    const r = review(msg(text("a".repeat(4000) + "b".repeat(100))));
    expect(r.text!.length).toBe(4096);
    expect(r.truncated).toBe(true);
    expect(validateMessageReview(r)).not.toBeNull();
  });

  it("every rule has fixed text and its documented level", () => {
    expect(Object.fromEntries(Object.entries(MESSAGE_RULES).map(([k, v]) => [k, v.level]))).toEqual({
      "message.hidden-tx": 4, "message.binary": 3, "siws.domain-mismatch": 3, "siws.uri-mismatch": 3, "siws.malformed": 2,
      "siws.address-mismatch": 2, "siws.expired": 2, "siws.not-yet-valid": 2, "siws.chain-mismatch": 2, "siws.ok": 1, "message.text": 1
    });
  });
});


describe("shapes", () => {
  it("verdicts and views validate; unknown keys and bad kinds are rejected", () => {
    const v = messageVerdict(review(msg(text("hi"))));
    expect(validateWorkerVerdict(v)).not.toBeNull();
    expect(validateReportView(v.report)).not.toBeNull();
    expect(validateReportView({ ...v.report, message: { ...v.report!.message, extra: 1 } })).toBeNull();
    expect(validateReportView({ ...v.report, message: { ...v.report!.message, kind: "html" } })).toBeNull();
    expect(validateMessageReview({ ...v.report!.message, findings: [] })).toBeNull();
    expect(validateWorkerVerdict(messageVerdict(review(msg(MINIMAL_MESSAGE))))).not.toBeNull();
  });
  it("requests: exact keys; signIn needs signIn and no message; signMessage needs base64", () => {
    expect(validateMessageRequest(msg(text("x")))).not.toBeNull();
    expect(validateMessageRequest(signIn(good))).not.toBeNull();
    expect(validateMessageRequest({ ...msg(text("x")), extra: 1 })).toBeNull();
    expect(validateMessageRequest({ ...msg(text("x")), signIn: {} })).toBeNull();
    expect(validateMessageRequest({ ...signIn(good), message: "AAAA" })).toBeNull();
    expect(validateMessageRequest({ ...signIn(good), signIn: { nonce: 5 } })).toBeNull();
    expect(validateMessageRequest({ ...msg(text("x")), method: "legacy:signTransaction" })).toBeNull();
  });
});
