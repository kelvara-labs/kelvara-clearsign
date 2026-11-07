import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "fixtures/**", "packages/scenarios/programs/**", "playwright-report/**", "test-results/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } }
  }
);
