// Stub of the engine API until the hour-24 checkpoint (PLAN M5): the real
// @kelvara/core analysis replaces analyze() when it lands on main.
// The stub never claims a transaction is safe: it reports L2 so the request is held.
import type { SignRequest } from "../shared/protocol.js";
import type { Endpoint } from "./endpoint.js";

export interface StubReport {
  level: 0 | 1 | 2 | 3 | 4;
  title: string;
}

export interface EngineLike {
  analyze(req: SignRequest, endpoint: Extract<Endpoint, { ok: true }>): Promise<StubReport>;
}

export const stubEngine: EngineLike = {
  async analyze() {
    return { level: 2, title: "Engine not wired yet (stub): cannot vouch for this transaction" };
  }
};
