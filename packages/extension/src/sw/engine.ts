// The real engine in the service worker (PLAN M5, after the hour-24 checkpoint): @kelvara/core's
// analyzeSession over Helius (mainnet/devnet, key from options storage) or localhost:8899, mapped onto the
// report UI's view by fromReport. Fails closed: any throw, timeout, invalid report or hash mismatch
// rejects with an EngineFailure, and decide() turns that into a blocked verdict, never a pass.
// Error texts are fixed strings: nothing from an RPC error (which could carry the endpoint URL) is shown.
import { validateIntentContext, type AnalyzeResult, analyzeSession, createRpcAccountReader, createRpcClient, ingestSession, type RpcClient, type Session } from "@kelvara/core";
import { templateIntent } from "../intent/selection.js";
import type { SignRequest } from "../shared/protocol.js";
import type { Endpoint } from "./endpoint.js";
import { EngineFailure } from "./engine-failure.js";
import type { EngineLike, EngineReport } from "./engine-stub.js";
import { fromReport } from "./from-report.js";
import { registry, type Registry } from "./registry.js";

export { EngineFailure };

/** Whole analysis budget: well inside the page's 90 s hold, so the user still gets a report. */
export const ENGINE_TIMEOUT_MS = 40_000;


export interface RealEngineDeps {
  rpcFor(url: string): RpcClient;
  registry(): Registry;
  timeoutMs: number;
}

const defaults: RealEngineDeps = {
  rpcFor: (url) => createRpcClient({ url }),
  registry,
  timeoutMs: ENGINE_TIMEOUT_MS
};

/**
 * The connected account, used only when it is a required signer of the request: the page reports it,
 * so it may pick among the request's own signers but never bring in an unrelated wallet. Never inferred.
 */
export function walletFor(req: SignRequest, session: Session): string | undefined {
  const account = req.account;
  if (!account) return undefined;
  return session.transactions.some((t) => t.signatures.some((s) => s.signer === account)) ? account : undefined;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EngineFailure(`engine timed out after ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export async function analyzeRequest(req: SignRequest, url: string, deps: RealEngineDeps): Promise<Pick<AnalyzeResult, "report" | "intentContext">> {
  let reg: Registry;
  let rpc: RpcClient;
  try {
    reg = deps.registry();
    rpc = deps.rpcFor(url);
  } catch {
    throw new EngineFailure("engine error: could not start the analysis");
  }
  let session: Session;
  try {
    session = await ingestSession(
      req.txs.map((base64, i) => ({ base64, kind: "wire" as const, label: `${req.method}#${i}` })),
      { reader: createRpcAccountReader(rpc) }
    );
  } catch {
    throw new EngineFailure("engine error: could not read the transaction");
  }
  const wallet = walletFor(req, session);
  try {
    const { report, intentContext } = await analyzeSession(session, {
      decoder: reg.decoder,
      squadsAccounts: reg.squadsAccounts,
      authorityMaps: reg.authorityMaps,
      rpc,
      ...(wallet ? { wallet, inventory: true } : {})
    });
    return { report, intentContext };
  } catch {
    throw new EngineFailure("engine error: analysis failed");
  }
}

export function createRealEngine(overrides: Partial<RealEngineDeps> = {}): EngineLike {
  const deps: RealEngineDeps = { ...defaults, ...overrides };
  return {
    async analyze(req, endpoint: Extract<Endpoint, { ok: true }>, hashes): Promise<EngineReport> {
      if (!hashes) throw new EngineFailure("engine error: no message hashes");
      const { report, intentContext } = await withTimeout(analyzeRequest(req, endpoint.url, deps), deps.timeoutMs);
      const mapped = fromReport(report, hashes);
      if (!mapped.ok) throw new EngineFailure(mapped.reason);
      const validated = validateIntentContext(intentContext, hashes);
      if (!validated) throw new EngineFailure("engine error: intent context failed validation");
      mapped.report.intent = templateIntent(validated);
      // decide() adds the worker's own hashes and the license flag back.
      const view: Partial<typeof mapped.report> = { ...mapped.report };
      delete view.messageHashes;
      delete view.limited;
      return { level: mapped.level, ...(view as Omit<typeof mapped.report, "messageHashes" | "limited">) };
    }
  };
}

export const realEngine: EngineLike = createRealEngine();
