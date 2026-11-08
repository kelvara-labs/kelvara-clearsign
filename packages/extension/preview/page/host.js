/* global document, location, fetch, MessageChannel, URLSearchParams */
const q = new URLSearchParams(location.search);
const secret = "preview-secret";
const frame = document.getElementById("frame");
fetch("verdicts.json").then((r) => r.json()).then((all) => {
  const verdict = all[q.get("case") ?? "L3"];
  const explain = q.get("explain");
  frame.src = `report.html${explain ? `?explain=${explain}` : ""}#${secret}`;
  frame.addEventListener("load", () => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => { document.title = `answer:${JSON.stringify(e.data)}`; };
    frame.contentWindow.postMessage({ secret, verdict, deadline: Date.now() + 90000, id: "0123456789abcdef0123456789abcdef" }, location.origin, [channel.port2]);
  }, { once: true });
});
