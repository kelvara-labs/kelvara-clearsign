# Kelvara wallet browser

`launch.sh` starts the isolated Kelvara Brave profile (`/home/andy/KELVARA/local-browser-session/profile`)
with Solflare plus our unpacked build (`packages/extension/dist`), CDP on `127.0.0.1:28538` only (`KELVARA_CDP_PORT` changes the port, never the loopback host).
`--wallet-only` loads Solflare alone. `cdp-check.mjs` verifies CDP answers, that the listener is
loopback-only, and lists targets with `api-key=` redacted.

The rules of `/home/andy/KELVARA/local-browser-session/SKILL.md` apply in full: drive pages and click
Block in our report over CDP; never click Sign anyway, never touch Solflare, never read the profile or
the session's `.env`. The human approves every wallet prompt. Do not run it while the Kelvara session
uses the same profile; launch.sh refuses if the profile lock is held or port 28538 belongs to something
other than a CDP endpoint.
