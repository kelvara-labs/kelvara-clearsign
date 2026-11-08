// "View on Orb": the report frame and the options page ask the worker to open a program's Orb page. The frame
// has no link and makes no request; the worker validates the sender and the id, then opens a tab.
import { SW_OPEN_EXPLORER } from "../shared/protocol.js";

const B58_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const ORB_ADDRESS_URL = "https://orbmarkets.io/address/";

export const isProgramId = (x: unknown): x is string => typeof x === "string" && B58_ID.test(x);
export const orbUrl = (programId: string): string | null => (isProgramId(programId) ? `${ORB_ADDRESS_URL}${programId}` : null);

/** The exact request shape: {type, programId} and nothing else. */
export function openExplorerRequest(msg: unknown): string | null {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const m = msg as Record<string, unknown>;
  return Object.keys(m).length === 2 && m.type === SW_OPEN_EXPLORER && isProgramId(m.programId) ? m.programId : null;
}

/** Sender must be this extension's own report.html or options.html (top frame; the report URL may carry a #secret). */
export function explorerSenderOk(sender: { id?: string; url?: string; frameId?: number }, ext: { id: string; reportUrl: string; optionsUrl: string }): boolean {
  if (sender.id !== ext.id || !sender.url) return false;
  const url = sender.url.split("#")[0];
  return (url === ext.reportUrl || url === ext.optionsUrl) && (url !== ext.optionsUrl || (sender.frameId ?? 0) === 0);
}

/** true when a tab was opened. Never throws. */
export async function handleOpenExplorer(msg: unknown, sender: { id?: string; url?: string; frameId?: number }, ext: { id: string; reportUrl: string; optionsUrl: string }, tabs: { create(p: { url: string }): Promise<unknown> }): Promise<boolean> {
  const id = openExplorerRequest(msg);
  if (!id || !explorerSenderOk(sender, ext)) return false;
  try {
    await tabs.create({ url: `${ORB_ADDRESS_URL}${id}` });
    return true;
  } catch {
    return false;
  }
}
