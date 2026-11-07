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
//   the chain is a validated hint, the URL is read by the bridge itself.

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

export const CHAINS = ["solana:mainnet", "solana:devnet", "solana:testnet", "solana:localnet"] as const;
export type Chain = (typeof CHAINS)[number];

/** hook -> bridge: hold this call until the extension decides. */
export interface SignRequest {
  v: 1;
  kind: "sign";
  id: string;
  method: SignMethod;
  wallet: string;
  chain: Chain | null;
  txs: string[]; // base64 wire transactions
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

export type HookMessage = SignRequest | Notice;

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

export function isChain(x: unknown): x is Chain {
  return typeof x === "string" && (CHAINS as readonly string[]).includes(x);
}

function isTxB64(x: unknown): x is string {
  // base64 of at most MAX_TX_BYTES, non-empty
  return typeof x === "string" && x.length > 0 && x.length <= Math.ceil(MAX_TX_BYTES / 3) * 4 && x.length % 4 === 0 && B64_RE.test(x);
}

export function validateSignRequest(o: unknown): SignRequest | null {
  if (!isPlainObject(o)) return null;
  if (!hasExactKeys(o, ["v", "kind", "id", "method", "wallet", "chain", "txs"])) return null;
  if (o.v !== PROTOCOL_VERSION || o.kind !== "sign" || !isId(o.id)) return null;
  if (typeof o.method !== "string" || !(SIGN_METHODS as readonly string[]).includes(o.method)) return null;
  if (!isWalletName(o.wallet)) return null;
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

export function parseHookMessage(raw: unknown): HookMessage | null {
  const o = parse(raw);
  if (!o) return null;
  if (o.kind === "sign") return validateSignRequest(o);
  if (o.kind === "notice") return validateNotice(o);
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

export interface WorkerVerdict {
  allow: boolean;
  level: 0 | 1 | 2 | 3 | 4 | null;
  reason: string;
}

export function validateWorkerVerdict(x: unknown): WorkerVerdict | null {
  if (!isPlainObject(x) || !hasExactKeys(x, ["allow", "level", "reason"])) return null;
  if (typeof x.allow !== "boolean" || typeof x.reason !== "string") return null;
  if (!(x.level === null || (typeof x.level === "number" && [0, 1, 2, 3, 4].includes(x.level)))) return null;
  return x as unknown as WorkerVerdict;
}
