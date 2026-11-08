// Deterministic review of a held message-signing call (signMessage / signIn). No network, no AI.
// Every rule is named and has fixed template text. Runs in the service worker only: it uses
// @kelvara/core's transaction parser, which must never be imported by hook/bridge/report code.
import { parseTransaction } from "@kelvara/core";
import { b64decode } from "../shared/codec.js";
import { MESSAGE_CAPS, type MessageField, type MessageFinding, type MessageKind, type MessageReview } from "../shared/message-view.js";
import { SIGNIN_STRING_FIELDS, type MessageRequest, type SignInInput } from "../shared/protocol.js";
import type { ReportView } from "../shared/report-view.js";
import type { WorkerVerdict } from "../shared/protocol.js";

type Level = 1 | 2 | 3 | 4;

/** Fixed rule table: id -> level and template text. The only place review wording lives. */
export const MESSAGE_RULES = {
  "message.hidden-tx": { level: 4, title: "Hidden transaction in a message signature", text: "These bytes are a Solana transaction or transaction message. Signing them as a message could authorize a transaction without showing it to you." },
  "message.binary": { level: 3, title: "Unreadable binary message", text: "These bytes are not readable text. SignGuard cannot show what you would be signing." },
  "siws.domain-mismatch": { level: 3, title: "Sign-in request for a different site", text: "The sign-in names a domain that is not the site asking for it." },
  "siws.uri-mismatch": { level: 3, title: "Sign-in request with a different site address", text: "The sign-in URI points to a different host than the site asking for it." },
  "siws.malformed": { level: 2, title: "Sign-in request that cannot be read", text: "This looks like a sign-in message but it is not well formed, so SignGuard cannot check it." },
  "siws.address-mismatch": { level: 2, title: "Sign-in for a different account", text: "The sign-in names an account other than the one your wallet exposes for this request." },
  "siws.expired": { level: 2, title: "Expired sign-in request", text: "The sign-in expiration time has already passed." },
  "siws.not-yet-valid": { level: 2, title: "Sign-in request not valid yet", text: "The sign-in is not valid until a time that has not arrived." },
  "siws.chain-mismatch": { level: 2, title: "Sign-in request for a different network", text: "The sign-in names a different network than your wallet is using for this request." },
  "siws.ok": { level: 1, title: "Sign-in request", text: "A well-formed sign-in for the site asking, for the account your wallet exposes. Check the fields below." },
  "message.text": { level: 1, title: "Message signature", text: "Plain readable text. Signing it proves you control the account; it moves no funds." }
} as const satisfies Record<string, { level: Level; title: string; text: string }>;
export type MessageRule = keyof typeof MESSAGE_RULES;

export interface ReviewDeps {
  now(): number;
  /** True when the bytes parse as a Solana transaction or message. */
  isTransaction(bytes: Uint8Array): boolean;
}

export const defaultDeps: ReviewDeps = {
  now: () => Date.now(),
  isTransaction(bytes) {
    try {
      parseTransaction(bytes);
      return true;
    } catch {
      return false;
    }
  }
};

const FIELD_ORDER: readonly string[] = [...SIGNIN_STRING_FIELDS, "resources"];
const LABELS: Record<string, string> = { URI: "uri", Version: "version", "Chain ID": "chainId", Nonce: "nonce", "Issued At": "issuedAt", "Expiration Time": "expirationTime", "Not Before": "notBefore", "Request ID": "requestId" };
const HEADER = /^(?:([A-Za-z][A-Za-z0-9+.-]*):\/\/)?(\S+) wants you to sign in with your Solana account:$/;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Parse the standard Sign-In With Solana text; null when it is not that format. */
export function parseSiws(text: string): SignInInput | null {
  const lines = text.split("\n");
  const head = HEADER.exec(lines[0] ?? "");
  if (!head) return null;
  const out: SignInInput = { domain: head[2]! };
  const address = lines[1] ?? "";
  if (!ADDRESS.test(address)) return null;
  out.address = address;
  let i = 2;
  while (i < lines.length && lines[i] === "") i++;
  const statement: string[] = [];
  while (i < lines.length && !lines[i]!.startsWith("URI: ") && !/^(Version|Chain ID|Nonce|Issued At): /.test(lines[i]!)) statement.push(lines[i++]!);
  const joined = statement.join("\n").replace(/\n+$/, "");
  if (joined) out.statement = joined;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "Resources:") {
      const resources: string[] = [];
      for (i++; i < lines.length && lines[i]!.startsWith("- "); i++) resources.push(lines[i]!.slice(2));
      if (i < lines.length) return null;
      out.resources = resources;
      break;
    }
    const m = /^([A-Za-z ]+): (.*)$/.exec(line);
    const key = m ? LABELS[m[1]!] : undefined;
    if (!m || !key || key in out) return null;
    (out as Record<string, string>)[key] = m[2]!;
  }
  return out.uri && out.version && out.nonce && out.issuedAt ? out : null;
}

/** The standard text for a signIn input, as the wallet would build it (page host as default domain). */
export function formatSiws(input: SignInInput, host: string): string {
  const lines = [`${input.domain ?? host} wants you to sign in with your Solana account:`, input.address ?? "(the account your wallet selects)", ""];
  if (input.statement) lines.push(input.statement);
  lines.push("");
  const rest: [string, string | undefined][] = [["URI", input.uri], ["Version", input.version], ["Chain ID", input.chainId], ["Nonce", input.nonce], ["Issued At", input.issuedAt], ["Expiration Time", input.expirationTime], ["Not Before", input.notBefore], ["Request ID", input.requestId]];
  for (const [k, v] of rest) if (v !== undefined) lines.push(`${k}: ${v}`);
  if (input.resources?.length) lines.push("Resources:", ...input.resources.map((r) => `- ${r}`));
  return lines.join("\n");
}

function pageHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}
const sameHost = (claimed: string, host: string) => {
  const c = claimed.toLowerCase();
  const hostname = host.replace(/:\d+$/, "");
  return c === host || (!/:\d+$/.test(c) && c === hostname);
};
const time = (s: string): number => (/^\d{4}-\d{2}-\d{2}T/.test(s) ? Date.parse(s) : NaN);
const chainName = (c: string) => c.replace(/^solana:/, "");
const bounded = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

function signInFindings(input: SignInInput, req: MessageRequest, host: string, now: number): MessageRule[] {
  const rules: MessageRule[] = [];
  if (input.domain !== undefined && !sameHost(input.domain, host)) rules.push("siws.domain-mismatch");
  if (input.uri !== undefined) {
    let uriHost: string | null = null;
    try {
      uriHost = new URL(input.uri).host.toLowerCase();
    } catch {
      /* unreadable URI */
    }
    if (uriHost === null) rules.push("siws.malformed");
    else if (!sameHost(uriHost, host)) rules.push("siws.uri-mismatch");
  }
  if (input.address !== undefined && req.account !== null && input.address !== req.account) rules.push("siws.address-mismatch");
  for (const [field, rule] of [["expirationTime", "siws.expired"], ["notBefore", "siws.not-yet-valid"]] as const) {
    const v = input[field];
    if (v === undefined) continue;
    const t = time(v);
    if (Number.isNaN(t)) rules.push("siws.malformed");
    else if (field === "expirationTime" ? t <= now : t > now) rules.push(rule);
  }
  if (input.issuedAt !== undefined && Number.isNaN(time(input.issuedAt))) rules.push("siws.malformed");
  if (input.chainId !== undefined && req.chain !== null && chainName(input.chainId) !== chainName(req.chain)) rules.push("siws.chain-mismatch");
  return rules;
}

function fieldsOf(input: SignInInput): MessageField[] {
  const out: MessageField[] = [];
  for (const name of FIELD_ORDER) {
    const v = (input as Record<string, unknown>)[name];
    if (typeof v === "string") out.push({ name, value: bounded(v, MESSAGE_CAPS.field) });
    else if (Array.isArray(v)) out.push({ name, value: bounded(v.join("\n"), MESSAGE_CAPS.field) });
  }
  return out;
}

export function reviewMessage(req: MessageRequest, url: string, deps: ReviewDeps = defaultDeps): MessageReview {
  const host = pageHost(url);
  const make = (kind: MessageKind, rules: MessageRule[], size: number, text: string | null, fields: MessageField[]): MessageReview => {
    const unique = [...new Set(rules)];
    const top = unique.reduce((a, b) => (MESSAGE_RULES[b].level > MESSAGE_RULES[a].level ? b : a));
    const shown = text === null ? null : bounded(text, MESSAGE_CAPS.text);
    return {
      kind,
      rule: top,
      origin: bounded(host || "unknown page", MESSAGE_CAPS.origin),
      size,
      text: shown,
      truncated: text !== null && shown !== text,
      fields,
      findings: unique.sort((a, b) => MESSAGE_RULES[b].level - MESSAGE_RULES[a].level).map((rule): MessageFinding => ({ rule, level: MESSAGE_RULES[rule].level, text: MESSAGE_RULES[rule].text }))
    };
  };
  const finish = (kind: MessageKind, rules: MessageRule[], size: number, text: string | null, fields: MessageField[], input: SignInInput | null): MessageReview => {
    const ordered = rules.length ? rules : [input ? "siws.ok" : "message.text"];
    return make(kind, ordered as MessageRule[], size, text, fields);
  };
  const now = deps.now();
  if (req.signIn !== null) {
    const input = req.signIn;
    return finish("siws", signInFindings(input, req, host, now), 0, formatSiws(input, host), fieldsOf(input), input);
  }
  let bytes: Uint8Array;
  try {
    bytes = b64decode(req.message ?? "");
  } catch {
    return make("binary", ["message.binary"], 0, null, []);
  }
  if (deps.isTransaction(bytes)) return make("hidden-tx", ["message.hidden-tx"], bytes.length, null, []);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return make("binary", ["message.binary"], bytes.length, null, []);
  }
  // Control characters other than newline/tab make the text unreadable as a message.
  if ([...text].some((c) => { const n = c.charCodeAt(0); return n === 127 || (n < 32 && n !== 10 && n !== 9 && n !== 13); })) return make("binary", ["message.binary"], bytes.length, null, []);
  const siws = parseSiws(text);
  if (siws) return finish("siws", signInFindings(siws, req, host, now), bytes.length, text, fieldsOf(siws), siws);
  if (/wants you to sign in with your Solana account/.test(text)) return make("siws", ["siws.malformed"], bytes.length, text, []);
  return finish("text", [], bytes.length, text, [], null);
}

/** The worker's verdict for a message review: L4 never holds, L1..L3 hold with the usual controls. */
export function messageVerdict(review: MessageReview): WorkerVerdict {
  const level = Math.max(...review.findings.map((f) => f.level)) as Level;
  const top = MESSAGE_RULES[review.rule as MessageRule];
  const report: ReportView = {
    title: top.title,
    summary: top.text,
    simulation: null,
    authorizes: null,
    capabilities: [],
    preview: [],
    claims: [],
    evidence: [],
    messageHashes: [],
    limited: false,
    message: review
  };
  return { allow: false, hold: level < 4, level, reason: top.title, report };
}
