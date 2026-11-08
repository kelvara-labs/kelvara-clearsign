// Isolated-world content script (document_start, all frames). Listed before the
// hook in the manifest so it is listening when the hook says hello.
import { installBridge } from "./bridge/bridge.js";
import { showReport } from "./report/overlay.js";

installBridge(window, {
  // After the extension is reloaded or updated, an already-open page keeps this orphaned script and
  // chrome.runtime is gone: reject (fail closed, the request is blocked) instead of throwing.
  sendToWorker: (msg) => (typeof chrome.runtime?.sendMessage === "function" ? chrome.runtime.sendMessage(msg) : Promise.reject(new Error("ClearSign was reloaded; reload this page"))),
  showReport,
  url: () => location.href,
  topFrame: window.top === window,
  getRandomValues: (a) => crypto.getRandomValues(a)
});
