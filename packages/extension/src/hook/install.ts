// Main-world hook: pair with the bridge, then wrap Wallet Standard and legacy wallets.
import { pairHook, type HookChannel } from "./channel.js";
import { makeGuard } from "./guard.js";
import { installLegacyHook, type LegacyHook } from "./legacy.js";
import type { HookWindow } from "./pristine.js";
import { installWalletStandardHook, type WalletStandardHook } from "./wallet-standard.js";

export interface InstalledHook {
  channel: HookChannel;
  walletStandard: WalletStandardHook;
  legacy: LegacyHook;
}

const INSTALLED = Symbol.for("kelvara-signguard.hook");

export function installHook(win: HookWindow, opts: { timeoutMs?: number } = {}): InstalledHook | null {
  // One hook per window. The marker is non-enumerable and non-configurable.
  if (Object.prototype.hasOwnProperty.call(win, INSTALLED)) return null;
  try {
    Object.defineProperty(win, INSTALLED, { value: true, enumerable: false, configurable: false, writable: false });
  } catch {
    return null;
  }
  // Pair first: the handshake must finish before any page script exists.
  const channel = pairHook(win, opts.timeoutMs);
  const btoaFn = ((win.btoa as typeof btoa | undefined) ?? btoa).bind(win);
  const guard = makeGuard(channel, btoaFn);
  const walletStandard = installWalletStandardHook(win, guard);
  const legacy = installLegacyHook(win, guard);
  return { channel, walletStandard, legacy };
}
