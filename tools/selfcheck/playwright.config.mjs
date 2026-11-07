// G7 Playwright config: specs live in test-dapp/e2e (verifier-owned); Playwright is a
// devDependency of tools/selfcheck. Run through `node tools/selfcheck/src/e2e.mjs` (pnpm test:e2e),
// which builds the extension, passes the port and the key via env, and classifies the result.
import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const port = Number(process.env.TEST_DAPP_PORT ?? "5174");
process.env.TEST_DAPP_URL = `http://127.0.0.1:${port}/`;

export default defineConfig({
  testDir: path.join(root, "test-dapp/e2e"),
  outputDir: path.join(here, "logs/e2e-results"),
  timeout: 120_000,
  retries: 0,
  forbidOnly: true,
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS ?? "4"),
  reporter: [["list"], ["json", { outputFile: process.env.E2E_JSON ?? path.join(here, "logs/e2e-report.json") }]],
  // No traces, screenshots or videos: they could capture storage or URLs with the key.
  use: { trace: "off", screenshot: "off", video: "off" },
  webServer: {
    command: `node ${JSON.stringify(path.join(root, "test-dapp/scripts/serve.mjs"))} --port ${port} --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore"
  }
});
