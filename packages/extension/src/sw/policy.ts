// Turn an analysis into allow/block. Fail closed everywhere.
import type { SignRequest, WorkerVerdict } from "../shared/protocol.js";
import { pickEndpoint, type Network } from "./endpoint.js";
import type { EngineLike } from "./engine-stub.js";

export interface Settings {
  heliusApiKey?: string;
  network: Network;
  /** Dev aid from sol-sign-preview: skip the hold; the wallet's own prompt still shows. */
  passThrough: boolean;
}

/**
 * Asks the user for L2/L3. Until the report UI lands (M5 UI task) this is absent,
 * and a held request is blocked.
 */
export type AskUser = (req: SignRequest, level: 2 | 3, title: string) => Promise<boolean>;

export async function decide(
  req: SignRequest,
  settings: Settings,
  engine: EngineLike,
  askUser?: AskUser
): Promise<WorkerVerdict> {
  if (settings.passThrough) return { allow: true, level: null, reason: "pass-through mode" };
  const endpoint = pickEndpoint(req.chain, settings.network, settings.heliusApiKey);
  if (!endpoint.ok) return { allow: false, level: null, reason: endpoint.reason };
  let report;
  try {
    report = await engine.analyze(req, endpoint);
  } catch {
    return { allow: false, level: null, reason: "engine error" };
  }
  const { level, title } = report;
  if (level === 0 || level === 1) return { allow: true, level, reason: title };
  if (level === 4) return { allow: false, level, reason: title };
  if (!askUser) return { allow: false, level, reason: `${title} (no report UI yet: blocked)` };
  try {
    return { allow: (await askUser(req, level, title)) === true, level, reason: title };
  } catch {
    return { allow: false, level, reason: "report UI error" };
  }
}
