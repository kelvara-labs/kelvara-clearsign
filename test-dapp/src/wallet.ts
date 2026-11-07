// Fixture wallet core: a throwaway Ed25519 key and a call log.
// The key is made fresh on every page load with WebCrypto and never leaves memory.
// The wallet signs only; it never submits anything and makes no network requests.
import { b58encode, b64encode, bytesEqual, parseWireTx } from "./bytes.js";

/** Which way the call reached the wallet. */
export type WalletPath = "ws-register" | "ws-app-ready" | "legacy";
export const WALLET_PATHS: readonly WalletPath[] = ["ws-register", "ws-app-ready", "legacy"];

export interface CallRecord {
  /** 1-based order across all paths. */
  n: number;
  path: WalletPath;
  /** Wallet method name as the wallet saw it, e.g. "solana:signTransaction", "legacy:signAllTransactions". */
  method: string;
  /** base64 of each transaction exactly as the wallet received it (before signing). */
  received: string[];
  /** base64 of each transaction the wallet returned. */
  returned: string[];
  /** Per transaction: did our key fill a signer slot? */
  signed: boolean[];
  at: number;
}

export interface MessageRecord {
  n: number;
  path: WalletPath;
  method: string;
  message: string; // base64
  at: number;
}

export interface CallLog {
  /** Transaction-signing calls that reached the wallet. Zero means the wallet was never called. */
  count: number;
  byPath: Record<WalletPath, number>;
  calls: CallRecord[];
  /** Message-signing calls (these pass through the extension with a notice). */
  messageCount: number;
  messages: MessageRecord[];
}

export function emptyLog(): CallLog {
  return { count: 0, byPath: { "ws-register": 0, "ws-app-ready": 0, legacy: 0 }, calls: [], messageCount: 0, messages: [] };
}

export class FixtureKey {
  private constructor(
    private readonly privateKey: CryptoKey,
    readonly publicKey: Uint8Array,
    readonly address: string
  ) {}

  static async generate(subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<FixtureKey> {
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
    return new FixtureKey(pair.privateKey, pub, b58encode(pub));
  }

  async signBytes(message: Uint8Array): Promise<Uint8Array> {
    const sig = await globalThis.crypto.subtle.sign({ name: "Ed25519" }, this.privateKey, message as BufferSource);
    return new Uint8Array(sig);
  }

  /**
   * Fill our signer slot in a wire transaction. A transaction our key does not sign is
   * returned unchanged (signed=false): fixtures from scenarios carry their own fee payers.
   */
  async signWireTx(tx: Uint8Array): Promise<{ bytes: Uint8Array; signed: boolean }> {
    const out = tx.slice();
    let parsed;
    try {
      parsed = parseWireTx(out);
    } catch {
      return { bytes: out, signed: false };
    }
    const slots = Math.min(parsed.numRequiredSignatures, parsed.sigCount, parsed.staticKeys.length);
    let slot = -1;
    for (let i = 0; i < slots; i++) if (bytesEqual(parsed.staticKeys[i]!, this.publicKey)) slot = i;
    if (slot < 0) return { bytes: out, signed: false };
    const sig = await this.signBytes(out.subarray(parsed.msgOffset));
    out.set(sig, parsed.sigOffset + 64 * slot);
    return { bytes: out, signed: true };
  }
}

/** Shared by all three wallets on the page: one key, one log. */
export class FixtureWalletCore {
  log: CallLog = emptyLog();
  private n = 0;
  private listeners = new Set<(log: CallLog) => void>();

  constructor(readonly key: FixtureKey) {}

  onChange(fn: (log: CallLog) => void): void {
    this.listeners.add(fn);
  }

  reset(): void {
    this.log = emptyLog();
    this.n = 0;
    this.emit();
  }

  /** Count first, then sign: a call that reaches the wallet is counted even if signing fails. */
  async signTransactions(path: WalletPath, method: string, txs: Uint8Array[]): Promise<Uint8Array[]> {
    const rec: CallRecord = {
      n: ++this.n,
      path,
      method,
      received: txs.map((t) => b64encode(t)),
      returned: [],
      signed: [],
      at: Date.now()
    };
    this.log.count++;
    this.log.byPath[path]++;
    this.log.calls.push(rec);
    this.emit();
    const results = [];
    for (const tx of txs) results.push(await this.key.signWireTx(tx));
    rec.returned = results.map((r) => b64encode(r.bytes));
    rec.signed = results.map((r) => r.signed);
    this.emit();
    return results.map((r) => r.bytes);
  }

  async signMessage(path: WalletPath, method: string, message: Uint8Array): Promise<Uint8Array> {
    this.log.messageCount++;
    this.log.messages.push({ n: ++this.n, path, method, message: b64encode(message), at: Date.now() });
    this.emit();
    return this.key.signBytes(message);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.log);
  }
}

/** First signature of a wire transaction (what signAndSend would report), base58 for legacy. */
export function firstSignature(tx: Uint8Array): Uint8Array {
  const p = parseWireTx(tx);
  return tx.slice(p.sigOffset, p.sigOffset + 64);
}
