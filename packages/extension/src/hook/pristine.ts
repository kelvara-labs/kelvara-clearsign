// References captured at document_start, before any page script runs, so a page
// that later patches EventTarget, JSON, CustomEvent or Promise cannot see or steer
// our traffic. Captured once per window object.

export type HookWindow = EventTarget & Record<string, unknown>;

export interface Pristine {
  listen(t: EventTarget, type: string, fn: (e: Event) => void, capture?: boolean): void;
  unlisten(t: EventTarget, type: string, fn: (e: Event) => void, capture?: boolean): void;
  emit(t: EventTarget, type: string, detail: string | null): void;
  /** Dispatch an already-built event. */
  dispatch(t: EventTarget, e: Event): void;
  makeEvent(type: string, detail: unknown): Event;
  detailOf(e: Event): unknown;
  stopImmediate(e: Event): void;
  stringify(v: unknown): string;
  getRandomValues(a: Uint8Array): Uint8Array;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  Promise: PromiseConstructor;
  ObjectCreate: typeof Object.create;
  defineProperty: typeof Object.defineProperty;
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor;
  getPrototypeOf: typeof Object.getPrototypeOf;
  ownKeys: typeof Reflect.ownKeys;
  apply: typeof Reflect.apply;
  get: typeof Reflect.get;
}

const cache = new WeakMap<object, Pristine>();

export function pristine(win: HookWindow): Pristine {
  const hit = cache.get(win);
  if (hit) return hit;
  const apply = Reflect.apply;
  const ET = EventTarget.prototype;
  const add = ET.addEventListener;
  const remove = ET.removeEventListener;
  const dispatch = ET.dispatchEvent;
  const stopImm = Event.prototype.stopImmediatePropagation;
  const stopProp = Event.prototype.stopPropagation;
  const CE = ((win.CustomEvent as typeof CustomEvent | undefined) ?? CustomEvent);
  const detailGet = Object.getOwnPropertyDescriptor(CE.prototype, "detail")?.get;
  const stringify = JSON.stringify;
  const cryptoObj = (win.crypto as Crypto | undefined) ?? crypto;
  const grv = cryptoObj.getRandomValues;
  const st = (win.setTimeout as typeof setTimeout | undefined) ?? setTimeout;
  const ct = (win.clearTimeout as typeof clearTimeout | undefined) ?? clearTimeout;
  const makeEvent = (type: string, detail: unknown): Event =>
    new CE(type, { detail, bubbles: false, cancelable: false, composed: false });

  const p: Pristine = {
    listen: (t, type, fn, capture = false) => apply(add, t, [type, fn, capture]),
    unlisten: (t, type, fn, capture = false) => apply(remove, t, [type, fn, capture]),
    emit: (t, type, detail) => {
      apply(dispatch, t, [makeEvent(type, detail)]);
    },
    dispatch: (t, e) => {
      apply(dispatch, t, [e]);
    },
    makeEvent,
    detailOf: (e) => {
      // Wallet Standard events are Event subclasses with their own `detail` getter.
      if (detailGet && e instanceof CE) return apply(detailGet, e, []);
      return (e as Event & { detail?: unknown }).detail;
    },
    stopImmediate: (e) => {
      try {
        apply(stopImm, e, []);
      } catch {
        // Wallet Standard events override stop*() to throw; some runtimes route the
        // native stopImmediatePropagation through them. Shadow with the native one, retry.
        Object.defineProperty(e, "stopPropagation", { value: stopProp, configurable: true });
        Object.defineProperty(e, "stopImmediatePropagation", { value: stopImm, configurable: true });
        apply(stopImm, e, []);
      }
    },
    stringify: (v) => apply(stringify, JSON, [v]) as string,
    getRandomValues: (a) => apply(grv, cryptoObj, [a]) as Uint8Array,
    setTimeout: (fn, ms) => apply(st, win, [fn, ms]),
    clearTimeout: (h) => apply(ct, win, [h]),
    Promise,
    ObjectCreate: Object.create,
    defineProperty: Object.defineProperty,
    getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    getPrototypeOf: Object.getPrototypeOf,
    ownKeys: Reflect.ownKeys,
    apply,
    get: Reflect.get
  };
  cache.set(win, p);
  return p;
}
