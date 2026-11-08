// Main-world end of the page channel. See shared/protocol.ts for the threat model.
import {
  BRIDGE_READY_EVENT,
  DECISION_TIMEOUT_MS,
  HOOK_READY_EVENT,
  type Chain,
  type MessageMethod,
  type NoticeMethod,
  type SignInInput,
  type SignMethod,
  decisionEventName,
  parseDecision,
  parseHandshake,
  randomId,
  requestEventName
} from "../shared/protocol.js";
import { pristine, type HookWindow } from "./pristine.js";

export interface HoldRequest {
  method: SignMethod;
  wallet: string;
  account: string | null;
  chain: Chain | null;
  txs: string[];
}

export interface MessageHoldRequest {
  method: MessageMethod;
  wallet: string;
  account: string | null;
  chain: Chain | null;
  message: string | null;
  signIn: SignInInput | null;
}

export interface HookChannel {
  readonly paired: boolean;
  /** Resolves true only on an explicit allow from the extension; false on block, timeout or no channel. */
  hold(req: HoldRequest): Promise<boolean>;
  /** Same as hold, for a message-signing call. */
  holdMessage(req: MessageHoldRequest): Promise<boolean>;
  notice(method: NoticeMethod, wallet: string): void;
}

/**
 * Pair with the bridge. Must run synchronously at document_start before any page
 * script: the channel is accepted only inside this call. If the bridge did not
 * answer by the time this returns, the hook stays unpaired and holds resolve false.
 */
export function pairHook(win: HookWindow, timeoutMs = DECISION_TIMEOUT_MS): HookChannel {
  const p = pristine(win);
  let channel: string | null = null;

  const onBridgeReady = (e: Event): void => {
    if (channel !== null) return;
    channel = parseHandshake(p.detailOf(e));
  };
  p.listen(win, BRIDGE_READY_EVENT, onBridgeReady);
  p.emit(win, HOOK_READY_EVENT, null);
  p.unlisten(win, BRIDGE_READY_EVENT, onBridgeReady);

  // Pending requests: null-prototype dictionary, so page edits to Map.prototype do not reach us.
  const pending: Record<string, (allow: boolean) => void> = p.ObjectCreate(null);

  if (channel !== null) {
    p.listen(win, decisionEventName(channel), (e: Event) => {
      const d = parseDecision(p.detailOf(e));
      if (!d) return;
      const settle = pending[d.id];
      if (!settle) return;
      delete pending[d.id];
      settle(d.allow);
    });
  }

  return {
    get paired() {
      return channel !== null;
    },
    hold: (req) => request("sign", req),
    holdMessage: (req) => request("message", req),
    notice(method, wallet) {
      if (channel === null) return;
      const id = randomId(p.getRandomValues);
      p.emit(win, requestEventName(channel), p.stringify({ v: 1, kind: "notice", id, method, wallet }));
    }
  };

  function request(kind: "sign" | "message", req: HoldRequest | MessageHoldRequest): Promise<boolean> {
    if (channel === null) return Promise.resolve(false);
    const ch = channel;
    return new p.Promise<boolean>((resolve) => {
      const id = randomId(p.getRandomValues);
      const timer = p.setTimeout(() => {
        if (pending[id]) {
          delete pending[id];
          resolve(false);
        }
      }, timeoutMs);
      pending[id] = (allow) => {
        p.clearTimeout(timer);
        resolve(allow);
      };
      p.emit(win, requestEventName(ch), p.stringify({ v: 1, kind, id, ...req }));
    });
  }
}
