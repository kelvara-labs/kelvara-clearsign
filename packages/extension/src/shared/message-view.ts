// What the report UI shows for a held message-signing call. Built by the service worker
// (sw/message-review.ts), validated again in the frame, rendered as text only.
export const MESSAGE_KINDS = ["siws", "text", "binary", "hidden-tx"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface MessageFinding {
  rule: string;
  level: 1 | 2 | 3 | 4;
  text: string;
}
export interface MessageField {
  name: string;
  value: string;
}
export interface MessageReview {
  kind: MessageKind;
  /** The named rule that set the alert level. */
  rule: string;
  /** Host of the page that asked. */
  origin: string;
  /** Number of bytes the wallet would sign (signIn: 0, the wallet builds them). */
  size: number;
  /** The message text (bounded, text only), or null for binary or hidden-transaction bytes. */
  text: string | null;
  truncated: boolean;
  fields: MessageField[];
  findings: MessageFinding[];
}

export const MESSAGE_CAPS = { text: 4096, field: 2048, name: 64, fields: 32, findings: 8, finding: 400, origin: 300 } as const;

const plain = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const exact = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const str = (x: unknown, max: number): x is string => typeof x === "string" && x.length <= max;

export function validateMessageReview(x: unknown): MessageReview | null {
  if (!plain(x) || !exact(x, ["kind", "rule", "origin", "size", "text", "truncated", "fields", "findings"])) return null;
  if (typeof x.kind !== "string" || !(MESSAGE_KINDS as readonly string[]).includes(x.kind)) return null;
  if (!str(x.rule, MESSAGE_CAPS.name) || !x.rule || !str(x.origin, MESSAGE_CAPS.origin)) return null;
  if (!Number.isInteger(x.size) || (x.size as number) < 0 || typeof x.truncated !== "boolean") return null;
  if (!(x.text === null || str(x.text, MESSAGE_CAPS.text))) return null;
  if (!Array.isArray(x.fields) || x.fields.length > MESSAGE_CAPS.fields) return null;
  if (!x.fields.every((f) => plain(f) && exact(f, ["name", "value"]) && str(f.name, MESSAGE_CAPS.name) && str(f.value, MESSAGE_CAPS.field))) return null;
  if (!Array.isArray(x.findings) || x.findings.length < 1 || x.findings.length > MESSAGE_CAPS.findings) return null;
  if (!x.findings.every((f) => plain(f) && exact(f, ["rule", "level", "text"]) && str(f.rule, MESSAGE_CAPS.name) && [1, 2, 3, 4].includes(f.level as number) && str(f.text, MESSAGE_CAPS.finding))) return null;
  return x as unknown as MessageReview;
}
