#!/usr/bin/env node
import { run } from './devnet-scenario.mjs';
import { redact } from './lib/helius.mjs';
run('admin').catch(e => { console.error('[admin-devnet] FAIL ' + redact(e.message)); process.exitCode = 1; });
