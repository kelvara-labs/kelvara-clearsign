// Module service worker: validates bridge messages, runs analysis, decides.
// Never signs, never submits, never stores wallet secrets.
import {
  SW_ANALYZE,
  SW_NOTICE,
  validateNotice,
  validateSignRequest,
  type WorkerVerdict
} from "./shared/protocol.js";
import { stubEngine } from "./sw/engine-stub.js";
import { decide } from "./sw/policy.js";
import { SETTINGS_KEYS, readSettings } from "./sw/settings.js";

const LOG_KEY = "captureLog";
const LOG_MAX = 100;

interface LogEntry {
  ts: number;
  url: string;
  method: string;
  wallet: string;
  chain: string | null;
  txCount: number;
  level: number | null;
  allow: boolean;
  reason: string;
}

async function appendLog(entry: LogEntry): Promise<void> {
  try {
    const got = await chrome.storage.local.get(LOG_KEY);
    const log = Array.isArray(got[LOG_KEY]) ? (got[LOG_KEY] as LogEntry[]) : [];
    log.unshift(entry);
    await chrome.storage.local.set({ [LOG_KEY]: log.slice(0, LOG_MAX) });
  } catch {
    /* logging never affects the decision */
  }
}

const blocked = (reason: string): WorkerVerdict => ({ allow: false, level: null, reason });

async function handleAnalyze(msg: Record<string, unknown>): Promise<WorkerVerdict> {
  const req = validateSignRequest(msg.request);
  if (!req || typeof msg.url !== "string") return blocked("malformed request");
  const settings = readSettings(await chrome.storage.local.get([...SETTINGS_KEYS]));
  const verdict = await decide(req, settings, stubEngine);
  await appendLog({
    ts: Date.now(),
    url: msg.url.slice(0, 512),
    method: req.method,
    wallet: req.wallet,
    chain: req.chain,
    txCount: req.txs.length,
    level: verdict.level,
    allow: verdict.allow,
    reason: verdict.reason
  });
  return verdict;
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  // Only our own content scripts, inside a tab.
  if (sender.id !== chrome.runtime.id || !sender.tab) return false;
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  if (m.type === SW_ANALYZE) {
    handleAnalyze(m)
      .catch(() => blocked("service worker error"))
      .then(sendResponse);
    return true; // async response
  }
  if (m.type === SW_NOTICE) {
    if (validateNotice(m.notice)) {
      // The report UI will show this notice; for now it is only counted.
      console.info("[kelvara-signguard] message-signing request passed through with a notice");
    }
    return false;
  }
  return false;
});
