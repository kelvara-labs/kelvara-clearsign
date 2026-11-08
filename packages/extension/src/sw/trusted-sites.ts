// Reviewed list of trusted sites (PLAN.md "trusted sites and aggregators"). Exact HTTPS origins only: no wildcards,
// no subdomains unless listed, never http. An aggregator routes trades through third-party programs by design,
// so an unreadable program on such a site is not a risk by itself. Trust never changes level, controls or any risk claim.
export interface TrustedSite {
  readonly origin: string;
  readonly name: string;
  /** Only "aggregator" relaxes unreadable routed programs; other roles get the trusted-site pill only. */
  readonly role: "aggregator" | "perp-dex";
  readonly reason: string;
}

const site = (origin: string, name: string, role: TrustedSite["role"], reason: string): TrustedSite => Object.freeze({ origin: new URL(origin).origin, name, role, reason });

export const TRUSTED_SITES: readonly TrustedSite[] = Object.freeze([
  site("https://jup.ag/", "Jupiter", "aggregator", "Swap aggregator: routes each trade through third-party liquidity programs by design."),
  site("https://app.velocity.exchange/", "Velocity", "perp-dex", "Perpetuals exchange; its own program is decoded from its IDL, so unreadable third-party programs are still flagged.")
]);

function httpsOrigin(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * The trusted site for a request, or null. `frameUrl` and `topUrl` must come from the browser's sender data
 * (sender.url, sender.tab.url), never from page-supplied text; both must be the same listed origin, so an
 * iframe of another origin inside a trusted page (or a trusted frame inside another page) is not trusted.
 */
export function trustedSiteFor(frameUrl: unknown, topUrl: unknown): TrustedSite | null {
  const frame = httpsOrigin(frameUrl);
  if (!frame || frame !== httpsOrigin(topUrl)) return null;
  return TRUSTED_SITES.find((s) => s.origin === frame) ?? null;
}
