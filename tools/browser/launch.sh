#!/usr/bin/env bash
# Kelvara wallet browser + Kelvara SignGuard unpacked build.
#
# Starts the isolated Kelvara Brave profile (Solflare burner wallet) with our
# extension (packages/extension/dist) loaded next to Solflare, with Chrome
# DevTools Protocol on 127.0.0.1:28538 only.
#
# Rules (from /home/andy/KELVARA/local-browser-session/SKILL.md, apply in full):
#   - agents drive pages and click Block in our report over CDP; never Sign anyway,
#     never anything inside Solflare, never read the profile or the session's .env;
#   - every wallet prompt is approved by the human, by hand;
#   - do not run this while the Kelvara session uses the same profile.
#
# Usage:
#   tools/browser/launch.sh [--wallet-only] [URL]
#     --wallet-only   load Solflare only (before packages/extension/dist exists)
#   Then: node tools/browser/cdp-check.mjs
#
# Env overrides: KELVARA_BROWSER_SESSION, SOLFLARE_DIR, SIGNGUARD_DIST, BRAVE_BIN.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "$HERE/../.." && pwd)"
SESSION="${KELVARA_BROWSER_SESSION:-/home/andy/KELVARA/local-browser-session}"
PROFILE="$SESSION/profile"
# Solflare as installed in the user's Brave; Brave auto-updates it, so take the newest version dir.
SOLFLARE_ROOT=/home/andy/.config/BraveSoftware/Brave-Browser/Default/Extensions/bhhhlbepdkbapadjdnnojkbgioiodbic
SOLFLARE="${SOLFLARE_DIR:-$(ls -d "$SOLFLARE_ROOT"/*/ 2>/dev/null | sort -V | tail -1 | sed 's:/$::')}"
SIGNGUARD="${SIGNGUARD_DIST:-$REPO/packages/extension/dist}"
BRAVE="${BRAVE_BIN:-/usr/bin/brave-browser}"
CDP_HOST=127.0.0.1
CDP_PORT=28538

WALLET_ONLY=0
if [[ "${1:-}" == "--wallet-only" ]]; then WALLET_ONLY=1; shift; fi
URL="${1:-about:blank}"

die() { printf 'launch.sh: %s\n' "$*" >&2; exit 1; }

[[ -x "$BRAVE" ]] || die "Brave not found at $BRAVE"
[[ -d "$SESSION" ]] || die "Kelvara browser session missing: $SESSION"
[[ -n "$SOLFLARE" && -f "$SOLFLARE/manifest.json" ]] || die "Solflare extension missing under $SOLFLARE_ROOT"

EXTS="$SOLFLARE"
if [[ $WALLET_ONLY -eq 0 ]]; then
  [[ -f "$SIGNGUARD/manifest.json" ]] \
    || die "no unpacked build at $SIGNGUARD (run the extension build, or pass --wallet-only)"
  EXTS="$SOLFLARE,$SIGNGUARD"
fi

# Port 28538 must be free or already be this browser's CDP endpoint.
version="$(curl -s -m 2 "http://$CDP_HOST:$CDP_PORT/json/version" || true)"
if [[ -n "$version" ]]; then
  if grep -q '"webSocketDebuggerUrl"' <<<"$version"; then
    printf 'launch.sh: a browser already answers CDP on %s:%s; reusing it.\n' "$CDP_HOST" "$CDP_PORT"
    printf 'launch.sh: it keeps the extensions it was started with; restart it to load a new build.\n'
    exit 0
  fi
  die "port $CDP_PORT is held by a service that is not a CDP endpoint; free it first (see 'ss -ltnp' / 'docker ps')"
fi
if ss -ltnH "sport = :$CDP_PORT" 2>/dev/null | grep -q .; then
  die "port $CDP_PORT is in use by a non-HTTP listener; free it first"
fi

# Same profile already open (e.g. the Kelvara session without CDP)?
if [[ -L "$PROFILE/SingletonLock" ]]; then
  pid="$(readlink "$PROFILE/SingletonLock" | sed 's/.*-//')"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    die "the Kelvara profile is in use by pid $pid; close that browser first"
  fi
fi

mkdir -p "$PROFILE"
chmod 700 "$SESSION" "$PROFILE"

exec "$BRAVE" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-address="$CDP_HOST" \
  --remote-debugging-port="$CDP_PORT" \
  --disable-extensions-except="$EXTS" \
  --load-extension="$EXTS" \
  --no-first-run \
  --no-default-browser-check \
  --new-window "$URL"
