// kelvara analyze | replay (M4 / E14).
//
//   kelvara analyze [options] <input...>
//     Inputs form one session, in order: files with base64 wire transactions (one per line), tx fixtures,
//     JSON arrays or {transactions: [...]}; "-" reads stdin; --tx <base64> adds one inline.
//   kelvara replay [options] <signature...>
//     Cached (default): fixtures/tx/**/<signature>.json, sha256 checked, analyzed offline.
//     --live: getTransaction over Helius; the raw bytes and sha256 are stored as fixtures (an existing
//     fixture must match byte for byte), then the session is analyzed with live Helius state.
//
// Output: the human summary, then the result JSON ({kind, command, network, level, alertLevel, ..., report}).
// --json prints only the JSON on stdout (summary on stderr); --out <file> also writes the JSON there.
// Exit 0 when a report was produced (any level), 1 on an error, 2 on bad usage.
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  analyzeSession,
  createRpcAccountReader,
  createRpcClient,
  ingestSession,
  rpcUrlFor,
  ENGINE_VERSION,
  ALERT_LEVELS_V1,
  type IngestInput,
  type Report,
  type RpcClient,
  type RpcNetwork,
  type ReadNote
} from "@kelvara/core";
import { fetchTxFixture, findTxFixture, heliusKey, loadTxFixture, readInput, redact, writeTxFixture } from "./io.js";
import { loadRegistry } from "./registry.js";
import { humanSummary } from "./summary.js";

export const CLI_VERSION = "0.1.0";
export const RESULT_KIND = "kelvara.cli.result/v1";
export const DEFAULT_REPLAY_DIR = "fixtures/tx/replay";

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Injected for tests (recorded responses); default: createRpcClient over Helius or localnet. */
  rpcFor?: (network: RpcNetwork) => RpcClient;
  cwd?: string;
}

export interface CliResult {
  kind: typeof RESULT_KIND;
  command: "analyze" | "replay";
  cliVersion: string;
  engineVersion: string;
  network: RpcNetwork;
  mode: "online" | "offline";
  /** alert-levels-v1 label, lower case ("critical" for L3). */
  level: string;
  alertLevel: Report["alert"]["level"];
  action: Report["alert"]["action"];
  inputs: { label: string; signature: string | null; fixture?: string; sha256?: string }[];
  reads: ReadNote[];
  report: Report;
}

class UsageError extends Error {}

const USAGE = `usage:
  kelvara analyze [--network localnet|devnet|mainnet] [--wallet <address>] [--offline] [--no-simulate]
                  [--no-history] [--inventory] [--idl <file[:programId]>]... [--tx <base64>]...
                  [--json] [--out <file>] <input...>
  kelvara replay  [--live] [--network mainnet|devnet] [--fixtures <dir>] [--wallet <address>]
                  [--json] [--out <file>] <signature...>`;

interface Args {
  cmd: string;
  positional: string[];
  network?: RpcNetwork;
  wallet?: string;
  offline: boolean;
  live: boolean;
  simulate: boolean;
  history: boolean;
  inventory: boolean;
  idls: string[];
  txs: string[];
  json: boolean;
  out?: string;
  fixtures?: string;
}

const NETWORKS: RpcNetwork[] = ["localnet", "devnet", "mainnet"];
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export function parseArgs(argv: string[]): Args {
  const [cmd = "", ...rest] = argv;
  const a: Args = { cmd, positional: [], offline: false, live: false, simulate: true, history: true, inventory: false, idls: [], txs: [], json: false };
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    const value = (): string => {
      const v = rest[++i];
      if (v === undefined) throw new UsageError(`${t} needs a value`);
      return v;
    };
    switch (t) {
      case "--network": {
        const n = value();
        if (!NETWORKS.includes(n as RpcNetwork)) throw new UsageError(`unknown network ${n}`);
        a.network = n as RpcNetwork;
        break;
      }
      case "--wallet": {
        const w = value();
        if (!ADDRESS.test(w)) throw new UsageError(`--wallet ${w} is not an address`);
        a.wallet = w;
        break;
      }
      case "--offline": a.offline = true; break;
      case "--live": a.live = true; break;
      case "--no-simulate": a.simulate = false; break;
      case "--no-history": a.history = false; break;
      case "--inventory": a.inventory = true; break;
      case "--idl": a.idls.push(value()); break;
      case "--tx": a.txs.push(value()); break;
      case "--json": a.json = true; break;
      case "--out": a.out = value(); break;
      case "--fixtures": a.fixtures = value(); break;
      case "-h": case "--help": a.cmd = "help"; break;
      default:
        if (t.startsWith("--")) throw new UsageError(`unknown option ${t}`);
        a.positional.push(t);
    }
  }
  return a;
}

function defaultRpc(root: string): (network: RpcNetwork) => RpcClient {
  return (network) => {
    const key = network === "localnet" ? undefined : heliusKey(root);
    if (network !== "localnet" && !key) throw new Error(`no HELIUS_API_KEY (environment or the main checkout's .env) for ${network}`);
    return createRpcClient({ url: rpcUrlFor(network, key) });
  };
}

function emit(io: CliIO, args: Args, result: CliResult, notes: string[]): void {
  const json = JSON.stringify(result, null, 2);
  const summary = humanSummary(result.report, { command: result.command, network: result.network, reads: result.reads, notes });
  if (args.out) writeFileSync(path.resolve(io.cwd ?? process.cwd(), args.out), json + "\n");
  if (args.json) {
    io.stderr(summary + "\n");
    io.stdout(json + "\n");
  } else {
    io.stdout(summary + "\n\n" + json + "\n");
  }
}

function result(command: CliResult["command"], network: RpcNetwork, online: boolean, report: Report, reads: ReadNote[], inputs: CliResult["inputs"]): CliResult {
  return {
    kind: RESULT_KIND,
    command,
    cliVersion: CLI_VERSION,
    engineVersion: ENGINE_VERSION,
    network,
    mode: online ? "online" : "offline",
    level: ALERT_LEVELS_V1.levels[report.alert.level].label.toLowerCase(),
    alertLevel: report.alert.level,
    action: report.alert.action,
    inputs,
    reads,
    report
  };
}

async function analyzeCmd(args: Args, io: CliIO, cwd: string): Promise<void> {
  const inputs: IngestInput[] = [];
  for (const p of args.positional) inputs.push(...readInput(p === "-" ? p : path.resolve(cwd, p)));
  args.txs.forEach((b, i) => inputs.push({ base64: b.trim(), label: `--tx#${i}` }));
  if (!inputs.length) throw new UsageError("analyze needs at least one input");
  const network = args.network ?? "localnet";
  const reg = loadRegistry({ idls: args.idls.map((f) => path.resolve(cwd, f)) });
  const rpc = args.offline ? null : (io.rpcFor ?? defaultRpc(reg.root))(network);
  const session = await ingestSession(inputs.map((x) => ({ ...x, kind: "auto" as const })), rpc ? { reader: createRpcAccountReader(rpc) } : {});
  const notes: string[] = [];
  if (!args.wallet) notes.push("no --wallet: wallet-bound rules (token traps, sweep, address history) did not run");
  if (!rpc) notes.push("offline: no chain state read and no simulation; missing facts are reported as Unknown");
  const { report, reads } = await analyzeSession(session, {
    decoder: reg.decoder,
    squadsAccounts: reg.squadsAccounts,
    authorityMaps: reg.authorityMaps,
    rpc,
    ...(args.wallet ? { wallet: args.wallet } : {}),
    simulate: args.simulate,
    history: args.history,
    inventory: args.inventory
  });
  const ins = session.transactions.map((t, i) => ({ label: inputs[i]?.label ?? `#${i}`, signature: t.signatures[0]?.signature ?? null }));
  emit(io, args, result("analyze", network, rpc !== null, report, reads, ins), notes);
}

async function replayCmd(args: Args, io: CliIO, cwd: string): Promise<void> {
  const sigs = args.positional;
  if (!sigs.length) throw new UsageError("replay needs at least one signature");
  for (const s of sigs) if (!SIGNATURE.test(s)) throw new UsageError(`${s} is not a transaction signature`);
  const network = args.network ?? "mainnet";
  if (network === "localnet") throw new UsageError("replay reads mainnet or devnet history over Helius");
  const reg = loadRegistry({ idls: args.idls.map((f) => path.resolve(cwd, f)) });
  const rpc = args.live ? (io.rpcFor ?? defaultRpc(reg.root))(network) : null;
  const dir = path.resolve(reg.root, args.fixtures ?? DEFAULT_REPLAY_DIR);
  const notes: string[] = [];
  const ins: CliResult["inputs"] = [];
  const txs: IngestInput[] = [];
  for (const sig of sigs) {
    const existing = findTxFixture(reg.root, sig);
    let fixture;
    let file: string;
    if (rpc) {
      fixture = await fetchTxFixture(rpc, sig);
      if (existing) {
        const stored = loadTxFixture(existing, sig);
        if (stored.transaction !== fixture.transaction) throw new Error(`${path.relative(reg.root, existing)}: stored bytes differ from ${network} (sha256 ${stored.sha256} vs ${fixture.sha256})`);
        file = existing;
        notes.push(`${sig.slice(0, 8)}…: live bytes match ${path.relative(reg.root, existing)}`);
      } else {
        file = writeTxFixture(dir, fixture);
        notes.push(`${sig.slice(0, 8)}…: stored ${path.relative(reg.root, file)} (sha256 ${fixture.sha256})`);
      }
    } else {
      if (!existing) throw new Error(`no cached fixture for ${sig} under fixtures/tx; run with --live`);
      fixture = loadTxFixture(existing, sig);
      file = existing;
    }
    if (fixture.network !== network) throw new Error(`${path.relative(reg.root, file)} is a ${fixture.network} transaction, not ${network}`);
    txs.push({ base64: fixture.transaction, kind: "wire", label: sig });
    ins.push({ label: sig, signature: sig, fixture: path.relative(reg.root, file), sha256: fixture.sha256 });
  }
  const session = await ingestSession(txs, rpc ? { reader: createRpcAccountReader(rpc) } : {});
  session.transactions.forEach((t, i) => {
    if (t.signatures[0]?.signature !== sigs[i]) throw new Error(`fixture bytes for ${sigs[i]} carry signature ${t.signatures[0]?.signature ?? "none"}`);
  });
  if (!rpc) notes.push("cached: analyzed offline from fixtures; --live reads Helius state");
  // Replayed transactions already landed: re-simulating them fails by design (nonce advanced, accounts moved).
  const { report, reads } = await analyzeSession(session, {
    decoder: reg.decoder,
    squadsAccounts: reg.squadsAccounts,
    authorityMaps: reg.authorityMaps,
    rpc,
    ...(args.wallet ? { wallet: args.wallet } : {}),
    simulate: false,
    history: args.history
  });
  emit(io, args, result("replay", network, rpc !== null, report, reads, ins), notes);
}

/** Runs the CLI; returns the exit code. */
export async function main(argv: string[], io: CliIO = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  try {
    const args = parseArgs(argv);
    if (args.cmd === "help" || args.cmd === "") {
      io.stdout(USAGE + "\n");
      return args.cmd === "help" ? 0 : 2;
    }
    if (args.cmd === "analyze") await analyzeCmd(args, io, cwd);
    else if (args.cmd === "replay") await replayCmd(args, io, cwd);
    else throw new UsageError(`unknown command ${args.cmd}`);
    return 0;
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : String(e));
    io.stderr(`kelvara: ${msg}\n`);
    if (e instanceof UsageError) {
      io.stderr(USAGE + "\n");
      return 2;
    }
    return 1;
  }
}
