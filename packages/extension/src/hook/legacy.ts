// Legacy injected providers: window.solana, window.phantom.solana, window.solflare,
// window.backpack. Ported from sol-sign-preview src/inject.js (ISC). Changes:
//   - a call whose transaction we cannot serialize is rejected, not passed through;
//   - after an allow, the transaction is re-serialized and must equal the analyzed
//     bytes (the page may not swap it during the hold), and byte arguments are
//     replaced by our private copy;
//   - late injection is trapped with property setters on window and window.phantom,
//     plus a rescan driven by a MutationObserver and a few timed passes.
import { b58decode, b58encode, bytesEqual, messageToWireTx, txToBytes } from "../shared/codec.js";
import type { MessageMethod, SignInInput, SignMethod } from "../shared/protocol.js";
import { cleanWalletName, rejection, type Guard } from "./guard.js";
import { pristine, type HookWindow, type Pristine } from "./pristine.js";
import { messageBytes, readSignIn } from "./message.js";
import { isSigningName } from "./signing.js";
import { findDescriptor, makeShim, safeGet } from "./wallet-standard.js";

type Fn = (...args: unknown[]) => unknown;
type Obj = Record<PropertyKey, unknown>;

export const LEGACY_PATHS = [
  "solana", "phantom.solana", "solflare", "backpack", "braveSolana", "glow.solana", "exodus.solana",
  "coin98.sol", "okxwallet.solana", "trustwallet.solana"
] as const;

const LEGACY_KEYS = [
  "signTransaction",
  "signAllTransactions",
  "signAndSendTransaction",
  "signAndSendAllTransactions",
  "sendTransaction",
  "signMessage",
  "signIn",
  "request"
] as const;

type Plan =
  | { kind: "pass" }
  | { kind: "sign"; method: SignMethod; txs: Uint8Array[]; forward: unknown[] }
  | { kind: "message"; method: MessageMethod; payload: { message: Uint8Array } | { signIn: SignInInput }; forward: unknown[] }
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
export function classify(key: string, args: unknown[], p: Pristine): Plan {
  switch (key) {
    case "signMessage": {
      const message = messageBytes(args[0]);
      return { kind: "message", method: "legacy:signMessage", payload: { message }, forward: [message.slice(), ...args.slice(1)] };
    }
    case "signIn": {
      const signIn = readSignIn(p, args[0]);
      return { kind: "message", method: "legacy:signIn", payload: { signIn }, forward: args.length ? [{ ...(args[0] as object), ...signIn }, ...args.slice(1)] : [] };
    }
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
    case "request": {
      const req = args[0] as { method?: unknown; params?: Obj } | undefined;
      const m = req && typeof req === "object" ? req.method : undefined;
      const params = (req?.params ?? {}) as Obj;
      if (m === "signMessage") {
        const message = messageBytes(params.message, true);
        return { kind: "message", method: "legacy:signMessage", payload: { message }, forward: args };
      }
      if (m === "signIn") {
        const signIn = readSignIn(p, req?.params);
        return { kind: "message", method: "legacy:signIn", payload: { signIn }, forward: args };
      }
      if (m === "signTransaction" || m === "signAndSendTransaction" || m === "sendTransaction") {
        const tx = "message" in params ? fromMessage(params.message) : txToBytes(params.transaction);
        return { kind: "sign", method: `legacy:${m}`, txs: [tx], forward: args };
      }
      if (m === "signAllTransactions" || m === "signAndSendAllTransactions") {
        const items = "messages" in params ? params.messages : params.transactions;
        if (!Array.isArray(items)) throw new Error("expected an array");
        const txs = items.map((x: unknown) => ("messages" in params ? fromMessage(x) : txToBytes(x)));
        return { kind: "sign", method: `legacy:${m}`, txs, forward: args };
      }
      // Message signing, sign-in and any other signing-named method cannot be analyzed: never reaches the wallet.
      return isSigningName(m) ? { kind: "reject" } : { kind: "pass" };
    }
    default:
      return isSigningName(key) ? { kind: "reject" } : { kind: "pass" };
  }
}

function safeClassify(key: string, args: unknown[], p: Pristine): Plan {
  try {
    return classify(key, args, p);
  } catch {
    return { kind: "reject" };
  }
}

type Payload = { message: Uint8Array } | { signIn: SignInInput };
function samePayload(p: Pristine, a: Payload, b: Payload): boolean {
  if ("message" in a || "message" in b) return "message" in a && "message" in b && bytesEqual(a.message, b.message);
  return p.stringify(a.signIn) === p.stringify(b.signIn);
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

  /** provider.publicKey as base58 (PublicKey-like with toBase58, or 32 raw bytes), else null. Never throws. */
  function providerAccount(provider: object): string | null {
    try {
      const key = safeGet(p, provider, "publicKey");
      if (key instanceof Uint8Array) return key.length === 32 ? b58encode(key) : null;
      if (typeof key !== "object" || key === null) return null;
      const toBase58 = safeGet(p, key, "toBase58");
      if (typeof toBase58 === "function") {
        const s = p.apply(toBase58 as Fn, key, []);
        return typeof s === "string" ? s : null;
      }
      const toBytes = safeGet(p, key, "toBytes");
      if (typeof toBytes === "function") {
        const b = p.apply(toBytes as Fn, key, []);
        return b instanceof Uint8Array && b.length === 32 ? b58encode(b) : null;
      }
    } catch {
      /* a hint only */
    }
    return null;
  }

  /** `fixed` null: a prototype-level wrapper that acts on whatever `this` the page calls it with. */
  function makeWrapper(orig: Fn, fixed: object | null, key: string, label: string): Fn {
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      const provider = fixed ?? (this && (typeof this === "object" || typeof this === "function") ? (this as object) : null);
      if (!provider) return p.Promise.reject(rejection());
      const plan = safeClassify(key, args, p);
      if (plan.kind === "pass") return p.apply(orig, provider, args);
      if (plan.kind === "reject") return p.Promise.reject(rejection());
      if (plan.kind === "message") {
        return (async () => {
          const allow = await guard.holdMessage(plan.method, walletName(provider, label), null, providerAccount(provider), plan.payload);
          if (!allow) throw rejection();
          // The page may have changed the arguments during the hold.
          const again = safeClassify(key, args, p);
          if (again.kind !== "message" || !samePayload(p, again.payload, plan.payload)) throw rejection();
          return p.apply(orig, provider, plan.forward);
        })();
      }
      return (async () => {
        const allow = await guard.hold(plan.method, walletName(provider, label), null, plan.txs, providerAccount(provider));
        if (!allow) throw rejection();
        // The page may have changed the transaction object during the hold.
        const again = safeClassify(key, args, p);
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
    const keys = new Set<string>(LEGACY_KEYS);
    for (let cur: object | null = pr; cur && cur !== Object.prototype; cur = p.getPrototypeOf(cur) as object | null)
      for (const k of p.ownKeys(cur)) if (isSigningName(k)) keys.add(k as string);
    for (const key of keys) {
      const fn = safeGet(p, pr, key);
      if (typeof fn !== "function" || ourFns.has(fn as Fn)) continue;
      wrappers[key] = makeWrapper(fn as Fn, provider, key, label);
      // The page can reach the class method through the prototype (`Proto.m.call(provider, tx)`): guard it too.
      const found = findDescriptor(p, pr, key);
      if (found && found.owner !== pr && found.owner !== Object.prototype && typeof found.desc.value === "function") {
        try {
          p.defineProperty(found.owner, key, { ...found.desc, value: makeWrapper(fn as Fn, null, key, label) });
        } catch {
          /* frozen prototype: the instance-level wrapper still guards the normal path */
        }
      }
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
  const exposeNested = (name: string, label: string) => (holder: object): object => {
    trap(holder, name, exposeProvider(label));
    return holder;
  };

  function rescan(): void {
    trap(win, "solana", exposeProvider("solana"));
    trap(win, "solflare", exposeProvider("solflare"));
    trap(win, "backpack", exposeProvider("backpack"));
    trap(win, "braveSolana", exposeProvider("braveSolana"));
    trap(win, "phantom", exposeNested("solana", "phantom.solana"));
    for (const [holder, name] of [["glow", "solana"], ["exodus", "solana"], ["coin98", "sol"], ["okxwallet", "solana"], ["trustwallet", "solana"]] as const)
      trap(win, holder, exposeNested(name, `${holder}.${name}`));
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

