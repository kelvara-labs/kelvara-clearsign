// Derives the Options "Programs" list from the bundled registry (packages/idls/registry.json, manifest.json and
// the capability maps). Used by gen-programs.mjs (build step) and by the unit test that checks the committed data.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const idls = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../idls");
const read = (p) => JSON.parse(readFileSync(path.join(idls, p), "utf8"));

const NAMES = {
  system: "System Program",
  token: "SPL Token",
  "token-2022": "Token-2022",
  "bpf-loader-upgradeable": "BPF Loader (upgradeable)",
  "squads-v4": "Squads v4",
  "drift-v2": "Drift v2",
  "marginfi-v2": "marginfi v2",
  "jupiter-v6": "Jupiter v6",
  memo: "Memo",
  "compute-budget": "Compute Budget"
};
const CLASS_UNDERSTANDS = {
  admin_control: "authority changes",
  code_control: "program upgrades",
  mint_control: "mint authority",
  freeze: "freezing",
  fund_movement: "transfers",
  bounded_spend: "delegates and spending limits",
  account_control: "account ownership and closing",
  config: "settings changes"
};

function titleCase(name) {
  return name.replace(/-v(\d+)$/, " v$1").replace(/(^|[ -])([a-z])/g, (_, s, c) => (s ? " " : "") + c.toUpperCase()).trim();
}

export function buildProgramList() {
  const manifest = new Map(read("manifest.json").idls.map((e) => [e.name, e]));
  return read("registry.json").programs.map((p) => {
    const m = manifest.get(p.name);
    const capability = p.capabilities ? read(p.capabilities) : null;
    const classes = new Set((capability?.entries ?? []).map((e) => e.class));
    const understands = Object.keys(CLASS_UNDERSTANDS).filter((c) => classes.has(c)).map((c) => CLASS_UNDERSTANDS[c]);
    if ((capability?.entries ?? []).some((e) => e.capability === "compute.budget")) understands.push("fees and compute limits");
    const anchor = typeof m?.format === "string" && m.format.startsWith("anchor");
    const builtin = p.decoder === "builtin";
    return {
      name: p.name,
      title: NAMES[p.name] ?? titleCase(p.name),
      programId: p.programId,
      kind: builtin ? "Built-in" : anchor ? "Anchor IDL" : "Codama",
      understands,
      source: builtin ? "Built-in decoder" : anchor ? "On-chain IDL" : "Official repo",
      verification: builtin ? "Built in" : anchor ? (m.verified === true ? "Verified" : "Unverified") : "Official",
      detail: m?.verification ?? p.source
    };
  });
}
