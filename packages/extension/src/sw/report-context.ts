// Adds the "site · network" context to a report: the requesting page's origin (never path or query)
// and the network the request is analyzed on. Display only; never changes level or decision.
import type { WorkerVerdict } from "../shared/protocol.js";
import { REPORT_NETWORKS, isOrigin, type ReportNetwork } from "../shared/report-view.js";

export function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return isOrigin(o) ? o : null;
  } catch {
    return null;
  }
}

export function withContext(verdict: WorkerVerdict, url: string, network: ReportNetwork | null): WorkerVerdict {
  if (!verdict.report) return verdict;
  const origin = originOf(url);
  const report = { ...verdict.report, ...(origin ? { origin } : {}), ...(network && REPORT_NETWORKS.includes(network) ? { network } : {}) };
  return { ...verdict, report };
}
