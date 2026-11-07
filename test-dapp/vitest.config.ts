// Unit tests only: e2e/*.spec.ts are the verifier's Playwright specs (run by `pnpm test:e2e`).
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "e2e/**"] }
});
