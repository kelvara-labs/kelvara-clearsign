// Stub of the engine API until the hour-24 checkpoint (PLAN M5): the real
// @kelvara/core analysis replaces analyze() when it lands on main, mapped into the
// same EngineReport (the report UI's view without the message hashes, which the
// worker computes itself from the bytes it was given).
// The stub never claims a transaction is safe: it reports L2 so the request is held.
import type { SignRequest } from "../shared/protocol.js";
import type { ReportView } from "../shared/report-view.js";
import type { Endpoint } from "./endpoint.js";

export type EngineReport = Omit<ReportView, "messageHashes"> & { level: 0 | 1 | 2 | 3 | 4 };

export interface EngineLike {
  analyze(req: SignRequest, endpoint: Extract<Endpoint, { ok: true }>): Promise<EngineReport>;
}

export const stubEngine: EngineLike = {
  async analyze(req) {
    return {
      level: 2,
      title: "Not analyzed: the analysis engine is not wired in yet",
      summary:
        "SignGuard could not read what this request authorizes, so it cannot vouch for it. Block unless you trust this site and checked the request in your wallet.",
      simulation: null,
      authorizes: null,
      capabilities: [],
      preview: [],
      claims: [
        {
          id: "extension.engine_stub",
          kind: "Unknown",
          text: `${req.txs.length} transaction(s) were not analyzed. Unknown is never treated as safe.`,
          evidence: ["Engine stub in packages/extension/src/sw/engine-stub.ts (PLAN M5: real engine after the hour-24 checkpoint)"]
        }
      ]
    };
  }
};
