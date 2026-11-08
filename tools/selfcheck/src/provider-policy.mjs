// Independent G10 oracle. Configuration is not a grant: callers supply permissions observed in Chrome.
export function providerOrigin(value) {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.search || u.hash) return null;
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) return null;
    return u.origin;
  } catch { return null; }
}

export function providerRequestAllowed(request, configured, grantedOrigins, redirected = false) {
  if (redirected) return false;
  const origin = providerOrigin(configured);
  if (!origin || !grantedOrigins.includes(`${origin}/*`)) return false;
  try {
    const u = new URL(request);
    return !u.username && !u.password && !u.search && !u.hash && u.origin === origin;
  } catch { return false; }
}
