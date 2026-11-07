// Helius mainnet JSON-RPC client for scenario tools. Helius only; the key comes from the main checkout's .env
// (or HELIUS_API_KEY) and is never logged: every error message is passed through redact().
/* global fetch, AbortSignal, setTimeout */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const redact = (s) => String(s).replace(/api-key=[^&\s"]*/gi, 'api-key=REDACTED');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadHeliusKey(repoRoot) {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY;
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim();
  const envPath = resolve(common, '..', '.env');
  if (!existsSync(envPath)) throw new Error('no .env in the main checkout; set HELIUS_API_KEY there');
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*HELIUS_API_KEY\s*=\s*"?([^"\s#]+)"?/.exec(line);
    if (m) return m[1];
  }
  throw new Error('HELIUS_API_KEY missing from .env');
}

// Paced (~6 rps) with backoff on 429/5xx: the key is shared with other tools.
export function heliusMainnet(repoRoot, { minIntervalMs = 170 } = {}) {
  const url = `https://mainnet.helius-rpc.com/?api-key=${loadHeliusKey(repoRoot)}`;
  if (new URL(url).hostname !== 'mainnet.helius-rpc.com') throw new Error('Helius only');
  let id = 0;
  let last = 0;
  return async function rpc(method, params) {
    for (let attempt = 0; ; attempt++) {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(60_000)
        });
      } catch (e) {
        if (attempt < 5) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new Error(`${method}: ${redact(e?.message ?? e)}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 7) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${redact(await res.text()).slice(0, 200)}`);
      const body = await res.json();
      if (body.error) throw new Error(`${method}: ${redact(JSON.stringify(body.error))}`);
      return body.result;
    }
  };
}
