#!/usr/bin/env node
import { run } from './devnet-scenario.mjs';
import { redact } from './lib/helius.mjs';
run('trap').catch(e => { console.error('[trap-devnet] FAIL ' + redact(e.message)); process.exitCode = 1; });
