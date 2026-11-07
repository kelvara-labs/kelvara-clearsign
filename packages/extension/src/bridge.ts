// Isolated-world content script (document_start, all frames). Listed before the
// hook in the manifest so it is listening when the hook says hello.
import { installBridge } from "./bridge/bridge.js";
import { showReport } from "./report/overlay.js";

installBridge(window, {
  sendToWorker: (msg) => chrome.runtime.sendMessage(msg),
  showReport,
  url: () => location.href,
  topFrame: window.top === window,
  getRandomValues: (a) => crypto.getRandomValues(a)
});
