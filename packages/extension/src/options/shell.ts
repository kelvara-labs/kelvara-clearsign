// Presentational glue for the options layout (nav highlight, header status chip, segmented network control,
// AI status pill, "Saved" badges, version). Never reads or writes settings: it mirrors DOM state that
// page.ts / ai-page.ts already set, and drives the existing #network select like a user would.
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const NETWORKS: [string, string, string][] = [
  ["mainnet", "Mainnet", "Mainnet · real assets."],
  ["devnet", "Devnet", "Devnet · demo and testing."],
  ["localnet", "Localnet", "Localnet · local development."]
];

export function mountShell(): void {
  try {
    const version = `v${(chrome.runtime as unknown as { getManifest(): { version: string } }).getManifest().version}`;
    for (const id of ["app-version", "about-version"]) {
      const e = $(id);
      if (e) e.textContent = version;
    }
  } catch {
    /* keep the static fallback */
  }

  const select = $<HTMLSelectElement>("network");
  const hint = $("network-hint");
  const defaultHint = hint?.textContent ?? "";
  if (select && select.parentElement) {
    const group = document.createElement("div");
    group.className = "segmented";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Default network");
    const buttons = NETWORKS.map(([value, label]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.dataset.value = value;
      b.textContent = label;
      b.addEventListener("click", () => {
        if (select.value === value) return;
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        sync();
      });
      return b;
    });
    group.append(...buttons);
    group.addEventListener("keydown", (e) => {
      const i = buttons.findIndex((b) => b === document.activeElement);
      if (i < 0 || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();
      const next = buttons[(i + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? buttons.length - 1 : 1)) % buttons.length]!;
      next.focus();
      next.click();
    });
    select.parentElement.prepend(group);
    select.classList.add("visually-hidden");
    select.setAttribute("tabindex", "-1");
    select.setAttribute("aria-hidden", "true");
    const sync = () => {
      for (const b of buttons) {
        const on = b.dataset.value === select.value;
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
      }
      const meta = NETWORKS.find(([v]) => v === select.value);
      if (hint && meta) hint.textContent = `${meta[2]} ${defaultHint}`;
    };
    sync();
    select.addEventListener("change", sync);
    // page.ts sets select.value programmatically (no event): mirror it cheaply.
    const poll = setInterval(sync, 300);
    window.addEventListener("pagehide", () => clearInterval(poll));
  }

  const chip = $("status-chip");
  const chipLabel = $("status-chip-label");
  const indicator = $("setup-indicator");
  const label = $("setup-label");
  const updateChip = () => {
    if (!chip || !chipLabel || !indicator) return;
    const text = label?.textContent ?? "";
    const state = /^Reading/.test(text) ? "checking" : /unavailable/i.test(text) ? "unavailable" : indicator.dataset.ready === "true" ? "ready" : "setup";
    chip.dataset.state = state;
    chipLabel.textContent = { checking: "Checking", ready: "Ready", setup: "Needs setup", unavailable: "Unavailable" }[state];
  };
  if (indicator) {
    new MutationObserver(updateChip).observe(indicator, { attributes: true, childList: true, subtree: true, characterData: true });
    updateChip();
  }

  const aiStatus = $("ai-status");
  const aiEnabled = $<HTMLInputElement>("ai-enabled");
  const aiKey = $<HTMLInputElement>("ai-key");
  const updateAi = () => {
    if (!aiStatus || !aiEnabled) return;
    const state = aiEnabled.checked ? "on" : aiKey?.placeholder.startsWith("Saved key") ? "configured" : "off";
    aiStatus.dataset.state = state;
    aiStatus.textContent = { on: "Enabled", configured: "Configured", off: "Off" }[state];
  };
  aiEnabled?.addEventListener("change", updateAi);
  const aiPoll = setInterval(updateAi, 400);
  window.addEventListener("pagehide", () => clearInterval(aiPoll));
  updateAi();

  const badges = document.querySelectorAll<HTMLElement>("#sec-connection .saved-badge, #sec-network .saved-badge");
  const result = $("result");
  const hide = () => badges.forEach((b) => (b.hidden = true));
  if (result) new MutationObserver(() => { if (result.dataset.kind === "ok" && /saved/i.test(result.textContent ?? "")) badges.forEach((b) => (b.hidden = false)); }).observe(result, { attributes: true, childList: true, characterData: true, subtree: true });
  $("helius-key")?.addEventListener("input", hide);
  select?.addEventListener("change", hide);

  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".side a"));
  const targets = links.map((a) => document.querySelector(a.getAttribute("href") ?? ""));
  const mark = (id: string) => links.forEach((a) => a.toggleAttribute("aria-current", a.getAttribute("href") === `#${id}`));
  mark("sec-connection");
  try {
    const io = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) mark(top.target.id);
    }, { rootMargin: "-80px 0px -60% 0px" });
    for (const t of targets) if (t) io.observe(t);
  } catch {
    /* no highlight */
  }
  for (const a of links) a.addEventListener("click", () => mark(a.getAttribute("href")!.slice(1)));
}
