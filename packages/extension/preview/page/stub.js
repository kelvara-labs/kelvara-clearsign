/* global window, location, URLSearchParams */
// Minimal chrome.* stub so popup/options render outside the extension. State via ?state=.
(() => {
  const state = new URLSearchParams(location.search).get("state") ?? "ready";
  const now = Date.now();
  const hosts = ["app.squads.so", "dapp.example", "swap.example", "claim-airdrop.example"];
  const log = [[0, true, false, 0], [4, false, false, 5], [3, false, true, 26], [2, false, true, 190]].map(([level, allow, hold, min], i) => ({ ts: now - min * 60000, url: `https://${hosts[i]}/`, level, allow, hold, wallet: "Phantom", ...(i === 0 ? { decided: "user" } : {}) }));
  const data = {
    heliusApiKey: state === "setup" || state === "options-empty" ? "" : "x".repeat(36),
    network: state === "mainnet" ? "mainnet" : "devnet",
    captureLog: state === "ready" || state === "setup" && false ? [] : state === "activity" ? log : []
  };
  const local = { get: async () => { if (state === "error") throw new Error("x"); return { ...data }; }, set: async () => {}, remove: async () => {} };
  window.chrome = { storage: { local }, permissions: { request: async () => true, contains: async () => true }, runtime: { sendMessage: async () => ({}), getURL: (p) => p } };
})();
