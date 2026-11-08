// Internal Options -> worker command: no endpoint, authentication or transaction payload.
export const SW_TEST_PROVIDER = "kelvara-signguard/test-provider";
export type ProviderTestStatus = "ok" | "not-configured" | "unavailable" | "invalid";
export interface ProviderTestResponse { status: ProviderTestStatus }
export function isProviderTestRequest(value: unknown): boolean {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const x = value as Record<string, unknown>;
  return Object.keys(x).length === 1 && Object.hasOwn(x, "type") && x.type === SW_TEST_PROVIDER;
}
export function providerTestStatus(value: unknown): ProviderTestStatus | null {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const x = value as Record<string, unknown>;
  if (Object.keys(x).length !== 1 || !Object.hasOwn(x, "status") || !["ok", "not-configured", "unavailable", "invalid"].includes(x.status as string)) return null;
  return x.status as ProviderTestStatus;
}
