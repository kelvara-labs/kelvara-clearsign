// What every wrapped wallet method calls: hold the bytes, wait for the extension.
import { b64encode } from "../shared/codec.js";
import {
  MAX_TX_BYTES,
  MAX_TXS,
  MAX_WALLET_NAME,
  isChain,
  type NoticeMethod,
  type SignMethod
} from "../shared/protocol.js";
import type { HookChannel } from "./channel.js";

export interface Guard {
  /** true only when the extension explicitly allows; never throws. */
  hold(method: SignMethod, wallet: string, chain: unknown, txs: Uint8Array[]): Promise<boolean>;
  notice(method: NoticeMethod, wallet: string): void;
}

/** The error a wallet raises when the user rejects: dApps already handle it. */
export function rejection(): Error {
  const err = new Error("User rejected the request.") as Error & { code: number };
  err.code = 4001;
  return err;
}

export function cleanWalletName(name: unknown, fallback: string): string {
  const s = typeof name === "string" ? name.trim() : "";
  return (s || fallback).slice(0, MAX_WALLET_NAME);
}

export function makeGuard(channel: HookChannel, btoaFn: (s: string) => string): Guard {
  return {
    async hold(method, wallet, chain, txs) {
      try {
        if (txs.length < 1 || txs.length > MAX_TXS) return false;
        if (txs.some((t) => t.length < 1 || t.length > MAX_TX_BYTES)) return false;
        return await channel.hold({
          method,
          wallet: cleanWalletName(wallet, "unknown"),
          chain: isChain(chain) ? chain : null,
          txs: txs.map((t) => b64encode(t, btoaFn))
        });
      } catch {
        return false;
      }
    },
    notice(method, wallet) {
      try {
        channel.notice(method, cleanWalletName(wallet, "unknown"));
      } catch {
        /* a notice never blocks the call */
      }
    }
  };
}
