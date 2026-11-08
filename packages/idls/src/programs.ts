// The IDL registry's programs (PLAN.md section 3, "Core programs and IDLs"). Program ids are
// re-checked on-chain by G5 (executable account, upgrade authority read from ProgramData).
export interface ProgramSpec {
  name: string;
  programId: string;
  priority: "P0" | "P0-demo" | "P1";
  /** idl: decoded from a Codama root (native Codama IDL or converted Anchor IDL); loader/memo: hand-written. */
  decoder: "idl" | "loader" | "memo" | "computeBudget" | "sigverify";
  kind?: "codama" | "anchor";
  repo?: string;
  commit?: string;
  client?: string;
  builtinSource?: string;
  /** Write capabilities/<name>.json (curated/<name>.json when present, else keyword rules). */
  capabilities: boolean;
  /** Write authority/<name>.json from the Anchor IDL. */
  authorityMap?: { review: string; verifiedOverride?: boolean };
  note?: string;
  /** The program has no anchor:idl account: take the IDL Helius serves from the program's on-chain Program Metadata. */
  /** Bundle only the compact Codama root in the extension (no raw Anchor IDL, no authority map): keeps the service worker small. */
  rootOnly?: boolean;
  idlFrom?: "helius-program-metadata";
}

export const PROGRAMS: readonly ProgramSpec[] = [
  { name: "system", programId: "11111111111111111111111111111111", priority: "P0", decoder: "idl", kind: "codama", repo: "solana-program/system", commit: "e9cb05138ea802b01f1ddf79ea140dcd765c9db6", client: "@solana-program/system@0.16.0", capabilities: true },
  { name: "token", programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", priority: "P0", decoder: "idl", kind: "codama", repo: "solana-program/token", commit: "31646dce3df0a03d468a14913f01b9fd3c3adad0", client: "@solana-program/token@0.18.0", capabilities: true },
  { name: "token-2022", programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", priority: "P0", decoder: "idl", kind: "codama", repo: "solana-program/token-2022", commit: "e6b4af36a3dbdfe6f66aaf0c564427fa56671bb0", client: "@solana-program/token-2022@0.20.0", capabilities: true },
  { name: "bpf-loader-upgradeable", programId: "BPFLoaderUpgradeab1e11111111111111111111111", priority: "P0", decoder: "loader", builtinSource: "hand-written decoder packages/core/src/decode/builtin.ts", capabilities: true },
  { name: "squads-v4", programId: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf", priority: "P0", decoder: "idl", kind: "anchor", capabilities: true },
  {
    name: "drift-v2",
    programId: "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH",
    priority: "P0",
    decoder: "idl",
    kind: "anchor",
    capabilities: true,
    authorityMap: {
      review:
        "E12 (engine), 2026-11-07, by hand: legacy IDL (no relations), so all 200 entries are field-name ties, lower confidence by construction: 136 admin -> state.admin, 64 per-user (authority -> user.authority, userStats.authority, insuranceFundStake.authority, referrerName.authority; signer -> state.signer) with admin=false, which program.upgrade previews skip; checked updateAdmin, withdrawFromProgramVault, updatePerpMarketOracle, updateSpotMarketOracle, updateExchangeStatus (admin -> state.admin) against the IDL accounts. On-chain IDL authority Fqo8…Pyn is not the upgrade authority 8jj7…BMai, so the IDL is unverified under PLAN's rule"
    }
  },
  {
    name: "marginfi-v2",
    programId: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    priority: "P0-demo",
    decoder: "idl",
    kind: "anchor",
    capabilities: true,
    authorityMap: {
      review:
        "E12 (engine), 2026-11-07, by hand: Anchor 0.1.0 IDL with relations (has_one), so ties are relation ties (e.g. admin -> marginfi_group.admin); checked lending_pool_add_bank (admin -> marginfi_group.admin), lending_pool_configure_bank and super_admin_withdraw (admin -> group.admin), marginfi_group_configure, panic_pause (global_fee_admin -> fee_state.global_fee_admin) against the IDL accounts; user ties (authority -> marginfi_account.authority) are admin=false. Demo program: the localnet binary has no IDL instructions and the IDL account predates that build (packages/scenarios/programs/README.md), so this map stays unverified whatever the mainnet check says",
      verifiedOverride: false
    },
    note: "demo upgrade target (packages/scenarios/programs/marginfi_v2.idl.json is the same IDL account content); also PLAN P1 (heuristic, low confidence)"
  },
  { name: "jupiter-v6", programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", priority: "P1", decoder: "idl", kind: "anchor", capabilities: true, note: "Jupiter v6 aggregator (swaps); IDL from the on-chain anchor:idl account" },
  { name: "velocity", programId: "vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P", priority: "P1", decoder: "idl", kind: "anchor", idlFrom: "helius-program-metadata", capabilities: true, note: "Velocity; no anchor:idl account, IDL from the program's on-chain Program Metadata as served by Helius Parsed Events (Orb shows the same IDL)" },
  { name: "kamino-lending", programId: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", priority: "P1", decoder: "idl", kind: "anchor", rootOnly: true, idlFrom: "helius-program-metadata", capabilities: true, note: "Kamino Lending (klend); catalog name kamino_lending; display name is ours, program found in real Kamino transactions" },
  { name: "kamino-vault", programId: "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd", priority: "P1", decoder: "idl", kind: "anchor", rootOnly: true, idlFrom: "helius-program-metadata", capabilities: true, note: "Kamino Vaults (kvaults); catalog name kamino_vault; every sampled call also invokes Kamino Lending; display name is ours, program found in real Kamino transactions" },
  { name: "kamino-farms", programId: "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr", priority: "P1", decoder: "idl", kind: "anchor", rootOnly: true, idlFrom: "helius-program-metadata", capabilities: true, note: "Kamino Farms; catalog name farms; invoked by Kamino Lending in sampled kamino.com-style transactions; display name is ours, program found in real Kamino transactions" },
  { name: "kamino-scope", programId: "HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ", priority: "P1", decoder: "idl", kind: "anchor", rootOnly: true, idlFrom: "helius-program-metadata", capabilities: true, note: "Kamino Scope oracle; catalog name scope; appears in sampled Kamino Lending transactions; display name is ours, program found in real Kamino transactions" },
  { name: "kamino-liquidity", programId: "6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc", priority: "P1", decoder: "idl", kind: "anchor", rootOnly: true, idlFrom: "helius-program-metadata", capabilities: true, note: "Kamino Liquidity (yvaults strategies); catalog name yvaults; display name is ours, program found in real Kamino transactions" },
  { name: "memo", programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", priority: "P1", decoder: "memo", builtinSource: "hand-written decoder packages/core/src/decode/builtin.ts", capabilities: false },
  { name: "compute-budget", programId: "ComputeBudget111111111111111111111111111111", priority: "P1", decoder: "computeBudget", builtinSource: "hand-written decoder packages/core/src/decode/builtin.ts", capabilities: true },
  { name: "ed25519", programId: "Ed25519SigVerify111111111111111111111111111", priority: "P1", decoder: "sigverify", builtinSource: "hand-written decoder packages/core/src/decode/builtin.ts (Solana Ed25519 precompile layout)", capabilities: true },
  { name: "secp256k1", programId: "KeccakSecp256k11111111111111111111111111111", priority: "P1", decoder: "sigverify", builtinSource: "hand-written decoder packages/core/src/decode/builtin.ts (Solana secp256k1 precompile layout)", capabilities: true },
  { name: "secp256r1", programId: "Secp256r1SigVerify1111111111111111111111111", priority: "P1", decoder: "sigverify", builtinSource: "hand-written decoder packages/core/src/decode/builtin.ts (Solana secp256r1 precompile layout)", capabilities: true }
];
