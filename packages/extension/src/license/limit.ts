// Without a valid license the report keeps only the risk header (level and title)
// and the top finding (PLAN M5). Cut in the service worker, so the full text never
// reaches the page or the report frame. Message hashes stay: they are the user's
// own check against a hardware wallet, not analysis.
import { rankedCapabilities, type ReportView } from "../shared/report-view.js";

export const LIMITED_SUMMARY =
  "The full report (simulation, every capability change, what each authority can do, evidence) needs a SignGuard license. Add one in the extension options.";

export function limitReport(r: ReportView): ReportView {
  const topCap = rankedCapabilities(r)[0];
  // Top finding: the most dangerous capability change; with none, the first claim without its evidence.
  const topClaim = !topCap && r.claims[0] ? [{ ...r.claims[0], evidenceIds: [], moreEvidence: 0 }] : [];
  return {
    title: r.title,
    summary: LIMITED_SUMMARY,
    simulation: null,
    authorizes: null,
    capabilities: topCap ? [topCap] : [],
    preview: [],
    claims: topClaim,
    evidence: [],
    messageHashes: r.messageHashes,
    limited: true
  };
}
