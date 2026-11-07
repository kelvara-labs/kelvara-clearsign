// Main-world content script (document_start, all frames). No exports: classic script.
import { installHook } from "./hook/install.js";
import type { HookWindow } from "./hook/pristine.js";

const installed = installHook(window as unknown as HookWindow);
if (installed && !installed.channel.paired) {
  // Fail closed: every signing call in this frame will be rejected.
  console.warn("[kelvara-signguard] no extension channel in this frame; signing requests will be blocked");
}
