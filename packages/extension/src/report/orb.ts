import { SW_OPEN_EXPLORER } from "../shared/protocol.js";

const B58_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Small "View on Orb" button (Orb is Helius's explorer). It is a button, not a link: a click only asks the service
 * worker to open the program's Orb page; the page itself makes no request and the click never touches a decision.
 */
export function orbButton(programId: string, programName: string, doc: Document = document, send: (msg: object) => unknown = (m) => chrome.runtime.sendMessage(m)): HTMLButtonElement | null {
  if (!B58_ID.test(programId)) return null;
  const b = doc.createElement("button");
  b.setAttribute("type", "button");
  b.className = "orb-button";
  b.setAttribute("data-orb-program", programId);
  b.setAttribute("aria-label", `View ${programName} on Orb`);
  b.setAttribute("title", `Open ${programName} on Orb, the Helius explorer`);
  const icon = doc.createElement("span");
  icon.className = "orb-icon";
  icon.setAttribute("aria-hidden", "true");
  const label = doc.createElement("span");
  label.textContent = "View on Orb";
  b.append(icon, label);
  b.addEventListener("click", () => { void Promise.resolve(send({ type: SW_OPEN_EXPLORER, programId })).catch(() => {}); });
  return b;
}
