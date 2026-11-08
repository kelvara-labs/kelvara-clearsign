// Codama's Anchor converter throws on a PDA seed that names an instruction argument the instruction does not have
// (Velocity's IDL has some). PDA seeds are not used to decode instructions, so such accounts lose only their pda hint;
// the pinned raw file is untouched.
export function dropUnresolvablePdas(idl: unknown): unknown {
  const doc = idl as { instructions?: { args?: { name: string }[]; accounts?: { pda?: { seeds?: { kind?: string; path?: string }[] }; accounts?: unknown[] }[] }[] };
  const fix = (args: Set<string>, accounts: NonNullable<NonNullable<typeof doc.instructions>[number]["accounts"]>): void => {
    for (const a of accounts) {
      if (a.pda?.seeds?.some((sd) => sd.kind === "arg" && !args.has(String(sd.path).split(".")[0]!))) delete a.pda;
      if (Array.isArray(a.accounts)) fix(args, a.accounts as typeof accounts);
    }
  };
  const copy = structuredClone(doc);
  for (const ix of copy.instructions ?? []) fix(new Set((ix.args ?? []).map((x) => x.name)), ix.accounts ?? []);
  return copy;
}
