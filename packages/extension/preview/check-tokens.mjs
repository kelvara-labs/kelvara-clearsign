// Token-drift check: the design-token block at the top of the extension's interface.css must be
// byte-identical to the copy in the playground's style.css. `--write` resyncs the playground copy.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_CSS = path.resolve(here, "../static/interface.css");
export const PLAYGROUND_CSS = path.resolve(here, "../../scenarios/demo/style.css");
const BEGIN = "/* tokens:begin */";
const END = "/* tokens:end */";

export function tokenBlock(css) {
  const a = css.indexOf(BEGIN);
  const b = css.indexOf(END);
  if (a < 0 || b < a) throw new Error("token markers not found");
  if (css.indexOf(BEGIN, a + 1) >= 0) throw new Error("more than one token block");
  return css.slice(a, b + END.length);
}

export function drift() {
  const ext = tokenBlock(readFileSync(EXTENSION_CSS, "utf8"));
  const play = tokenBlock(readFileSync(PLAYGROUND_CSS, "utf8"));
  return ext === play ? null : { ext, play };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write")) {
    const css = readFileSync(PLAYGROUND_CSS, "utf8");
    writeFileSync(PLAYGROUND_CSS, css.replace(tokenBlock(css), tokenBlock(readFileSync(EXTENSION_CSS, "utf8"))));
    console.log("playground tokens resynced");
  } else if (drift()) {
    console.error("design tokens drifted between extension interface.css and playground style.css (run: node preview/check-tokens.mjs --write)");
    process.exit(1);
  } else console.log("design tokens identical");
}
