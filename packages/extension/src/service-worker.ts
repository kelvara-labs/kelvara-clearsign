import { handleProviderTest } from "./sw/provider-test.js";
import { enhanceIntent } from "./intent/enhance.js";
import { ExplainStore, reportFrameUrl } from "./sw/explain.js";
// Module service worker: validates bridge messages, runs analysis, decides.
// Never signs, never submits, never stores wallet secrets.
import {
  SW_ANALYZE,
  SW_BIND,
  SW_DECIDED,
  SW_EXPLAIN,
  SW_MESSAGE,
  SW_NOTICE,
  isId,
  validateMessageRequest,
  validateNotice,
  validateSignRequest,
  type WorkerVerdict
} from "./shared/protocol.js";
import { realEngine } from "./sw/engine.js";
import { networkFor } from "./sw/endpoint.js";
import { messageVerdict, reviewMessage } from "./sw/message-review.js";
import { withContext } from "./sw/report-context.js";
import { decide } from "./sw/policy.js";
import { SETTINGS_KEYS, loadSettings, readSettings } from "./sw/settings.js";

const LOG_KEY = "captureLog";
const LOG_MAX = 100;

interface LogEntry {
  ts: number;
  /** The hook's random request id, so the user's decision on a held request can be recorded. */
  id: string;
  url: string;
  method: string;
  wallet: string;
  chain: string | null;
  txCount: number;
  /** "message": a signMessage / signIn review (no transactions). */
  kind?: "message";
  level: number | null;
  allow: boolean;
  /** Held for the user; allow is false until the user chooses Sign anyway. */
  hold: boolean;
  decided?: "user";
  reason: string;
}

// Every read-modify-write of the log runs in turn, so concurrent requests never drop entries.
let logQueue: Promise<void> = Promise.resolve();
function editLog(edit: (log: LogEntry[]) => LogEntry[] | null): Promise<void> {
  const run = async () => {
    try {
      const got = await chrome.storage.local.get(LOG_KEY);
      const next = edit(Array.isArray(got[LOG_KEY]) ? (got[LOG_KEY] as LogEntry[]) : []);
      if (next) await chrome.storage.local.set({ [LOG_KEY]: next.slice(0, LOG_MAX) });
    } catch {
      /* logging never affects the decision */
    }
  };
  logQueue = logQueue.then(run, run);
  return logQueue;
}

const appendLog = (entry: LogEntry) => editLog((log) => [entry, ...log]);

/** The user answered a held request: record it, so the log matches what reached the wallet. */
const recordDecision = (id: string, allow: boolean) =>
  editLog((log) => {
    const entry = log.find((e) => e.id === id && e.hold && e.decided === undefined);
    if (!entry) return null;
    entry.allow = allow;
    entry.decided = "user";
    return log;
  });

const explainStore = new ExplainStore();
const modelDeps = () => ({ get: (keys: string[]) => chrome.storage.local.get(keys), fetch: fetch.bind(globalThis), permissions: chrome.permissions });

const blocked = (reason: string): WorkerVerdict => ({ allow: false, hold: false, level: null, reason, report: null });

async function handleAnalyze(msg: Record<string, unknown>): Promise<WorkerVerdict> {
  const req = validateSignRequest(msg.request);
  if (!req || typeof msg.url !== "string") return blocked("malformed request");
  const loaded = await loadSettings((keys) => chrome.storage.local.get(keys));
  const deterministic = loaded.ok ? await decide(req, loaded.settings, realEngine) : blocked(loaded.reason);
  // The explanation runs beside the intent selection, so it adds no wait before the report opens.
  explainStore.start(req.id, deterministic, modelDeps());
  const enhanced = await enhanceIntent(deterministic, modelDeps());
  const verdict = withContext(enhanced, msg.url, loaded.ok ? networkFor(req.chain, loaded.settings.network) : null);
  await appendLog({
    ts: Date.now(),
    id: req.id,
    url: msg.url.slice(0, 512),
    method: req.method,
    wallet: req.wallet,
    chain: req.chain,
    txCount: req.txs.length,
    level: verdict.level,
    allow: verdict.allow,
    hold: verdict.hold,
    reason: verdict.reason
  });
  return verdict;
}

async function handleMessage(msg: Record<string, unknown>): Promise<WorkerVerdict> {
  const req = validateMessageRequest(msg.request);
  if (!req || typeof msg.url !== "string") return blocked("malformed request");
  const verdict = withContext(messageVerdict(reviewMessage(req, msg.url)), msg.url, null);
  await appendLog({
    ts: Date.now(), id: req.id, url: msg.url.slice(0, 512), method: req.method, wallet: req.wallet, chain: req.chain,
    txCount: 0, kind: "message", level: verdict.level, allow: verdict.allow, hold: verdict.hold, reason: verdict.reason
  });
  return verdict;
}

// First install with no key (or unreadable settings): open the options page so the user can fix it.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") return;
  chrome.storage.local
    .get([...SETTINGS_KEYS])
    .then(
      (raw) => !readSettings(raw).heliusApiKey,
      () => true
    )
    // Always a new tab: openOptionsPage() may navigate the user's current blank tab away.
    .then((open) => (open ? chrome.tabs.create({ url: chrome.runtime.getURL("options.html"), active: true }) : undefined))
    .catch(() => {});
});

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  const providerTest = handleProviderTest(msg, sender, { id: chrome.runtime.id, optionsUrl: chrome.runtime.getURL("options.html") }, {
    get: keys => chrome.storage.local.get(keys), permissions: chrome.permissions, fetch: fetch.bind(globalThis)
  });
  if (providerTest) {
    providerTest.then(sendResponse);
    return true;
  }
  // Transaction bridge: only our own content scripts, inside a tab.
  if (sender.id !== chrome.runtime.id || !sender.tab) return false;
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  if (m.type === SW_ANALYZE) {
    handleAnalyze(m)
      .catch(() => blocked("service worker error"))
      .then(sendResponse);
    return true; // async response
  }
  if (m.type === SW_MESSAGE) {
    handleMessage(m)
      .catch(() => blocked("service worker error"))
      .then(sendResponse);
    return true;
  }
  if (m.type === SW_BIND) {
    explainStore.bind(m.id as string, m.secret, sender.tab?.id);
    return false;
  }
  if (m.type === SW_EXPLAIN) {
    explainStore.answer(m, sender, { id: chrome.runtime.id, reportUrl: reportFrameUrl(chrome.runtime.getURL) }).catch(() => null).then(sendResponse);
    return true;
  }
  if (m.type === SW_DECIDED) {
    if (isId(m.id)) explainStore.release(m.id);
    if (isId(m.id) && typeof m.allow === "boolean") void recordDecision(m.id, m.allow);
    return false;
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
