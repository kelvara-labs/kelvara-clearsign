import { webcrypto } from "node:crypto";
import { installBridge, type Bridge } from "../src/bridge/bridge.js";
import { installHook, type InstalledHook } from "../src/hook/install.js";
import type { HookWindow } from "../src/hook/pristine.js";
import type { AnalyzeMessage, NoticeMessage } from "../src/shared/protocol.js";

export function makeWin(): HookWindow {
  const win = new EventTarget() as HookWindow;
  Object.assign(win, {
    crypto: webcrypto,
    btoa,
    setTimeout: (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    },
    clearTimeout,
    CustomEvent
  });
  return win;
}

export type Worker = (msg: AnalyzeMessage | NoticeMessage) => Promise<unknown>;

export interface Rig {
  win: HookWindow;
  hook: InstalledHook;
  bridge: Bridge | null;
  sent: (AnalyzeMessage | NoticeMessage)[];
}

/** Bridge first (manifest order), then hook, like Chrome at document_start. */
export function rig(worker: Worker, opts: { bridge?: boolean; hookFirst?: boolean; timeoutMs?: number } = {}): Rig {
  const win = makeWin();
  const sent: (AnalyzeMessage | NoticeMessage)[] = [];
  const deps = {
    sendToWorker: (m: AnalyzeMessage | NoticeMessage) => {
      sent.push(m);
      return worker(m);
    },
    showReport: async () => true,
    url: () => "https://dapp.example/",
    topFrame: true,
    getRandomValues: (a: Uint8Array) => webcrypto.getRandomValues(a)
  };
  let bridge: Bridge | null = null;
  if (opts.bridge !== false && !opts.hookFirst) bridge = installBridge(win, deps);
  const hook = installHook(win, { timeoutMs: opts.timeoutMs ?? 2000 })!;
  if (opts.bridge !== false && opts.hookFirst) bridge = installBridge(win, deps);
  return { win, hook, bridge, sent };
}

export const allow: Worker = async () => ({ allow: false, hold: true, level: 0, reason: "ok", report: null });
export const block: Worker = async () => ({ allow: false, hold: false, level: 4, reason: "sweep", report: null });
export const never: Worker = () => new Promise(() => {});

/** A small real-looking wire transaction: 1 signature slot + legacy message bytes. */
export function wireTx(seed = 1): Uint8Array {
  const msg = new Uint8Array(40).map((_, i) => (i * 7 + seed) & 0xff);
  msg[0] = 1; // numRequiredSignatures (legacy header)
  const out = new Uint8Array(1 + 64 + msg.length);
  out[0] = 1;
  out.set(msg, 65);
  return out;
}

/** Wallet Standard wallet with #private state, like real wallet classes. */
export class FixtureWallet {
  readonly #features: Record<string, unknown>;
  calls: Uint8Array[] = [];
  messageCalls = 0;
  get name() {
    return "Fixture Wallet";
  }
  get version() {
    return "1.0.0" as const;
  }
  get chains() {
    return ["solana:devnet"];
  }
  get accounts() {
    return [];
  }
  get features() {
    return this.#features;
  }
  constructor() {
    this.#features = {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [] }) },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
          for (const i of inputs) this.calls.push(i.transaction);
          return inputs.map((i) => ({ signedTransaction: i.transaction }));
        }
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signAndSendTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
          for (const i of inputs) this.calls.push(i.transaction);
          return inputs.map(() => ({ signature: new Uint8Array(64) }));
        }
      },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async () => {
          this.messageCalls++;
          return [];
        }
      }
    };
  }
}

/** The reference RegisterWalletEvent: its stop* methods throw. */
export class RegisterWalletEvent extends Event {
  readonly #detail: unknown;
  get detail() {
    return this.#detail;
  }
  constructor(cb: unknown) {
    super("wallet-standard:register-wallet", { bubbles: false, cancelable: false, composed: false });
    this.#detail = cb;
  }
  override stopImmediatePropagation(): never {
    throw new Error("stopImmediatePropagation cannot be called");
  }
  override stopPropagation(): never {
    throw new Error("stopPropagation cannot be called");
  }
}
export class AppReadyEvent extends Event {
  readonly #detail: unknown;
  get detail() {
    return this.#detail;
  }
  constructor(api: unknown) {
    super("wallet-standard:app-ready", { bubbles: false, cancelable: false, composed: false });
    this.#detail = api;
  }
  override stopImmediatePropagation(): never {
    throw new Error("stopImmediatePropagation cannot be called");
  }
}

/** Minimal @wallet-standard/app getWallets(): listens, then announces app-ready. */
export function startApp(win: EventTarget): unknown[] {
  const registered: unknown[] = [];
  const api = Object.freeze({ register: (...ws: unknown[]) => void registered.push(...ws) });
  win.addEventListener("wallet-standard:register-wallet", (e) => ((e as unknown as { detail: (a: unknown) => void }).detail)(api));
  win.dispatchEvent(new AppReadyEvent(api));
  return registered;
}

/** Minimal @wallet-standard/wallet registerWallet(). */
export function registerWallet(win: EventTarget, wallet: unknown): void {
  const cb = ({ register }: { register: (w: unknown) => void }) => register(wallet);
  win.dispatchEvent(new RegisterWalletEvent(cb));
  win.addEventListener("wallet-standard:app-ready", (e) => cb((e as unknown as { detail: { register: (w: unknown) => void } }).detail));
}

export type SignFeature = { signTransaction: (...i: unknown[]) => Promise<unknown> };
export function signFeature(wallet: unknown): SignFeature {
  return (wallet as { features: Record<string, SignFeature> }).features["solana:signTransaction"]!;
}

/**
 * Smallest legacy message core's parser accepts: header (1 signer), one account, a blockhash,
 * no instructions. Synthetic bytes for policy tests only; real transactions come from fixtures/tx.
 */
export const MINIMAL_MESSAGE = Uint8Array.from([1, 0, 0, 1, ...new Uint8Array(32), ...new Uint8Array(32), 0]);
