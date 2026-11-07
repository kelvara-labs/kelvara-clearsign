// E9 test data: fixtures/poison (S7, real Helius responses) + the engine's own recording of the calls S7
// did not make (test/fixtures/poison/history.json, `pnpm --filter @kelvara/core fixtures:poison-history`).
import { readAddressRuleState, readTokenRuleState, readTransferHistory, createRpcAccountReader, type ReadHistoryOptions, type RuleState, type Session, type WalletHistory } from "../src/index.js";
import { decoder, json, sessionOf } from "./rules-helpers.js";
import { anchorOf, poisonRpc, requestWire, type Call, type PoisonFixture } from "./poison-replay.js";

export interface PoisonCase {
  id: string;
  kind: "poisoning" | "first-send";
  network: "mainnet" | "devnet";
  user: string;
  recipient: string;
  lookalikeOf?: string;
  match?: { prefix: number; suffix: number };
  request: string | null;
  expect: { rule: string; level: string; notL4?: boolean; notRules?: string[] };
  path: string;
}

export const poisonManifest = json<{ cases: PoisonCase[] }>("fixtures/poison/manifest.json");
const recorded = json<{ cases: Record<string, Call[]> }>("packages/core/test/fixtures/poison/history.json").cases;

export const fixtureOf = (c: PoisonCase): PoisonFixture => json<PoisonFixture>(`fixtures/${c.path}`);
export const rpcOf = (c: PoisonCase) => poisonRpc(fixtureOf(c), recorded[c.id] ?? []);
/** Same page size as the recording: the replay serves pages only as far as they were recorded. */
export const HISTORY_OPTS = { pageSize: 100 } as const;

/** History at the fixture's analysis point, for the recipient only (no request transaction needed). */
export async function historyOf(c: PoisonCase, opts: Partial<ReadHistoryOptions> = {}): Promise<WalletHistory> {
  const fx = fixtureOf(c);
  return readTransferHistory(rpcOf(c), { wallet: c.user, counterparties: [{ address: c.recipient }], now: anchorOf(fx).blockTime, ...HISTORY_OPTS, ...opts });
}

/** The executed request as a session, with token state and address history read through the replay. */
export async function requestCase(c: PoisonCase, opts: Partial<ReadHistoryOptions> = {}): Promise<{ session: Session; state: RuleState }> {
  const fx = fixtureOf(c);
  const session = await sessionOf([requestWire(fx, json)]);
  const rpc = rpcOf(c);
  const token = await readTokenRuleState(createRpcAccountReader(rpc), session, c.user);
  const state = await readAddressRuleState(rpc, session, decoder.decodeSession(session), token, { now: anchorOf(fx).blockTime, ...HISTORY_OPTS, ...opts });
  return { session, state };
}
