// Isolated-world bridge: owns the random channel, relays hook requests to the
// service worker and the worker's decision back. Ported from the relay half of
// sol-sign-preview src/content.js (ISC); analysis moved to the service worker.
import {
  BRIDGE_READY_EVENT,
  HOOK_READY_EVENT,
  SW_ANALYZE,
  SW_NOTICE,
  type AnalyzeMessage,
  type NoticeMessage,
  decisionEventName,
  parseHookMessage,
  randomId,
  requestEventName,
  validateWorkerVerdict
} from "../shared/protocol.js";

export interface BridgeDeps {
  sendToWorker(msg: AnalyzeMessage | NoticeMessage): Promise<unknown>;
  url(): string;
  topFrame: boolean;
  getRandomValues(a: Uint8Array): Uint8Array;
}

export interface Bridge {
  readonly channel: string;
  readonly paired: boolean;
}

export function installBridge(win: EventTarget, deps: BridgeDeps): Bridge {
  const channel = randomId(deps.getRandomValues);
  let paired = false;
  const seen = new Set<string>();

  const emit = (type: string, detail: string) =>
    win.dispatchEvent(new CustomEvent(type, { detail, bubbles: false, cancelable: false, composed: false }));

  const onHookReady = (): void => {
    if (paired) return;
    paired = true;
    win.removeEventListener(HOOK_READY_EVENT, onHookReady);
    win.addEventListener(requestEventName(channel), onRequest);
    emit(BRIDGE_READY_EVENT, JSON.stringify({ v: 1, channel }));
  };

  const reply = (id: string, allow: boolean) =>
    emit(decisionEventName(channel), JSON.stringify({ v: 1, kind: "decision", id, allow }));

  const onRequest = (e: Event): void => {
    const msg = parseHookMessage((e as CustomEvent).detail);
    if (!msg || seen.has(msg.id)) return;
    seen.add(msg.id);
    if (msg.kind === "notice") {
      deps.sendToWorker({ type: SW_NOTICE, notice: msg, url: deps.url(), topFrame: deps.topFrame }).catch(() => {});
      return;
    }
    deps
      .sendToWorker({ type: SW_ANALYZE, request: msg, url: deps.url(), topFrame: deps.topFrame })
      .then((res) => validateWorkerVerdict(res)?.allow === true)
      .catch(() => false) // worker gone, context invalidated, bad shape: block
      .then((allow) => reply(msg.id, allow));
  };

  win.addEventListener(HOOK_READY_EVENT, onHookReady);

  return {
    channel,
    get paired() {
      return paired;
    }
  };
}
