// Turn an analysis into pass / hold / block. Fail closed everywhere.
import { b58encode, b64decode, wireMessage } from "../shared/codec.js";
import type { SignRequest, WorkerVerdict } from "../shared/protocol.js";
import { validateReportView, type ReportView } from "../shared/report-view.js";
import { pickEndpoint, type Network } from "./endpoint.js";
import type { EngineLike } from "./engine-stub.js";
import { EngineFailure } from "./engine-failure.js";
import { limitReport } from "../license/limit.js";
import { verifyLicense } from "../license/verify.js";

export interface Settings {
  heliusApiKey?: string;
  network: Network;
  /** Dev aid from sol-sign-preview: skip the hold; the wallet's own prompt still shows. */
  passThrough: boolean;
  /** Raw license string as stored; verified offline on every request (expiry included). */
  licenseKey?: string;
}

/** True only for a license that verifies now. Never affects hold or block. */
export type LicenseCheck = (licenseKey: string | undefined) => Promise<boolean>;
export const offlineLicenseCheck: LicenseCheck = async (k) => (await verifyLicense(k).catch(() => null))?.ok === true;

export type Sha256 = (bytes: Uint8Array) => Promise<Uint8Array>;

export const webSha256: Sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));

/** Base58 SHA-256 of each transaction's message: what a Ledger shows as the message hash. */
export async function messageHashes(txs: readonly string[], sha256: Sha256 = webSha256): Promise<string[]> {
  const out: string[] = [];
  for (const tx of txs) out.push(b58encode(await sha256(wireMessage(b64decode(tx)))));
  return out;
}

const blocked = (reason: string, report: ReportView | null = null): WorkerVerdict => ({ allow: false, hold: false, level: null, reason, report });

export async function decide(
  req: SignRequest,
  settings: Settings,
  engine: EngineLike,
  sha256: Sha256 = webSha256,
  licensed: LicenseCheck = offlineLicenseCheck
): Promise<WorkerVerdict> {
  if (settings.passThrough) return { allow: true, hold: false, level: null, reason: "pass-through mode", report: null };
  let hashes: string[];
  try {
    hashes = await messageHashes(req.txs, sha256);
  } catch {
    return blocked("could not read the transaction message");
  }
  const failure = (reason: string): WorkerVerdict =>
    blocked(reason, {
      title: "Blocked: request could not be analyzed",
      summary: `${reason}. SignGuard blocks what it cannot check.`,
      simulation: null,
      authorizes: null,
      capabilities: [],
      preview: [],
      claims: [],
      messageHashes: hashes,
      limited: false
    });
  const endpoint = pickEndpoint(req.chain, settings.network, settings.heliusApiKey);
  if (!endpoint.ok) return failure(endpoint.reason);
  let level: 0 | 1 | 2 | 3 | 4;
  let report: ReportView | null;
  try {
    const { level: l, ...view } = await engine.analyze(req, endpoint, hashes);
    level = l;
    report = validateReportView({ ...view, messageHashes: hashes, limited: false });
  } catch (e) {
    // Only our own fixed-text failures are shown; anything else could carry an endpoint URL.
    return failure(e instanceof EngineFailure ? e.message : "engine error");
  }
  if (![0, 1, 2, 3, 4].includes(level)) return failure("engine error: no alert level");
  if (!report) return failure("engine error: report failed validation");
  // The license decides only how much of the report is shown, after the level is fixed.
  if (!(await licensed(settings.licenseKey).catch(() => false))) report = limitReport(report);
  const reason = report.title;
  if (level === 0 || level === 1) return { allow: true, hold: false, level, reason, report };
  if (level === 4) return { allow: false, hold: false, level, reason, report };
  return { allow: false, hold: true, level, reason, report };
}
