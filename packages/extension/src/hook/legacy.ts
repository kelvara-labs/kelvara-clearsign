// Legacy injected providers: window.solana, window.phantom.solana, window.solflare,
// window.backpack. Ported from sol-sign-preview src/inject.js (ISC). Changes:
//   - a call whose transaction we cannot serialize is rejected, not passed through;
//   - after an allow, the transaction is re-serialized and must equal the analyzed
//     bytes (the page may not swap it during the hold), and byte arguments are
//     replaced by our private copy;
//   - late injection is trapped with property setters on window and window.phantom,
//     plus a rescan driven by a MutationObserver and a few timed passes.
import { b58decode, bytesEqual, messageToWireTx, txToBytes } from "../shared/codec.js";
import type { NoticeMethod, SignMethod } from "../shared/protocol.js";
import { cleanWalletName, rejection, type Guard } from "./guard.js";
import { pristine, type HookWindow } from "./pristine.js";
import { makeShim, safeGet } from "./wallet-standard.js";

type Fn = (...args: unknown[]) => unknown;
type Obj = Record<PropertyKey, unknown>;

export const LEGACY_PATHS = ["solana", "phantom.solana", "solflare", "backpack"] as const;

const LEGACY_KEYS = [
  "signTransaction",
  "signAllTransactions",
  "signAndSendTransaction",
  "signAndSendAllTransactions",
  "sendTransaction",
  "signMessage",
  "request"
] as const;

type Plan =
  | { kind: "pass" }
  | { kind: "notice"; method: NoticeMethod }
  | { kind: "sign"; method: SignMethod; txs: Uint8Array[]; forward: unknown[] }
  | { kind: "reject" };

const isByteView = (x: unknown): boolean => ArrayBuffer.isView(x) && !(x instanceof DataView);

/** Swap byte arguments for our private copies; leave objects as they are. */
function substitute(orig: unknown, copy: Uint8Array): unknown {
  return isByteView(orig) ? copy : orig;
}

function fromMessage(m: unknown): Uint8Array {
  if (typeof m !== "string") throw new Error("message must be base58");
  return messageToWireTx(b58decode(m));
}

/** Decide what a legacy call does, and extract its transaction bytes. Throws on unreadable input. */
export function classify(key: string, args: unknown[]): Plan {
  switch (key) {
    case "signTransaction":
    case "signAndSendTransaction":
    case "sendTransaction": {
      const tx = txToBytes(args[0]);
      const method: SignMethod = `legacy:${key}`;
      return { kind: "sign", method, txs: [tx], forward: [substitute(args[0], tx), ...args.slice(1)] };
    }
    case "signAllTransactions":
    case "signAndSendAllTransactions": {
      if (!Array.isArray(args[0])) throw new Error("expected an array of transactions");
      const list = args[0] as unknown[];
      const txs = list.map((t) => txToBytes(t));
      const method: SignMethod = `legacy:${key}`;
      return { kind: "sign", method, txs, forward: [list.map((t, i) => substitute(t, txs[i]!)), ...args.slice(1)] };
    }
    case "signMessage":
      return { kind: "notice", method: "legacy:signMessage" };
    case "request": {
      const req = args[0] as { method?: unknown; params?: Obj } | undefined;
      const m = req && typeof req === "object" ? req.method : undefined;
      const params = (req?.params ?? {}) as Obj;
      if (m === "signMessage") return { kind: "notice", method: "legacy:signMessage" };
      if (m === "signTransaction" || m === "signAndSendTransaction") {
        const tx = "message" in params ? fromMessage(params.message) : txToBytes(params.transaction);
        return { kind: "sign", method: `legacy:${m}`, txs: [tx], forward: args };
      }
      if (m === "signAllTransactions" || m === "signAndSendAllTransactions") {
        const items = "messages" in params ? params.messages : params.transactions;
        if (!Array.isArray(items)) throw new Error("expected an array");
        const txs = items.map((x: unknown) => ("messages" in params ? fromMessage(x) : txToBytes(x)));
        return { kind: "sign", method: `legacy:${m}`, txs, forward: args };
      }
      return { kind: "pass" };
    }
    default:
      return { kind: "pass" };
  }
}

function safeClassify(key: string, args: unknown[]): Plan {
  try {
    return classify(key, args);
  } catch {
    return { kind: "reject" };
  }
}

export interface LegacyHook {
  /** Wrap a provider in place, or return a shim to expose instead. */
  wrapProvider(provider: object, label: string): object;
  rescan(): void;
  readonly wrappedCount: number;
}

export function installLegacyHook(win: HookWindow, guard: Guard): LegacyHook {
  const p = pristine(win);
  const wrappedInPlace = new WeakSet<object>();
  const shims = new WeakMap<object, object>();
  const shimSet = new WeakSet<object>();
  const ourFns = new WeakSet<Fn>();
  const trapGetters = new WeakSet<Fn>();
  let wrappedCount = 0;

  function walletName(provider: object, label: string): string {
    const flag = (k: string) => safeGet(p, provider, k) === true;
    if (flag("isPhantom")) return "Phantom";
    if (flag("isSolflare")) return "Solflare";
    if (flag("isBackpack")) return "Backpack";
    return cleanWalletName(safeGet(p, provider, "name"), label);
  }

  function makeWrapper(orig: Fn, provider: object, key: string, label: string): Fn {
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      const plan = safeClassify(key, args);
      if (plan.kind === "pass") return p.apply(orig, provider, args);
      if (plan.kind === "notice") {
        guard.notice(plan.method, walletName(provider, label));
        return p.apply(orig, provider, args);
      }
      if (plan.kind === "reject") return p.Promise.reject(rejection());
      return (async () => {
        const allow = await guard.hold(plan.method, walletName(provider, label), null, plan.txs);
        if (!allow) throw rejection();
        // The page may have changed the transaction object during the hold.
        const again = safeClassify(key, args);
        if (again.kind !== "sign" || again.txs.length !== plan.txs.length) throw rejection();
        for (let i = 0; i < plan.txs.length; i++) if (!bytesEqual(again.txs[i]!, plan.txs[i]!)) throw rejection();
        return p.apply(orig, provider, plan.forward);
      })();
    };
    ourFns.add(wrapper);
    return wrapper;
  }

  function wrapProvider(provider: object, label: string): object {
    if (wrappedInPlace.has(provider) || shimSet.has(provider)) return provider;
    const hit = shims.get(provider);
    if (hit) return hit;
    const pr = provider as Obj;
    const wrappers: Record<string, Fn> = {};
    for (const key of LEGACY_KEYS) {
      const fn = safeGet(p, pr, key);
      if (typeof fn !== "function" || ourFns.has(fn as Fn)) continue;
      wrappers[key] = makeWrapper(fn as Fn, provider, key, label);
    }
    let inPlace = true;
    for (const [key, w] of Object.entries(wrappers)) {
      try {
        p.defineProperty(pr, key, { value: w, writable: true, configurable: true, enumerable: false });
      } catch {
        /* frozen or non-configurable */
      }
      if (safeGet(p, pr, key) !== w) inPlace = false;
    }
    if (inPlace) {
      wrappedInPlace.add(provider);
      wrappedCount++;
      return provider;
    }
    const overrides: Record<string, () => unknown> = {};
    for (const [key, w] of Object.entries(wrappers)) overrides[key] = () => w;
    const shim = makeShim(p, pr, overrides);
    shims.set(provider, shim);
    shimSet.add(shim);
    wrappedCount++;
    return shim;
  }

  /**
   * Trap holder[key] so a provider assigned later is wrapped on the way in.
   * Re-traps if a wallet redefined the property configurable; if it is not
   * configurable, wraps the current value in place (and swaps in a shim if writable).
   */
  function trap(holder: object, key: string, expose: (v: object) => object): void {
    const desc = p.getOwnPropertyDescriptor(holder, key);
    if (desc?.get && trapGetters.has(desc.get as Fn)) return;
    if (desc && !desc.configurable) {
      const v = safeGet(p, holder, key);
      if (v && typeof v === "object") {
        const out = expose(v);
        if (out !== v && desc.writable) {
          try {
            (holder as Obj)[key] = out;
          } catch {
            /* nothing more we can do; diagnostics would show the gap */
          }
        }
      }
      return;
    }
    const origGet = desc?.get;
    const origSet = desc?.set;
    let inner: unknown = desc && "value" in desc ? desc.value : undefined;
    const get = function (this: unknown): unknown {
      const v = origGet ? p.apply(origGet, holder, []) : inner;
      return v && typeof v === "object" ? expose(v) : v;
    };
    trapGetters.add(get);
    try {
      p.defineProperty(holder, key, {
        configurable: true,
        enumerable: desc ? !!desc.enumerable : true,
        get,
        set(v: unknown) {
          if (origSet) p.apply(origSet, holder, [v]);
          else inner = v;
          if (v && typeof v === "object") expose(v);
        }
      });
    } catch {
      /* holder not extensible */
    }
    // Wrap whatever is already there.
    const now = safeGet(p, holder, key);
    if (now && typeof now === "object") expose(now);
  }

  const exposeProvider = (label: string) => (v: object) => wrapProvider(v, label);
  const exposePhantom = (ph: object): object => {
    trap(ph, "solana", exposeProvider("phantom.solana"));
    return ph;
  };

  function rescan(): void {
    trap(win, "solana", exposeProvider("solana"));
    trap(win, "solflare", exposeProvider("solflare"));
    trap(win, "backpack", exposeProvider("backpack"));
    trap(win, "phantom", exposePhantom);
  }

  rescan();

  // Late injection: wallets often add <script> tags or assign after load.
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    p.setTimeout(() => {
      scheduled = false;
      rescan();
    }, 50);
  };
  const MO = win.MutationObserver as typeof MutationObserver | undefined;
  const doc = win.document as Document | undefined;
  if (MO && doc) {
    try {
      const mo = new MO(schedule);
      mo.observe(doc, { childList: true, subtree: true });
      p.setTimeout(() => mo.disconnect(), 30_000);
    } catch {
      /* no DOM */
    }
  }
  for (const ms of [0, 100, 500, 1500, 5000, 15000]) p.setTimeout(rescan, ms);

  return {
    wrapProvider,
    rescan,
    get wrappedCount() {
      return wrappedCount;
    }
  };
}

