// Reviewed list of trusted sites (PLAN.md "trusted sites and aggregators"). Exact HTTPS origins only: no wildcards,
// no subdomains unless listed, never http. An aggregator routes trades through third-party programs by design,
// so an unreadable program on such a site is not a risk by itself. Trust never changes level, controls or any risk claim.
export interface TrustedSite {
  readonly origin: string;
  readonly name: string;
  /** Only "aggregator" relaxes unreadable routed programs; other roles get the trusted-site pill only. */
  readonly role: "aggregator" | "perp-dex" | "lending";
  readonly reason: string;
}

const site = (origin: string, name: string, role: TrustedSite["role"], reason: string): TrustedSite => Object.freeze({ origin: new URL(origin).origin, name, role, reason });

export const TRUSTED_SITES: readonly TrustedSite[] = Object.freeze([
  site("https://jup.ag/", "Jupiter", "aggregator", "Swap aggregator: routes each trade through third-party liquidity programs by design."),
  site("https://kamino.com/", "Kamino", "lending", "Lending protocol; its own program is read from its IDL, so unreadable third-party programs are still flagged."),
  site("https://app.velocity.exchange/", "Velocity", "perp-dex", "Perpetuals exchange; its own program is read from its IDL, so unreadable third-party programs are still flagged.")
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

/** Brand words of the trusted sites. A page whose host carries one of them but is not a trusted origin is an impostor. */
export const BRAND_TOKENS: readonly string[] = Object.freeze(["jup", "jupiter", "kamino", "velocity"]);

/** Registrable domains of the trusted sites, compared by edit distance. */
const TRUSTED_DOMAINS: readonly string[] = Object.freeze(["jup.ag", "kamino.com", "velocity.exchange"]);

const BASE36 = "abcdefghijklmnopqrstuvwxyz0123456789";
/** RFC 3492 decode of one punycode label (without the "xn--" prefix); null when malformed. */
function punyDecode(input: string): string | null {
  const out: number[] = [];
  const basic = input.lastIndexOf("-");
  for (let j = 0; j < Math.max(basic, 0); j++) out.push(input.charCodeAt(j));
  let n = 128, bias = 72, i = 0;
  for (let idx = basic > 0 ? basic + 1 : 0; idx < input.length; ) {
    const oldi = i;
    for (let w = 1, k = 36; ; k += 36) {
      if (idx >= input.length) return null;
      const digit = BASE36.indexOf(input[idx++]!.toLowerCase());
      if (digit < 0) return null;
      i += digit * w;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < t) break;
      w *= 36 - t;
    }
    const len = out.length + 1;
    let delta = oldi === 0 ? Math.floor((i - oldi) / 700) : Math.floor((i - oldi) / 2);
    delta += Math.floor(delta / len);
    let k = 0;
    while (delta > 455) { delta = Math.floor(delta / 35); k += 36; }
    bias = k + Math.floor((36 * delta) / (delta + 38));
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff) return null;
    out.splice(i++, 0, n);
  }
  try { return String.fromCodePoint(...out); } catch { return null; }
}

/** Look-alike letters of other scripts folded to the Latin letter they imitate. */
const HOMOGLYPHS: Record<string, string> = { а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", һ: "h", ӏ: "l", ο: "o", α: "a", ν: "v", ι: "i", ρ: "p", κ: "k", ս: "u", ɡ: "g", ǀ: "l", ꞵ: "b" };

/** Lower-cased host, punycode decoded, accents and look-alike letters folded. */
export function foldHost(hostname: string): string {
  const labels = hostname.toLowerCase().split(".").map((l) => (l.startsWith("xn--") ? punyDecode(l.slice(4)) ?? l : l));
  return labels.join(".").normalize("NFKD").replace(/\p{M}/gu, "").replace(/./gu, (c) => HOMOGLYPHS[c] ?? c);
}

/** Spelling variants of a host with digits and letter pairs read as the letters they imitate (0 o, 1 l or i, rn m, vv w). */
function variants(host: string): string[] {
  const base = host.replace(/0/g, "o").replace(/rn/g, "m").replace(/vv/g, "w");
  return [...new Set([base.replace(/1/g, "l"), base.replace(/1/g, "i")])];
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);
function registrable(host: string): string {
  const parts = host.split(".");
  const n = parts.length >= 3 && SECOND_LEVEL.has(parts.at(-2)!) && parts.at(-1)!.length === 2 ? 3 : 2;
  return parts.slice(-n).join(".");
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

const isLocalHost = (h: string): boolean => h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]";

/**
 * The trusted site this page imitates, or null. Input is a page URL from the browser's sender data. Not an impostor:
 * the exact trusted https origins, https subdomains of a trusted registrable domain (the brand's own DNS), localhost
 * and non-web schemes. Impostor: a trusted host over http, or a host that carries a brand word as a label part, sits
 * within edit distance 2 of a trusted domain, or contains a trusted hostname as a sub-part, after folding
 * punycode, accents, look-alike letters and digit swaps.
 */
export function impostorOf(url: unknown): TrustedSite | null {
  if (typeof url !== "string") return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (isLocalHost(u.hostname)) return null;
  const raw = u.hostname;
  const host = foldHost(raw);
  const exact = TRUSTED_SITES.find((s) => new URL(s.origin).hostname === raw);
  const https = u.protocol === "https:";
  if (exact) return https ? null : exact;
  const owns = TRUSTED_DOMAINS.find((d) => raw === d || raw.endsWith(`.${d}`));
  if (owns) return https ? null : (TRUSTED_SITES.find((s) => new URL(s.origin).hostname.endsWith(owns)) ?? null);
  const siteFor = (needle: string): TrustedSite | null => TRUSTED_SITES.find((s) => new URL(s.origin).hostname.includes(needle) || needle.includes(new URL(s.origin).hostname.split(".").slice(-2)[0]!)) ?? null;
  for (const v of variants(host)) {
    for (const t of TRUSTED_SITES) {
      const th = new URL(t.origin).hostname;
      if (v.includes(th)) return t;
    }
    const parts = v.split(/[.-]/);
    for (const token of BRAND_TOKENS) if (parts.some((p) => p.includes(token))) return siteFor(token) ?? TRUSTED_SITES[0]!;
    const reg = registrable(v);
    for (const d of TRUSTED_DOMAINS) if (reg !== d && editDistance(reg, d) <= 2) return TRUSTED_SITES.find((t) => new URL(t.origin).hostname.endsWith(d)) ?? null;
  }
  return null;
}
