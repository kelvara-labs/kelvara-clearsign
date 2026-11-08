// Isolated-world bridge: owns the random channel, relays hook requests to the
// service worker and the worker's decision back. Ported from the relay half of
// sol-sign-preview src/content.js (ISC); analysis moved to the service worker.
import {
  BRIDGE_READY_EVENT,
  HOOK_READY_EVENT,
  DECISION_TIMEOUT_MS,
  SW_ANALYZE,
  SW_DECIDED,
  SW_MESSAGE,
  SW_NOTICE,
  type AnalyzeMessage,
  type DecidedMessage,
  type MessageReviewMessage,
  type NoticeMessage,
  type WorkerVerdict,
  decisionEventName,
  parseHookMessage,
  randomId,
  requestEventName,
  validateWorkerVerdict
} from "../shared/protocol.js";

export interface BridgeDeps {
  sendToWorker(msg: AnalyzeMessage | MessageReviewMessage | NoticeMessage | DecidedMessage): Promise<unknown>;
  url(): string;
  topFrame: boolean;
  getRandomValues(a: Uint8Array): Uint8Array;
  /**
   * Show the report in the extension iframe. For a held verdict, resolves with the
   * user's choice (false on Block, removal, error or the deadline); otherwise it only
   * shows the report and the result is ignored. Absent: held requests are blocked.
   */
  showReport?(verdict: WorkerVerdict, deadline: number): Promise<boolean>;
  now?(): number;
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
    // The hook rejects at arrival + 90 s on its own; the report closes at the same moment.
    const deadline = (deps.now ?? Date.now)() + DECISION_TIMEOUT_MS;
    deps
      .sendToWorker(
        msg.kind === "message"
          ? { type: SW_MESSAGE, request: msg, url: deps.url(), topFrame: deps.topFrame }
          : { type: SW_ANALYZE, request: msg, url: deps.url(), topFrame: deps.topFrame }
      )
      .then(async (res) => {
        const verdict = validateWorkerVerdict(res);
        if (!verdict || verdict.allow) return false;
        if (verdict.hold) {
          if (!deps.showReport) return false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const remaining = Math.max(0, deadline - (deps.now ?? Date.now)());
          let allow = false;
          try {
            allow = await Promise.race([
              deps.showReport(verdict, deadline).then((answer) => answer === true),
              new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), remaining); })
            ]);
            allow = allow && (deps.now ?? Date.now)() < deadline;
          } finally {
            clearTimeout(timer);
          }
          deps.sendToWorker({ type: SW_DECIDED, id: msg.id, allow }).catch(() => {});
          return allow;
        }
        // Rejected reports never offer approval.
        try {
          void deps.showReport?.(verdict, deadline).catch(() => {});
        } catch {
          /* a report failure cannot change a rejection */
        }
        return verdict.allow;
      })
      .catch(() => false) // worker gone, context invalidated, bad shape, UI error: block
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
