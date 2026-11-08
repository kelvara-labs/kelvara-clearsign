// Provider settings never cross into a report or page-world message.
export const DEFAULT_AI_URL = "https://api.openai.com/v1/chat/completions";
export const DEFAULT_AI_MODEL = "gpt-4.1-mini";
export const AI_STORAGE_KEY = "aiProvider";
export interface Provider { url: string; model: string; key: string; enabled: boolean }
export interface Permissions {
  request(details: { origins: string[] }): Promise<boolean>;
  contains(details: { origins: string[] }): Promise<boolean>;
}
const hasControl = (s: string, space = false) => [...s].some(c => c.charCodeAt(0) <= (space ? 32 : 31) || c.charCodeAt(0) === 127);
export function providerUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048 || hasControl(raw)) return null;
  try {
    const u = new URL(raw.trim());
    if (u.username || u.password || u.search || u.hash || /[?#]/.test(raw)) return null;
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
    if (u.hostname.includes("*") || !u.hostname) return null;
    let path = u.pathname.replace(/\/+$/, "");
    if (!/\/(chat\/completions|responses)$/.test(path)) path = `${path || "/v1"}/chat/completions`;
    u.pathname = path;
    return u.href;
  } catch { return null; }
}
/** Request the configured origin only, including its explicit inference port. */
export function providerOrigin(url: string): string {
  const u = new URL(url);
  return `${u.origin}/*`;
}
export function readProvider(value: unknown): Provider | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const x = value as Record<string, unknown>;
  if (Object.keys(x).length !== 4 || !["url", "model", "key", "enabled"].every(k => Object.hasOwn(x, k))) return null;
  const url = providerUrl(x.url);
  if (!url || typeof x.model !== "string" || !x.model.trim() || x.model.length > 160 || hasControl(x.model)) return null;
  if (typeof x.key !== "string" || x.key.length > 4096 || hasControl(x.key, true) || typeof x.enabled !== "boolean") return null;
  return { url, model: x.model.trim(), key: x.key, enabled: x.enabled };
}
