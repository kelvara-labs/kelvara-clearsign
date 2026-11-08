import type { TokenRef } from "../shared/report-view.js";

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Text with each known token label wrapped in a span whose title and accessible name carry the full mint
 * (hover shows the address). Labels come from the worker's own token list; text only, never markup.
 */
export function withTokens(text: string, tokens: readonly TokenRef[] | undefined, doc: Document = document): (Node | string)[] {
  if (!tokens?.length) return [text];
  const byLabel = new Map(tokens.map((t) => [t.label, t.mint]));
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\w…])(${labels.map(esc).join("|")})(?![\\w…])`, "g");
  const out: (Node | string)[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const span = doc.createElement("span");
    span.className = "token";
    span.textContent = m[1]!;
    span.setAttribute("title", byLabel.get(m[1]!)!);
    span.setAttribute("aria-label", `${m[1]}, mint ${byLabel.get(m[1]!)}`);
    span.setAttribute("tabindex", "0");
    span.setAttribute("data-kelvara-token", byLabel.get(m[1]!)!);
    out.push(span);
    last = m.index + m[1]!.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
