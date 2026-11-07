#!/usr/bin/env node
// Entry point; bundled to dist/kelvara.mjs (core inlined) by `pnpm --filter @kelvara/cli build`.
import { main } from "./index.js";

process.exitCode = await main(process.argv.slice(2));
