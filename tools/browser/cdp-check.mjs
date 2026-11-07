#!/usr/bin/env node
// Checks that the Kelvara wallet browser answers CDP on 127.0.0.1:28538 and on
// loopback only, and lists page/extension targets (URLs only, api-key redacted).
/* global fetch, AbortSignal */
// Exit 0 = all checks pass. Usage: node tools/browser/cdp-check.mjs [--expect-signguard]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 28538;
const here = dirname(fileURLToPath(import.meta.url));
const distPath = process.env.SIGNGUARD_DIST ?? resolve(here, '../../packages/extension/dist');
const expectSignguard = process.argv.includes('--expect-signguard');

const redact = (s) => s.replace(/api-key=[^&\s"]*/gi, 'api-key=REDACTED');
const failures = [];
const ok = (msg) => console.log(`PASS ${msg}`);
const fail = (msg) => {
  failures.push(msg);
  console.log(`FAIL ${msg}`);
};

// Chromium derives an unpacked extension's id from the sha256 of its absolute path.
function unpackedExtensionId(path) {
  const hex = createHash('sha256').update(path).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

async function getJson(path) {
  const res = await fetch(`http://${HOST}:${PORT}${path}`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

try {
  const v = await getJson('/json/version');
  if (typeof v.webSocketDebuggerUrl !== 'string') throw new Error('no webSocketDebuggerUrl: not a CDP endpoint');
  const ws = new URL(v.webSocketDebuggerUrl);
  if (ws.hostname !== HOST || ws.port !== String(PORT)) fail(`debugger URL host is ${ws.host}`);
  ok(`CDP answers on ${HOST}:${PORT} (${v.Browser})`);
} catch (e) {
  fail(`CDP on ${HOST}:${PORT}: ${e.message}`);
}

try {
  const out = execFileSync('ss', ['-ltnH', `sport = :${PORT}`], { encoding: 'utf8' });
  const locals = out.trim().split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/)[3]);
  const bad = locals.filter((a) => !/^(127\.0\.0\.1|\[::1\]):\d+$/.test(a));
  if (locals.length === 0) fail(`nothing listens on :${PORT}`);
  else if (bad.length) fail(`listener not loopback-only: ${bad.join(', ')}`);
  else ok(`listener bound to loopback only (${locals.join(', ')})`);
} catch (e) {
  fail(`could not inspect listeners with ss: ${e.message}`);
}

if (failures.length === 0) {
  const targets = await getJson('/json/list');
  for (const t of targets) console.log(`  target ${t.type.padEnd(15)} ${redact(t.url)}`);
  const id = unpackedExtensionId(distPath);
  const seen = targets.some((t) => t.url.startsWith(`chrome-extension://${id}/`));
  const msg = `SignGuard unpacked build (id ${id}) ${seen ? 'has a live target' : 'has no live target (idle MV3 worker or not loaded)'}`;
  if (expectSignguard && !seen) fail(msg);
  else console.log(`INFO ${msg}`);
}

process.exit(failures.length ? 1 : 0);
