// Page <-> extension channel: message shapes and strict validators.
//
// Threat model: the page shares the main world with our hook and the DOM with our
// bridge. sol-sign-preview used window.postMessage(..., '*') with fixed source tags,
// so any page could post { approved: true }. Here:
//   1. The bridge (isolated world) makes a random 128-bit channel id and hands it to
//      the hook in a synchronous DOM-event handshake that completes at document_start,
//      before any page script exists. The hook accepts the channel only during its own
//      synchronous install; if no bridge answered, the hook stays unpaired and blocks
//      every signing call (fail closed).
//   2. All later traffic uses CustomEvents named after the channel, carrying JSON
//      strings only (strings cross worlds unchanged). Every message is checked against
//      an exact key set; anything else is dropped.
//   3. Request ids are random, so a decision can only answer a request the hook made.
//   Nothing from the page is trusted beyond the transaction bytes and the wallet name;
//   the chain and the connected account are validated hints, the URL is read by the bridge itself.

import { validateReportView, type ReportView } from "./report-view.js";

export const PROTOCOL_VERSION = 1;
export const HOOK_READY_EVENT = "kelvara-signguard:hook-ready";
export const BRIDGE_READY_EVENT = "kelvara-signguard:bridge-ready";

/** Hold time before a pending request is blocked (PLAN M5: 90 s, fail closed). */
export const DECISION_TIMEOUT_MS = 90_000;

export const MAX_TXS = 64;
export const MAX_TX_BYTES = 4096;
export const MAX_WALLET_NAME = 64;

export const SIGN_METHODS = [
  "solana:signTransaction",
  "solana:signAndSendTransaction",
  "legacy:signTransaction",
  "legacy:signAllTransactions",
  "legacy:signAndSendTransaction",
  "legacy:signAndSendAllTransactions",
  "legacy:sendTransaction"
] as const;
export type SignMethod = (typeof SIGN_METHODS)[number];

export const NOTICE_METHODS = ["solana:signMessage", "legacy:signMessage"] as const;
export type NoticeMethod = (typeof NOTICE_METHODS)[number];

/** Message-signing calls: held and reviewed like transactions (the wallet is never called before the decision). */
export const MESSAGE_METHODS = ["solana:signMessage", "solana:signIn", "legacy:signMessage", "legacy:signIn"] as const;
export type MessageMethod = (typeof MESSAGE_METHODS)[number];
export const MAX_MESSAGE_BYTES = 8192;
export const MAX_SIGNIN_TEXT = 2048;
export const MAX_SIGNIN_RESOURCES = 16;
export const SIGNIN_STRING_FIELDS = ["domain", "address", "statement", "uri", "version", "chainId", "nonce", "issuedAt", "expirationTime", "notBefore", "requestId"] as const;
/** solana:signIn input as the hook read it: only these keys, strings only (resources: list of strings). */
export type SignInInput = { [K in (typeof SIGNIN_STRING_FIELDS)[number]]?: string } & { resources?: string[] };

export const CHAINS = ["solana:mainnet", "solana:devnet", "solana:testnet", "solana:localnet"] as const;
export type Chain = (typeof CHAINS)[number];

/** hook -> bridge: hold this call until the extension decides. */
export interface SignRequest {
  v: 1;
  kind: "sign";
  id: string;
  method: SignMethod;
  wallet: string;
  /** Connected account as the wallet/page reports it (base58), or null. A hint for the engine's
   * wallet-bound rules only: the worker uses it only when it is a required signer of the request. */
  account: string | null;
  chain: Chain | null;
  txs: string[]; // base64 wire transactions
}

/** hook -> bridge: hold this message-signing call until the extension decides. */
export interface MessageRequest {
  v: 1;
  kind: "message";
  id: string;
  method: MessageMethod;
  wallet: string;
  account: string | null;
  chain: Chain | null;
  /** base64 of the bytes to sign (signMessage), else null. */
  message: string | null;
  /** The sign-in input (signIn), else null. */
  signIn: SignInInput | null;
}

/** hook -> bridge: a message-signing call passed through; tell the user. */
export interface Notice {
  v: 1;
  kind: "notice";
  id: string;
  method: NoticeMethod;
  wallet: string;
}

/** bridge -> hook */
export interface Decision {
  v: 1;
  kind: "decision";
  id: string;
  allow: boolean;
}

export type HookMessage = SignRequest | Notice | MessageRequest;

/** Channel ids and request ids: 32 lowercase hex chars (128 bits). */
const ID_RE = /^[0-9a-f]{32}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function requestEventName(channel: string): string {
  return `kelvara-signguard:${channel}:req`;
}
export function decisionEventName(channel: string): string {
  return `kelvara-signguard:${channel}:res`;
}

export function randomId(getRandomValues: (a: Uint8Array) => Uint8Array): string {
  const b = getRandomValues(new Uint8Array(16));
  let s = "";
  for (let i = 0; i < b.length; i++) s += (b[i]! < 16 ? "0" : "") + b[i]!.toString(16);
  return s;
}

export function isId(x: unknown): x is string {
  return typeof x === "string" && ID_RE.test(x);
}

function hasExactKeys(o: object, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
}

function parse(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length > 2 * MAX_TXS * MAX_TX_BYTES) return null;
  try {
    const o: unknown = JSON.parse(raw);
    return isPlainObject(o) && o.v === PROTOCOL_VERSION ? o : null;
  } catch {
    return null;
  }
}

function isWalletName(x: unknown): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= MAX_WALLET_NAME;
}

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A base58 Solana address (32 to 44 characters). */
export function isAddress(x: unknown): x is string {
  return typeof x === "string" && ADDRESS_RE.test(x);
}

export function isChain(x: unknown): x is Chain {
  return typeof x === "string" && (CHAINS as readonly string[]).includes(x);
}

function isTxB64(x: unknown): x is string {
  // base64 of at most MAX_TX_BYTES, non-empty
  return typeof x === "string" && x.length > 0 && x.length <= Math.ceil(MAX_TX_BYTES / 3) * 4 && x.length % 4 === 0 && B64_RE.test(x);
}

export function validateSignRequest(o: unknown): SignRequest | null {
  if (!isPlainObject(o)) return null;
  if (!hasExactKeys(o, ["v", "kind", "id", "method", "wallet", "account", "chain", "txs"])) return null;
  if (o.v !== PROTOCOL_VERSION || o.kind !== "sign" || !isId(o.id)) return null;
  if (typeof o.method !== "string" || !(SIGN_METHODS as readonly string[]).includes(o.method)) return null;
  if (!isWalletName(o.wallet)) return null;
  if (!(o.account === null || isAddress(o.account))) return null;
  if (!(o.chain === null || isChain(o.chain))) return null;
  if (!Array.isArray(o.txs) || o.txs.length < 1 || o.txs.length > MAX_TXS || !o.txs.every(isTxB64)) return null;
  return o as unknown as SignRequest;
}

export function validateNotice(o: unknown): Notice | null {
  if (!isPlainObject(o)) return null;
  if (!hasExactKeys(o, ["v", "kind", "id", "method", "wallet"])) return null;
  if (o.v !== PROTOCOL_VERSION || o.kind !== "notice" || !isId(o.id)) return null;
  if (typeof o.method !== "string" || !(NOTICE_METHODS as readonly string[]).includes(o.method)) return null;
  if (!isWalletName(o.wallet)) return null;
  return o as unknown as Notice;
}

export function validateSignInInput(x: unknown): x is SignInInput {
  if (!isPlainObject(x)) return false;
  const allowed: readonly string[] = [...SIGNIN_STRING_FIELDS, "resources"];
  for (const [k, v] of Object.entries(x)) {
    if (!allowed.includes(k)) return false;
    if (k === "resources") {
      if (!Array.isArray(v) || v.length > MAX_SIGNIN_RESOURCES || !v.every((r) => typeof r === "string" && r.length <= MAX_SIGNIN_TEXT)) return false;
    } else if (typeof v !== "string" || v.length > MAX_SIGNIN_TEXT) return false;
  }
  return true;
}

export function validateMessageRequest(o: unknown): MessageRequest | null {
  if (!isPlainObject(o)) return null;
  if (!hasExactKeys(o, ["v", "kind", "id", "method", "wallet", "account", "chain", "message", "signIn"])) return null;
  if (o.v !== PROTOCOL_VERSION || o.kind !== "message" || !isId(o.id)) return null;
  if (typeof o.method !== "string" || !(MESSAGE_METHODS as readonly string[]).includes(o.method)) return null;
  if (!isWalletName(o.wallet) || !(o.account === null || isAddress(o.account)) || !(o.chain === null || isChain(o.chain))) return null;
  const isSignIn = o.method.endsWith("signIn");
  if (isSignIn) return o.message === null && validateSignInInput(o.signIn) ? (o as unknown as MessageRequest) : null;
  const ok = typeof o.message === "string" && o.message.length > 0 && o.message.length <= Math.ceil(MAX_MESSAGE_BYTES / 3) * 4 && o.message.length % 4 === 0 && B64_RE.test(o.message);
  return ok && o.signIn === null ? (o as unknown as MessageRequest) : null;
}

export function parseHookMessage(raw: unknown): HookMessage | null {
  const o = parse(raw);
  if (!o) return null;
  if (o.kind === "sign") return validateSignRequest(o);
  if (o.kind === "notice") return validateNotice(o);
  if (o.kind === "message") return validateMessageRequest(o);
  return null;
}

export function parseDecision(raw: unknown): Decision | null {
  const o = parse(raw);
  if (!o) return null;
  if (!hasExactKeys(o, ["v", "kind", "id", "allow"])) return null;
  if (o.kind !== "decision" || !isId(o.id) || typeof o.allow !== "boolean") return null;
  return o as unknown as Decision;
}

/** Handshake payload from the bridge: {"v":1,"channel":"<32 hex>"} */
export function parseHandshake(raw: unknown): string | null {
  const o = parse(raw);
  if (!o || !hasExactKeys(o, ["v", "channel"]) || !isId(o.channel)) return null;
  return o.channel;
}

/* ---------- bridge <-> service worker ---------- */

export const SW_ANALYZE = "kelvara-signguard/analyze";
export const SW_NOTICE = "kelvara-signguard/notice";
export const SW_MESSAGE = "kelvara-signguard/message";

export interface MessageReviewMessage {
  type: typeof SW_MESSAGE;
  request: MessageRequest;
  /** Read by the bridge from its own location, never from the page's message. */
  url: string;
  topFrame: boolean;
}

export interface AnalyzeMessage {
  type: typeof SW_ANALYZE;
  request: SignRequest;
  /** Read by the bridge from its own location, never from the page's message. */
  url: string;
  topFrame: boolean;
}

export interface NoticeMessage {
  type: typeof SW_NOTICE;
  notice: Notice;
  url: string;
  topFrame: boolean;
}

/** bridge -> worker: what the user chose for a held request (updates the capture log only). */
export const SW_DECIDED = "kelvara-signguard/decided";
export interface DecidedMessage {
  type: typeof SW_DECIDED;
  id: string;
  allow: boolean;
}

/**
 * Worker -> bridge. allow: pass to the wallet now. hold: ask the user in the report UI
 * (only L0..L3, never with allow). Neither: blocked (4001). report: what the UI shows.
 */
export interface WorkerVerdict {
  allow: boolean;
  hold: boolean;
  level: 0 | 1 | 2 | 3 | 4 | null;
  reason: string;
  report: ReportView | null;
}

export function validateWorkerVerdict(x: unknown): WorkerVerdict | null {
  if (!isPlainObject(x) || !hasExactKeys(x, ["allow", "hold", "level", "reason", "report"])) return null;
  if (typeof x.allow !== "boolean" || typeof x.hold !== "boolean" || typeof x.reason !== "string" || x.reason.length > 2000) return null;
  if (!(x.level === null || (typeof x.level === "number" && [0, 1, 2, 3, 4].includes(x.level)))) return null;
  if (x.hold && (x.allow || (x.level === null || x.level === 4))) return null;
  // L4 never passes, whatever the worker says.
  if (x.allow && x.level === 4) return null;
  if (!(x.report === null || validateReportView(x.report))) return null;
  return x as unknown as WorkerVerdict;
}
