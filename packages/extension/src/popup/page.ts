import { SETTINGS_KEYS, setupSummary } from "../sw/settings.js";

interface Activity {
  ts: number;
  url: string;
  level: number | null;
  allow: boolean;
  hold: boolean;
  decided?: "user";
  wallet: string;
  kind?: "message";
}

function node(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`popup missing ${id}`);
  return found;
}

const names = { mainnet: "Mainnet", devnet: "Devnet", localnet: "Localnet" };

function activity(raw: unknown): Activity[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is Activity =>
    !!x && typeof x === "object" && Number.isFinite(x.ts) && typeof x.url === "string" &&
    (x.level === null || Number.isInteger(x.level) && x.level >= 0 && x.level <= 4) &&
    typeof x.allow === "boolean" && typeof x.hold === "boolean" && typeof x.wallet === "string"
  ).slice(0, 100);
}

const awaiting = (e: Activity) => e.hold && e.decided !== "user";
const rejected = (e: Activity) => !e.allow && !awaiting(e);

function age(ts: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - ts) / 60_000));
  if (minutes === 0) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function row(e: Activity): HTMLElement {
  const li = document.createElement("li");
  li.className = "activity-item";
  const tone = rejected(e) ? "blocked" : awaiting(e) ? "review" : "passed";
  li.dataset.tone = tone;
  const icon = document.createElement("span");
  icon.className = "activity-icon";
  icon.textContent = tone === "blocked" ? "×" : tone === "review" ? "!" : "✓";
  icon.setAttribute("aria-hidden", "true");
  const copy = document.createElement("div");
  copy.className = "activity-copy";
  const host = document.createElement("strong");
  try { host.textContent = new URL(e.url).hostname || "Signing request"; }
  catch { host.textContent = "Signing request"; }
  const detail = document.createElement("small");
  const outcome = tone === "blocked" ? "Blocked" : tone === "review" ? "Held for review" : "Passed to wallet";
  detail.textContent = `${e.kind === "message" ? "Message · " : ""}${outcome} · ${age(e.ts)}`;
  copy.append(host, detail);
  const level = document.createElement("span");
  level.className = "activity-level";
  level.textContent = e.level === null ? "No analysis" : `L${e.level}`;
  level.dataset.lv = e.level === null ? "blocked" : String(e.level);
  li.append(icon, copy, level);
  return li;
}

export async function mountPopup(): Promise<void> {
  try {
    const raw = await chrome.storage.local.get([...SETTINGS_KEYS, "captureLog"]);
    const settings = setupSummary(raw);
    const ready = settings.ready;
    node("network-name").textContent = names[settings.network];
    node("guard-status").dataset.state = ready ? "ready" : "setup";
    node("guard-label").textContent = settings.bypassed ? "Guard bypassed" : ready ? "Ready to review" : "Setup needed";
    node("guard-title").textContent = ready ? "Sign with clarity." : settings.bypassed ? "Guard is bypassed." : "Before you sign.";
    node("guard-description").textContent = settings.bypassed
      ? "Signing requests are passing through without analysis. Reset extension settings to restore the guard."
      : ready ? "See what moves. Know who gains control. Every signing request gets a closer look."
      : "Add your Helius key to review Solana transactions before your wallet opens.";
    node("guard-action-label").textContent = ready ? "Manage connection" : "Set up ClearSign";
    const entries = activity(raw.captureLog);
    node("checks-count").textContent = String(entries.length);
    node("blocked-count").textContent = String(entries.filter(rejected).length);
    node("review-count").textContent = String(entries.filter(awaiting).length);
    node("activity-list").replaceChildren(...entries.slice(0, 3).map(row));
    node("empty-state").hidden = entries.length > 0;
  } catch {
    node("guard-status").dataset.state = "error";
    node("guard-label").textContent = "Settings unavailable";
    node("popup-error").textContent = "Could not read local settings. Open settings to try again. Requests stay blocked when settings cannot be read.";
    node("popup-error").dataset.kind = "err";
  }
}
