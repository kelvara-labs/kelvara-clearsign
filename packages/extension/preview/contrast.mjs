// Prints a WCAG contrast table for the text/background token pairs the UI uses. Exit 1 if any pair < its requirement.
import { readFileSync } from "node:fs";
import { EXTENSION_CSS } from "./check-tokens.mjs";

const css = readFileSync(EXTENSION_CSS, "utf8");
const tok = Object.fromEntries([...css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6}|rgba\([^)]*\))\s*;/gi)].map((m) => [m[1], m[2]]));
const parse = (v) => {
  if (v.startsWith("#")) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)).concat(1);
  const n = v.match(/[\d.]+/g).map(Number);
  return [n[0], n[1], n[2], n[3] ?? 1];
};
const over = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]));
const lum = (rgb) => rgb.slice(0, 3).map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const solid = (name) => parse(tok[name]);
const surfaces = ["surface-0", "surface-1", "surface-2", "surface-3"];
const pairs = [];
for (const s of surfaces) for (const t of ["text-1", "text-2", "text-3"]) pairs.push([t, s, t === "text-3" ? 3 : 4.5]);
for (const s of ["surface-1", "surface-2"]) for (const t of ["brand-mint", "brand-violet"]) pairs.push([t, s, 4.5]);
for (const l of ["risk-0", "risk-1", "risk-2", "risk-3", "risk-4", "risk-blocked"]) {
  const fg = l === "risk-blocked" ? "risk-blocked-fg" : `${l}-fg`;
  for (const s of ["surface-1", "surface-2"]) pairs.push([fg, s, 4.5]);
}
for (const s of ["surface-1", "surface-2"]) pairs.push(["brand-violet", s, 4.5]);
const rows = [];
let bad = 0;
for (const [t, s, need] of pairs) {
  const bg = solid(s);
  const r = ratio(solid(t), bg);
  if (r < need) bad++;
  rows.push(`| ${t} | ${s} | ${r.toFixed(2)} | ${need} | ${r >= need ? "pass" : "FAIL"} |`);
}
// on-colour pairs: dark text on the brand gradient stops and on solid risk-4
for (const stop of ["#93f6df", "#62dcc2"]) {
  const r = ratio(solid("on-brand"), parse(stop));
  if (r < 4.5) bad++;
  rows.push(`| on-brand | gradient ${stop} | ${r.toFixed(2)} | 4.5 | ${r >= 4.5 ? "pass" : "FAIL"} |`);
}
const r4 = ratio(solid("on-risk-4"), solid("risk-4-fg"));
if (r4 < 4.5) bad++;
rows.push(`| on-risk-4 | risk-4-fg | ${r4.toFixed(2)} | 4.5 | ${r4 >= 4.5 ? "pass" : "FAIL"} |`);
// risk fg on its own tinted bg (composited over surface-1)
for (const l of [0, 1, 2, 3, 4]) {
  const bg = over(parse(tok[`risk-${l}-bg`]), solid("surface-1"));
  const r = ratio(solid(`risk-${l}-fg`), bg);
  if (r < 4.5) bad++;
  rows.push(`| risk-${l}-fg | risk-${l}-bg on surface-1 | ${r.toFixed(2)} | 4.5 | ${r >= 4.5 ? "pass" : "FAIL"} |`);
}
// accent text on its own soft tint, and the violet devnet chip, composited over surface-2
for (const [fgName, bgName, over2] of [["brand-mint", "accent-soft", "surface-1"], ["brand-mint", "accent-soft", "surface-2"]]) {
  const bg = over(parse(tok[bgName]), solid(over2));
  const r = ratio(solid(fgName), bg);
  if (r < 4.5) bad++;
  rows.push(`| ${fgName} | ${bgName} on ${over2} | ${r.toFixed(2)} | 4.5 | ${r >= 4.5 ? "pass" : "FAIL"} |`);
}
console.log("| foreground | background | ratio | needs | result |\n|---|---|---|---|---|\n" + rows.join("\n"));
process.exit(bad ? 1 : 0);
