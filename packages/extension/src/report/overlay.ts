// Mounts the report UI (isolated world): an extension iframe inside a closed shadow root,
// so the page can neither read nor click it. The decision comes back on a MessageChannel
// port handed to the frame together with a per-report secret that only the frame's URL
// carries; neither ever enters a page-world event or the page-reachable DOM.
//
// Fail closed while a request is held: Block, Escape, the deadline, the page removing,
// moving or restyling the host, or the frame never loading all resolve false.
import { randomId, SW_BIND, type WorkerVerdict } from "../shared/protocol.js";
import { reportMode, type ReportMode } from "./model.js";

const HOST_BASE = "all:initial!important;position:fixed!important;z-index:2147483647!important;display:block!important;margin:0!important;padding:0!important;border:0!important;opacity:1!important;visibility:visible!important;transform:none!important;filter:none!important;pointer-events:auto!important;";
const HOST_STYLE: Record<ReportMode, string> = {
  hold: `${HOST_BASE}inset:0!important;width:100vw!important;height:100vh!important`,
  info: `${HOST_BASE}inset:0!important;width:100vw!important;height:100vh!important`
};

/** Message from the frame on the port: exactly { allow: boolean }. */
export function parseFrameAnswer(data: unknown): boolean | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const keys = Object.keys(data);
  const allow = (data as { allow?: unknown }).allow;
  return keys.length === 1 && keys[0] === "allow" && typeof allow === "boolean" ? allow : null;
}

export function showReport(verdict: WorkerVerdict, deadline: number, id?: string): Promise<boolean> {
  const mode = reportMode(verdict);
  return new Promise((resolve) => {
    const secret = randomId((a) => crypto.getRandomValues(a));
    const host = document.createElement("div");
    host.setAttribute("style", HOST_STYLE[mode]);
    const root = host.attachShadow({ mode: "closed" });
    const frame = document.createElement("iframe");
    frame.title = "Kelvara ClearSign signing report";
    frame.allow = "clipboard-write";
    frame.setAttribute("style", "border:0;width:100%;height:100%;display:block;color-scheme:normal;background:transparent");
    frame.src = chrome.runtime.getURL(`report.html#${secret}`);
    root.append(frame);
    // Lets the worker answer this frame's explanation request, and only this frame's (request id + secret + tab).
    if (id && mode === "hold") void Promise.resolve(chrome.runtime.sendMessage({ type: SW_BIND, id, secret })).catch(() => {});
    const channel = new MessageChannel();
    let settled = false;
    const finish = (allow: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observer.disconnect();
      channel.port1.close();
      host.remove();
      resolve(allow && mode === "hold");
    };
    const life = mode === "hold" ? Math.max(0, deadline - Date.now()) : null;
    const timer = life === null ? undefined : setTimeout(() => finish(false), life);
    const observer = new MutationObserver((records) => {
      const tampered =
        !host.isConnected ||
        !frame.isConnected ||
        records.some((r) => (r.type === "attributes" && r.target === host) || Array.from(r.removedNodes).some((n) => n === host || n.contains(host)));
      if (tampered) finish(false);
    });
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const allow = parseFrameAnswer(event.data);
      if (allow !== null) finish(allow);
    };
    frame.addEventListener(
      "load",
      () => {
        if (settled) return;
        const origin = new URL(frame.src).origin;
        frame.contentWindow?.postMessage({ secret, verdict, deadline, id }, origin, [channel.port2]);
        frame.focus({ preventScroll: true });
      },
      { once: true }
    );
    (document.documentElement ?? document).appendChild(host);
    observer.observe(document, { childList: true, subtree: true });
    observer.observe(host, { attributes: true });
  });
}
