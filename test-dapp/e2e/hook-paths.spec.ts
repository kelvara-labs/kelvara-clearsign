// G7: both Wallet Standard paths and the legacy provider are caught.
// "Caught" = the app was handed the hook's wrapper, the service worker saw the request
// (captureLog entry with this wallet and method), and the outcome is consistent:
// passed -> the wallet got the identical bytes once; blocked -> 4001 and the wallet was never called.
import { calls, discovered, expect, openDapp, PATHS, SEL, settleOrModal, startSign, test, txCase, WALLET_NAMES, within, type SignArgs, type WalletPath } from "./support.js";

interface Combo {
  path: WalletPath;
  method: NonNullable<SignArgs["method"]>;
  logMethod: string;
  legacyArg?: "bytes" | "object";
  txs: number;
}

const COMBOS: Combo[] = [
  { path: "ws-register", method: "signTransaction", logMethod: "solana:signTransaction", txs: 1 },
  { path: "ws-register", method: "signAndSendTransaction", logMethod: "solana:signAndSendTransaction", txs: 1 },
  { path: "ws-app-ready", method: "signTransaction", logMethod: "solana:signTransaction", txs: 1 },
  { path: "ws-app-ready", method: "signAndSendTransaction", logMethod: "solana:signAndSendTransaction", txs: 1 },
  { path: "legacy", method: "signTransaction", logMethod: "legacy:signTransaction", legacyArg: "object", txs: 1 },
  { path: "legacy", method: "signTransaction", logMethod: "legacy:signTransaction", legacyArg: "bytes", txs: 1 },
  { path: "legacy", method: "signAllTransactions", logMethod: "legacy:signAllTransactions", legacyArg: "object", txs: 2 },
  { path: "legacy", method: "signAndSendTransaction", logMethod: "legacy:signAndSendTransaction", legacyArg: "object", txs: 1 }
];

test("all three wallet paths are discovered through the hook", async ({ ext }) => {
  const page = await openDapp(ext);
  const d = await discovered(page);
  for (const p of PATHS) {
    expect(d[p].found, `${p}: wallet not discovered`).toBe(true);
    expect(d[p].wrapped, `${p}: app got the bare wallet, not the hook's wrapper`).toBe(true);
    expect(d[p].name).toBe(WALLET_NAMES[p]);
  }
});

for (const c of COMBOS) {
  const label = `${c.path} ${c.method}${c.legacyArg ? ` (${c.legacyArg})` : ""} is caught`;
  test(label, async ({ ext }) => {
    const benign = txCase("benign");
    expect(benign, "no benign fixture in fixtures/tx").not.toBeNull();
    const page = await openDapp(ext, benign!.network);
    const txs = Array.from({ length: c.txs }, () => benign!.tx);
    const before = (await ext.captureLog()).length;

    const p = startSign(page, { path: c.path, method: c.method, legacyArg: c.legacyArg, chain: benign!.chain, txs });
    const first = await settleOrModal(ext, p, 30_000);
    expect(first, "request neither settled nor showed a report within 30 s").not.toBe("timeout");

    let result;
    if (first !== "timeout" && "modal" in first) {
      // Held for a decision: nothing reaches the wallet until the user acts. Block.
      expect((await calls(page)).count, "wallet called while the request was held").toBe(0);
      await first.modal.locator(SEL.block).first().click();
      result = await within(p, 10_000);
      expect(result, "Block did not settle the request").not.toBe("pending");
    } else {
      result = (first as { result: Awaited<typeof p> }).result;
    }

    const log = await calls(page);
    if (result !== "pending" && result.ok) {
      expect(log.count, "passed: the wallet must be called exactly once").toBe(1);
      expect(log.calls[0]!.received, "passed: the wallet must get the identical bytes").toEqual(txs);
    } else {
      expect(result).toMatchObject({ ok: false, error: { code: 4001 } });
      expect(log.count, "blocked: the wallet must never be called").toBe(0);
    }

    const entries = await ext.captureLog();
    const mine = entries.slice(0, entries.length - before).filter((e) => e.wallet === WALLET_NAMES[c.path] && e.method === c.logMethod);
    expect(mine.length, `service worker never saw ${c.logMethod} from ${WALLET_NAMES[c.path]}`).toBeGreaterThanOrEqual(1);
    expect(mine[0]!.txCount).toBe(c.txs);
    if (result !== "pending") expect(mine[0]!.allow, "decision logged differs from the outcome").toBe(result.ok);

  });
}
