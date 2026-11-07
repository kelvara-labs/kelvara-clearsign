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
  expect(disconnect).toHaveBeenCalledOnce();
  block.dispatchEvent(new Event("click"));
  expect(answer).toHaveBeenCalledWith({ allow: false });
  expect(block.disabled).toBe(true);
});
