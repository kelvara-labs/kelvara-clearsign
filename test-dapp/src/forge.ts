// A hostile page's attempts to approve its own signing request without the user.
// Used by G7: "A page that forges an approval message gets a rejection and the
// wallet is never called." Every attempt is logged so the spec can show what was tried.

const PREFIX = "kelvara-signguard";
const HOOK_READY = `${PREFIX}:hook-ready`;
const BRIDGE_READY = `${PREFIX}:bridge-ready`;
const CHANNEL_RE = /^kelvara-signguard:([0-9a-f]{32}):req$/;

export interface ForgeReport {
  attempts: string[];
  /** Channel ids the page managed to learn. Must stay empty. */
  learnedChannels: string[];
  /** Request ids the page saw and answered with allow. Must stay empty. */
  answeredRequests: string[];
}

function allow(id: string): string {
  return JSON.stringify({ v: 1, kind: "decision", id, allow: true });
}

function randomHex(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Start forging. Installs sniffers on the page's own EventTarget/CustomEvent (which a
 * correct hook does not use), re-runs the pairing handshake hoping the bridge answers
 * again, and keeps posting approval-shaped messages until stop() is called.
 */
export function startForging(win: Window & typeof globalThis): { stop(): void; report: ForgeReport } {
  const report: ForgeReport = { attempts: [], learnedChannels: [], answeredRequests: [] };
  const learned = new Set<string>();

  const learn = (channel: string, how: string) => {
    if (learned.has(channel)) return;
    learned.add(channel);
    report.learnedChannels.push(channel);
    report.attempts.push(`learned channel via ${how}`);
    win.addEventListener(`${PREFIX}:${channel}:req`, (e) => answer(channel, (e as CustomEvent).detail));
  };
  const answer = (channel: string, detail: unknown) => {
    try {
      const req = JSON.parse(String(detail)) as { id?: unknown };
      if (typeof req.id !== "string") return;
      report.answeredRequests.push(req.id);
      win.dispatchEvent(new CustomEvent(`${PREFIX}:${channel}:res`, { detail: allow(req.id) }));
    } catch {
      /* not a request */
    }
  };

  // 1. Sniff: patch dispatchEvent and CustomEvent so any request event created with the
  //    page's own (patched) globals leaks its channel.
  const origDispatch = win.EventTarget.prototype.dispatchEvent;
  win.EventTarget.prototype.dispatchEvent = function (this: EventTarget, ev: Event) {
    const m = CHANNEL_RE.exec(ev.type);
    if (m) {
      learn(m[1]!, "patched dispatchEvent");
      answer(m[1]!, (ev as CustomEvent).detail);
    }
    return origDispatch.call(this, ev);
  };
  const OrigCustomEvent = win.CustomEvent;
  win.CustomEvent = class extends OrigCustomEvent<unknown> {
    constructor(type: string, init?: CustomEventInit) {
      super(type, init);
      const m = CHANNEL_RE.exec(type);
      if (m) learn(m[1]!, "patched CustomEvent");
    }
  } as typeof CustomEvent;
  report.attempts.push("patched EventTarget.prototype.dispatchEvent and CustomEvent");

  // 2. Replay the handshake: if the bridge answers a second hook-ready, the page learns the channel.
  const onBridgeReady = (e: Event) => {
    try {
      const o = JSON.parse(String((e as CustomEvent).detail)) as { channel?: unknown };
      if (typeof o.channel === "string" && /^[0-9a-f]{32}$/.test(o.channel)) learn(o.channel, "replayed handshake");
    } catch {
      /* ignore */
    }
  };
  win.addEventListener(BRIDGE_READY, onBridgeReady);
  origDispatch.call(win, new OrigCustomEvent(HOOK_READY, { detail: null }));
  report.attempts.push("replayed hook-ready handshake");
  // The bridge answers synchronously if it answers at all; stop listening before we send our own.
  win.removeEventListener(BRIDGE_READY, onBridgeReady);

  // 3. Offer the hook a channel of our own, then approve on it.
  const fake = randomHex();
  origDispatch.call(win, new OrigCustomEvent(BRIDGE_READY, { detail: JSON.stringify({ v: 1, channel: fake }) }));
  report.attempts.push("offered a fake bridge-ready channel");

  // 4. Keep spraying approvals: old sol-sign-preview postMessage shapes and decisions on the fake channel.
  const spray = () => {
    win.postMessage({ source: "sol-sign-preview", type: "decision", approved: true }, "*");
    win.postMessage({ type: "SIGN_DECISION", approved: true, allow: true }, "*");
    win.postMessage({ v: 1, kind: "decision", id: randomHex(), allow: true }, "*");
    origDispatch.call(win, new OrigCustomEvent(`${PREFIX}:${fake}:res`, { detail: allow(randomHex()) }));
    for (const ch of learned) origDispatch.call(win, new OrigCustomEvent(`${PREFIX}:${ch}:res`, { detail: allow(randomHex()) }));
  };
  spray();
  const timer = win.setInterval(spray, 100);
  report.attempts.push("sprayed approval postMessages and decision events every 100 ms");

  return {
    report,
    stop() {
      win.clearInterval(timer);
      win.removeEventListener(BRIDGE_READY, onBridgeReady);
      win.EventTarget.prototype.dispatchEvent = origDispatch;
      win.CustomEvent = OrigCustomEvent;
    }
  };
}
