import { afterEach, expect, it, vi } from "vitest";
import { showReport } from "../src/report/overlay.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([0, 1] as const)("L%s overlay blocks on deadline, removal or frame failure and accepts only explicit answer", async (level) => {
  vi.useFakeTimers();
  const host = { setAttribute: vi.fn(), attachShadow: () => ({ append: vi.fn() }), remove: vi.fn(), isConnected: true };
  const frame = { title: "", src: "", isConnected: true, setAttribute: vi.fn(), addEventListener: vi.fn(), contentWindow: null };
  let mutation!: MutationCallback;
  const port = { close: vi.fn(), onmessage: null as null | ((event: { data: unknown }) => void) };
  vi.stubGlobal("document", {
    createElement: (tag: string) => tag === "div" ? host : frame,
    documentElement: { appendChild: vi.fn() }
  });
  vi.stubGlobal("chrome", { runtime: { getURL: (p: string) => "chrome-extension://test/" + p } });
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: MutationCallback) { mutation = callback; }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("MessageChannel", class { port1 = port; port2 = {}; });
  const verdict = { allow: false, hold: true, level, reason: "Review", report: null } as const;
  let result = showReport(verdict, Date.now() + 1000);
  vi.advanceTimersByTime(1000);
  expect(await result).toBe(false);
  result = showReport(verdict, Date.now() + 1000);
  host.isConnected = false;
  mutation([], {} as MutationObserver);
  expect(await result).toBe(false);
  host.isConnected = true;
  result = showReport(verdict, Date.now() + 1000);
  port.onmessage!({ data: { allow: false } });
  expect(await result).toBe(false);
  result = showReport(verdict, Date.now() + 1000);
  port.onmessage!({ data: { allow: true } });
  expect(await result).toBe(true);
  // A frame that never loads never gets a chance to approve.
  result = showReport(verdict, Date.now() + 1000);
  vi.advanceTimersByTime(1000);
  expect(await result).toBe(false);
  expect(host.remove).toHaveBeenCalledTimes(5);
});
