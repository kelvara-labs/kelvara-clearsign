// "Copy raw": each top-level instruction as the exact data from the signed message bytes, built in the service
// worker from the session the engine parsed (core parseTransaction). Never built or parsed page-side.
import type { Session } from "@kelvara/core";
import { b58encode, b64encode } from "../shared/codec.js";
import type { RawInstruction } from "../shared/report-view.js";

export function rawInstructions(session: Session): Map<string, RawInstruction> {
  const out = new Map<string, RawInstruction>();
  for (const tx of session.transactions) {
    for (const ix of tx.instructions) {
      if (ix.accounts.some((a) => a.address === null) || ix.accounts.length > 255) continue;
      out.set(`${tx.index}:${ix.index}`, {
        transaction: tx.index,
        index: ix.index,
        programId: ix.programAddress,
        accounts: ix.accounts.map((a) => ({ address: a.address as string, signer: a.signer, writable: a.writable })),
        data: b64encode(ix.data),
        dataBase58: b58encode(ix.data)
      });
    }
  }
  return out;
}
