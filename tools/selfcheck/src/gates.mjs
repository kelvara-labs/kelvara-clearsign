// The ten gates. Commands are root package scripts; each delegates to the owning package.
// timeoutMs defaults to 15 minutes per command; a timeout is a FAIL.
// A command that exits 78 reports PENDING (nothing built yet). PENDING never counts as PASS.
export const GATES = [
  { id: "G1", name: "build", milestone: "M0", fast: true, cmds: ["pnpm build", "pnpm typecheck", "pnpm lint"] },
  { id: "G2", name: "decode", milestone: "M1", fast: true, cmds: ["pnpm test:decode"] },
  { id: "G3", name: "rules", milestone: "M2", fast: true, cmds: ["pnpm test:rules"] },
  { id: "G4", name: "contract", milestone: "M2", fast: true, cmds: ["pnpm test:contract"] },
  { id: "G5", name: "registry", milestone: "M3", cmds: ["pnpm test:registry"] },
  { id: "G6", name: "localnet", milestone: "M4", cmds: ["pnpm test:localnet"], timeoutMs: 30 * 60_000 },
  { id: "G7", name: "e2e", milestone: "M5", cmds: ["pnpm test:e2e"], timeoutMs: 30 * 60_000 },
  { id: "G8", name: "replay", milestone: "M6", cmds: ["pnpm test:replay"], timeoutMs: 30 * 60_000 },
  { id: "G9", name: "determinism", milestone: "M7", cmds: ["pnpm test:determinism"] },
  { id: "G10", name: "security", milestone: "M7", cmds: ["pnpm test:security"] }
];
export const PENDING_EXIT = 78;
