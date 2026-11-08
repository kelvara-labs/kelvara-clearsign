// Impostor sites (PLAN.md "impostor sites"): a page that imitates a trusted site is blocked at L4, for transactions and
// message signatures alike. Only ever raises: the verdict becomes L4, never allowed, never held (no Sign anyway). The
// engine or message report stays attached as evidence; header and summary name the imitated site.
import type { WorkerVerdict } from "../shared/protocol.js";
import type { ReportView } from "../shared/report-view.js";
import { impostorOf, type TrustedSite } from "./trusted-sites.js";

export const IMPOSTOR_REASON = "Impostor site";

/** The imitated trusted site for a request, from the browser's sender data only (frame and top-level URL). */
export function impostorFor(frameUrl: unknown, topUrl: unknown): TrustedSite | null {
  return impostorOf(frameUrl) ?? impostorOf(topUrl);
}

const EMPTY: ReportView = { title: "", summary: "", simulation: null, authorizes: null, capabilities: [], preview: [], claims: [], evidence: [], messageHashes: [], limited: false };

export function impostorVerdict(base: WorkerVerdict, site: TrustedSite): WorkerVerdict {
  const report: ReportView = {
    ...(base.report ?? EMPTY),
    title: `Impostor site · this is not ${site.origin}`,
    summary: `This page imitates ${site.name} (${site.origin}). ClearSign blocks it.`,
    impostor: { name: site.name, origin: site.origin }
  };
  delete report.routedBy;
  delete report.trustedSite;
  return { allow: false, hold: false, level: 4, reason: IMPOSTOR_REASON, report };
}
