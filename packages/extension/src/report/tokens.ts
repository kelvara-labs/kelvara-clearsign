import type { TokenRef } from "../shared/report-view.js";

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "23.180052" -> "23.18", "1250000.5" -> "1,250,000.5", "0.25889912" -> "0.2589"; exact decimal strings in, no floats. */
export function roundForReading(exact: string): { text: string; changed: boolean } {
  const clean = exact.replace(/,/g, "");
  const [int = "0", frac = ""] = clean.split(".");
  const big = BigInt(int || "0") > 0n;
  const keep = big ? Math.max(2, 4 - int.replace(/^0+/, "").length) : Math.max(4, (/^0*/.exec(frac)?.[0].length ?? 0) + 4);
  let digits = BigInt(`${int}${frac}` || "0");
  let decimals = frac.length;
  if (decimals > keep) {
    const drop = BigInt(10) ** BigInt(decimals - keep);
    const q = digits / drop;
    digits = (digits % drop) * 2n >= drop ? q + 1n : q;
    decimals = keep;
  }
  const s = digits.toString().padStart(decimals + 1, "0");
  const wholePart = s.slice(0, s.length - decimals);
  const fracPart = s.slice(s.length - decimals).replace(/0+$/, "");
  const shownWhole = BigInt(wholePart).toLocaleString("en-US");
  if (BigInt(`${int}${frac}` || "0") === 0n) return { text: "0", changed: false };
  if (BigInt(wholePart) === 0n && !fracPart) return { text: "< 0.0001", changed: true };
  const text = `${shownWhole}${fracPart ? `.${fracPart}` : ""}`;
  const normalize = (x: string) => { const [a = "0", b = ""] = x.split("."); return `${BigInt(a)}.${b.replace(/0+$/, "")}`; };
  return { text, changed: normalize(clean) !== normalize(text.replace(/,/g, "")) };
}

/**
 * Text for reading: each known token label becomes a span whose title and accessible name carry the full mint
 * (hover shows the address), and a token or SOL amount is rounded ("23.18 USDC", "≈" only when the value changed)
 * with the exact amount in the title. Labels come from the worker's own token list; text only, never markup.
 * Technical details (instruction arguments, evidence, Copy raw) are not passed through here and stay exact.
 */
export function withTokens(text: string, tokens: readonly TokenRef[] | undefined, doc: Document = document, round = true): (Node | string)[] {
  const byLabel = new Map<string, string | null>([["SOL", null], ...(tokens ?? []).map((t) => [t.label, t.mint] as [string, string | null])]);
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length).map(esc).join("|");
  const re = new RegExp(`(?<![\\w.,])([−+-]?)(\\d[\\d,]*(?:\\.\\d+)?) (${labels})(?![\\w…])|(?<![\\w…])(${labels})(?![\\w…])`, "g");
  const out: (Node | string)[] = [];
  let last = 0;
  const token = (label: string): HTMLElement => {
    const span = doc.createElement("span");
    const mint = byLabel.get(label);
    span.textContent = label;
    if (mint) {
      span.className = "token";
      span.setAttribute("title", mint);
      span.setAttribute("aria-label", `${label}, mint ${mint}`);
      span.setAttribute("tabindex", "0");
      span.setAttribute("data-kelvara-token", mint);
    }
    return span;
  };
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== undefined) {
      const { text: rounded, changed } = roundForReading(m[2]);
      if (!round || !changed) out.push(`${m[1]}${m[2]}`, " ", token(m[3]!));
      else {
        const amount = doc.createElement("span");
        amount.className = "amount";
        amount.setAttribute("title", `${m[1]}${m[2]} ${m[3]}`);
        amount.append(`${rounded.startsWith("<") ? "" : "≈ "}${m[1]}${rounded} `, token(m[3]!));
        out.push(amount);
      }
    } else out.push(token(m[4]!));
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
