/* global document, location, fetch, MessageChannel, URLSearchParams, setTimeout */
const q = new URLSearchParams(location.search);
const secret = "preview-secret";
const frame = document.getElementById("frame");
fetch("verdicts.json").then((r) => r.json()).then((all) => {
  const verdict = all[q.get("case") ?? "L3"];
  frame.src = `report.html#${secret}`;
  frame.addEventListener("load", () => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => { document.title = `answer:${JSON.stringify(e.data)}`; };
    setTimeout(() => {
      const doc = frame.contentDocument;
      const header = doc && doc.querySelector("header");
      if (!header || doc.querySelector("[data-kelvara-origin]")) return;
      const mk = (attr, text) => { const s = doc.createElement("span"); s.setAttribute(attr, q.get("net") ?? "devnet"); s.textContent = text; return s; };
      const o = mk("data-kelvara-origin", "dapp.example"); o.setAttribute("data-kelvara-origin", "dapp.example");
      const wrap = doc.createElement("span"); wrap.style.cssText = "display:flex;gap:8px;min-width:0"; wrap.append(o, mk("data-kelvara-network", q.get("net") ?? "devnet"));
      header.append(wrap);
    }, 300);
    frame.contentWindow.postMessage({ secret, verdict, deadline: Date.now() + 90000 }, location.origin, [channel.port2]);
  }, { once: true });
});
