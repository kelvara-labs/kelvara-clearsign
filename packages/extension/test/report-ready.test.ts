import { afterEach, expect, it, vi } from "vitest";
import { mountReport } from "../src/report/page.js";

class Element extends EventTarget {
  children: unknown[] = [];
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  disabled = false;
  textContent = "";
  focus = vi.fn();
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  append(...children: unknown[]) { this.children.push(...children); }
  replaceChildren(...children: unknown[]) { this.children = children; }
}

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])("waits for intersection and two paint frames; answered early=%s never reopens", (answeredEarly) => {
  const win = new EventTarget();
  const doc = new EventTarget();
  const elements: Element[] = [];
  const frames: FrameRequestCallback[] = [];
  let intersect!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal("window", win);
  vi.stubGlobal("parent", win);
  vi.stubGlobal("location", { hash: "#report-secret" });
  vi.stubGlobal("document", Object.assign(doc, {
    documentElement: new Element(), body: new Element(),
    createElement: () => { const e = new Element(); elements.push(e); return e; }
  }));
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const answer = vi.fn();
  mountReport();
  const event = new Event("message");
  Object.assign(event, {
    source: win,
    data: { secret: "report-secret", verdict: { allow: false, hold: false, level: 4, reason: "blocked", report: null }, deadline: Date.now() + 90000 },
    ports: [{ postMessage: answer }]
  });
  win.dispatchEvent(event);
  const block = elements.find((e) => e.attrs["data-kelvara-action"] === "block")!;
  expect(block.disabled).toBe(true);
  expect(block.focus).not.toHaveBeenCalled();
  intersect([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver);
  expect(frames).toHaveLength(0);
  intersect([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver);
  frames.shift()!(0);
  expect(block.disabled).toBe(true);
  if (answeredEarly) {
    const escape = new Event("keydown");
    Object.assign(escape, { key: "Escape" });
    doc.dispatchEvent(escape);
  }
  frames.shift()!(16);
  expect(block.disabled).toBe(answeredEarly);
  expect(block.focus).toHaveBeenCalledTimes(answeredEarly ? 0 : 1);
  if (!answeredEarly) expect(block.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(disconnect).toHaveBeenCalledOnce();
  block.dispatchEvent(new Event("click"));
  expect(answer).toHaveBeenCalledWith({ allow: false });
  expect(block.disabled).toBe(true);
});


it.each([0, 1, 2, 3] as const)("L%s approval uses the visibility gate and rejects untrusted clicks", (level) => {
  vi.useFakeTimers();
  try {
    const win = new EventTarget();
    const doc = new EventTarget();
    const elements: Element[] = [];
    const observers: IntersectionObserverCallback[] = [];
    vi.stubGlobal("window", win);
    vi.stubGlobal("parent", win);
    vi.stubGlobal("location", { hash: "#report-secret" });
    vi.stubGlobal("document", Object.assign(doc, {
      documentElement: new Element(), body: new Element(),
      createElement: () => { const e = new Element(); elements.push(e); return e; }
    }));
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { fn(0); return 1; });
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { observers.push(callback); }
      observe() {}
      disconnect() {}
    });
    const answer = vi.fn();
    mountReport();
    const event = new Event("message");
    Object.assign(event, {
      source: win,
      data: { secret: "report-secret", verdict: { allow: false, hold: true, level, reason: "review", report: null }, deadline: Date.now() + 90000 },
      ports: [{ postMessage: answer }]
    });
    win.dispatchEvent(event);
    const action = level < 2 ? "continue" : "sign-anyway";
    const sign = elements.find((e) => e.attrs["data-kelvara-action"] === action)!;
    expect(sign).toBeDefined();
    if (level < 2) expect(sign.children).toContain("Continue to wallet");
    expect(sign.attrs["data-armed"]).toBe("false");
    observers[1]!([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver);
    expect(sign.disabled).toBe(false);
    sign.dispatchEvent(new Event("click"));
    expect(answer).not.toHaveBeenCalled();
    observers[0]!([{ isVisible: true }] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver);
    vi.advanceTimersByTime(600);
    sign.dispatchEvent(new Event("click"));
    expect(answer).not.toHaveBeenCalled();
    const escape = new Event("keydown");
    Object.assign(escape, { key: "Escape" });
    doc.dispatchEvent(escape);
    expect(answer).toHaveBeenCalledWith({ allow: false });
  } finally {
    vi.useRealTimers();
  }
});
