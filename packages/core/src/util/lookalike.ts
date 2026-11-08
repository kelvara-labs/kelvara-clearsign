export interface LookalikeMatch {
  prefix: number;
  suffix: number;
}

/**
 * Lookalike test (PLAN.md 3d): at least 5 shared characters across the start and the end, at least 2
 * on each side. Shared = longest common prefix and suffix (case-sensitive, base58). Null otherwise.
 */
export function lookalike(a: string, b: string): LookalikeMatch | null {
  if (a === b) return null;
  const n = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < n && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return prefix >= 2 && suffix >= 2 && prefix + suffix >= 5 ? { prefix, suffix } : null;
}
