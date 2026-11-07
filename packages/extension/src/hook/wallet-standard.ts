// Wallet Standard capture. Ported from sol-sign-preview src/inject.js (ISC) and
// reworked to the Wallet Standard event protocol:
//   wallet -> 'wallet-standard:register-wallet'  detail = callback({ register })
//   app    -> 'wallet-standard:app-ready'        detail = api { register }
// We listen first on both (capture listeners at document_start), stop the original
// event and re-dispatch one whose register() wraps every wallet before the app sees it.
import { txToBytes } from "../shared/codec.js";
import type { NoticeMethod, SignMethod } from "../shared/protocol.js";
import { cleanWalletName, rejection, type Guard } from "./guard.js";
import { pristine, type HookWindow, type Pristine } from "./pristine.js";

/** The one account every input names (input.account.address), else null. Only a hint: never throws. */
export function inputAccount(p: Pristine, inputs: readonly unknown[]): string | null {
  let out: string | null = null;
  for (const i of inputs) {
    const account = typeof i === "object" && i !== null ? safeGet(p, i, "account") : undefined;
    const address = typeof account === "object" && account !== null ? safeGet(p, account, "address") : undefined;
    if (typeof address !== "string" || (out !== null && out !== address)) return null;
    out = address;
  }
  return out;
}

export const REGISTER_EVENT = "wallet-standard:register-wallet";
export const APP_READY_EVENT = "wallet-standard:app-ready";

type Fn = (...args: unknown[]) => unknown;
type Obj = Record<PropertyKey, unknown>;

const SIGN_FEATURES: Record<string, { fn: string; method: SignMethod }> = {
  "solana:signTransaction": { fn: "signTransaction", method: "solana:signTransaction" },
  "solana:signAndSendTransaction": { fn: "signAndSendTransaction", method: "solana:signAndSendTransaction" }
};
const NOTICE_FEATURES: Record<string, { fn: string; method: NoticeMethod }> = {
  "solana:signMessage": { fn: "signMessage", method: "solana:signMessage" }
};

export interface WalletStandardHook {
  wrapWallet<T>(wallet: T): T;
  /** Wallets we wrapped, for diagnostics and tests. */
  readonly wrappedCount: number;
}

export function installWalletStandardHook(win: HookWindow, guard: Guard): WalletStandardHook {
  const p = pristine(win);
  const wallets = new WeakMap<object, object>();
  const ours = new WeakSet<object>(); // our proxies and shims
  const featureCache = new WeakMap<object, object>();
  const redispatched = new WeakSet<Event>();
  let wrappedCount = 0;

  /** Copy a feature object, swapping one method for a guarded wrapper. */
  function wrapFeature(feature: unknown, fnName: string, make: (orig: Fn, owner: object) => Fn): unknown {
    if (!feature || typeof feature !== "object") return feature;
    const orig = p.get(feature, fnName, feature);
    if (typeof orig !== "function") return feature;
    const copy = copyObject(p, feature as Obj);
    copy[fnName] = make(orig as Fn, feature);
    if (Object.isFrozen(feature)) Object.freeze(copy);
    return copy;
  }

  function wrapFeatures(features: unknown, walletName: string): unknown {
    if (!features || typeof features !== "object") return features;
    const hit = featureCache.get(features);
    if (hit) return hit;
    const out = copyObject(p, features as Obj);
    for (const key of Object.keys(SIGN_FEATURES)) {
      if (!(key in out)) continue;
      const spec = SIGN_FEATURES[key]!;
      out[key] = wrapFeature(out[key], spec.fn, (orig, owner) => signWrapper(orig, owner, spec.method, walletName));
    }
    for (const key of Object.keys(NOTICE_FEATURES)) {
      if (!(key in out)) continue;
      const spec = NOTICE_FEATURES[key]!;
      out[key] = wrapFeature(out[key], spec.fn, (orig, owner) =>
        function (this: unknown, ...inputs: unknown[]) {
          guard.notice(spec.method, walletName);
          return p.apply(orig, owner, inputs);
        }
      );
    }
    if (Object.isFrozen(features)) Object.freeze(out);
    featureCache.set(features, out);
    return out;
  }

  function signWrapper(orig: Fn, owner: object, method: SignMethod, walletName: string): Fn {
    return async function (...inputs: unknown[]) {
      let snaps: Uint8Array[];
      let chain: unknown = null;
      try {
        snaps = inputs.map((i) => txToBytes((i as { transaction?: unknown }).transaction));
        chain = (inputs[0] as { chain?: unknown }).chain ?? null;
      } catch {
        throw rejection(); // cannot see the bytes: fail closed
      }
      if (snaps.length === 0) throw rejection();
      const allow = await guard.hold(method, walletName, chain, snaps, inputAccount(p, inputs));
      if (!allow) throw rejection();
      // Forward the exact bytes we analyzed: our private copies, not the page's arrays.
      const forwarded = inputs.map((i, k) => ({ ...(i as object), transaction: snaps[k] }));
      return p.apply(orig, owner, forwarded);
    };
  }

  function wrapWallet<T>(wallet: T): T {
    if (!wallet || typeof wallet !== "object") return wallet;
    if (ours.has(wallet)) return wallet;
    const hit = wallets.get(wallet);
    if (hit) return hit as T;
    const w = wallet as unknown as Obj;
    const name = cleanWalletName(safeGet(p, w, "name"), "Wallet Standard wallet");
    let wrapped: object;
    const fd = findDescriptor(p, w, "features");
    if (fd && fd.owner === w && fd.desc.configurable === false && "value" in fd.desc && fd.desc.writable === false) {
      // A Proxy may not change a frozen data property: build a forwarding shim instead.
      wrapped = makeShim(p, w, { features: () => wrapFeatures(safeGet(p, w, "features"), name) });
    } else {
      wrapped = new Proxy(w, {
        get(target, prop) {
          const value = p.get(target, prop, target); // receiver = target: keeps #private getters working
          if (prop === "features") return wrapFeatures(value, name);
          return value;
        }
      });
    }
    ours.add(wrapped);
    wallets.set(wallet, wrapped);
    wrappedCount++;
    return wrapped as T;
  }

  function wrapApi(api: unknown): unknown {
    if (!api || typeof api !== "object") return api;
    const register = p.get(api, "register", api);
    if (typeof register !== "function") return api;
    return Object.freeze({
      register: (...ws: unknown[]) => p.apply(register as Fn, api, ws.map((w) => wrapWallet(w)))
    });
  }

  // Wallet announces itself: replace its callback so the app's api wraps it.
  p.listen(
    win,
    REGISTER_EVENT,
    (e) => {
      if (redispatched.has(e)) return;
      const cb = p.detailOf(e);
      if (typeof cb !== "function") return;
      p.stopImmediate(e);
      const ev = p.makeEvent(REGISTER_EVENT, (api: unknown) => p.apply(cb as Fn, undefined, [wrapApi(api)]));
      redispatched.add(ev);
      p.dispatch(win, ev);
    },
    true
  );

  // App asks for wallets: hand wallets an api whose register() wraps them.
  p.listen(
    win,
    APP_READY_EVENT,
    (e) => {
      if (redispatched.has(e)) return;
      const api = p.detailOf(e);
      if (!api || typeof api !== "object") return;
      p.stopImmediate(e);
      const ev = p.makeEvent(APP_READY_EVENT, wrapApi(api));
      redispatched.add(ev);
      p.dispatch(win, ev);
    },
    true
  );

  return {
    wrapWallet,
    get wrappedCount() {
      return wrappedCount;
    }
  };
}

/* ---------- helpers shared with legacy.ts ---------- */

export function safeGet(p: Pristine, o: object, key: PropertyKey): unknown {
  try {
    return p.get(o, key, o);
  } catch {
    return undefined;
  }
}

export function findDescriptor(
  p: Pristine,
  o: object,
  key: PropertyKey
): { owner: object; desc: PropertyDescriptor } | null {
  let cur: object | null = o;
  while (cur && cur !== Object.prototype) {
    const desc = p.getOwnPropertyDescriptor(cur, key);
    if (desc) return { owner: cur, desc };
    cur = p.getPrototypeOf(cur) as object | null;
  }
  return null;
}

/** Own enumerable+non-enumerable data copy of a plain feature object. */
function copyObject(p: Pristine, o: Obj): Obj {
  const out: Obj = {};
  for (const key of p.ownKeys(o)) {
    const desc = p.getOwnPropertyDescriptor(o, key);
    if (!desc) continue;
    if ("value" in desc) out[key] = desc.value;
    else p.defineProperty(out, key, { get: () => safeGet(p, o, key), enumerable: !!desc.enumerable, configurable: true });
  }
  return out;
}

/**
 * A plain object that forwards every property (own and inherited) to `target`,
 * binding functions to it, with some keys overridden. Used when a Proxy cannot be.
 */
export function makeShim(p: Pristine, target: Obj, overrides: Record<string, () => unknown>): Obj {
  const shim: Obj = {};
  const seen = new Set<PropertyKey>();
  let cur: object | null = target;
  while (cur && cur !== Object.prototype) {
    for (const key of p.ownKeys(cur)) {
      if (key === "constructor" || seen.has(key)) continue;
      seen.add(key);
      const override = typeof key === "string" ? overrides[key] : undefined;
      p.defineProperty(shim, key, {
        get: override
          ? override
          : () => {
              const v = safeGet(p, target, key);
              return typeof v === "function" ? (v as Fn).bind(target) : v;
            },
        set: (v: unknown) => {
          try {
            (target as Obj)[key] = v;
          } catch {
            /* read-only on the target too */
          }
        },
        enumerable: true,
        configurable: true
      });
    }
    cur = p.getPrototypeOf(cur) as object | null;
  }
  for (const [key, get] of Object.entries(overrides)) {
    if (!seen.has(key)) p.defineProperty(shim, key, { get, enumerable: true, configurable: true });
  }
  return shim;
}
