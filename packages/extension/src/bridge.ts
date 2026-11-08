// Isolated-world content script (document_start, all frames). Listed before the
// hook in the manifest so it is listening when the hook says hello.
import { installBridge } from "./bridge/bridge.js";
import { showReport } from "./report/overlay.js";

installBridge(window, {
  // After the extension is reloaded or updated, an already-open page keeps this orphaned script and
  // chrome.runtime is gone: reject (fail closed, the request is blocked) instead of throwing.
  sendToWorker: (msg) => {
    try {
      if (typeof chrome.runtime?.sendMessage !== "function") throw new Error("no runtime");
      return chrome.runtime.sendMessage(msg);
    } catch {
      // "Extension context invalidated": a reload left this script orphaned. Fail closed: the request is rejected.
      return Promise.reject(new Error("ClearSign was reloaded; reload this page"));
    }
  },
  showReport,
  url: () => location.href,
  topFrame: window.top === window,
  getRandomValues: (a) => crypto.getRandomValues(a)
});
