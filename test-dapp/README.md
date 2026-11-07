# Test dApp (G7)

Static page with a fixture wallet. The wallet has a throwaway Ed25519 key made with
WebCrypto on every page load (never stored), installs itself three ways, signs, never
submits, makes no network requests, and counts every call that reaches it.

```sh
node test-dapp/scripts/serve.mjs --port 5174   # builds, then serves http://127.0.0.1:5174/
node test-dapp/scripts/serve.mjs --build-only  # just test-dapp/dist/
pnpm --filter @kelvara/test-dapp test          # unit tests (key, signing, counter)
```

Use `127.0.0.1` or `localhost` (the manifest matches both, any port); content scripts do
not run on `file://`. The server also serves `fixtures/` read-only at `/fixtures/`.

## Wallet paths

| path | how the app finds the wallet | wallet name |
|---|---|---|
| `ws-register` | wallet dispatches `wallet-standard:register-wallet` after the app listens | `Kelvara Fixture (register)` |
| `ws-app-ready` | app dispatches `wallet-standard:app-ready`; wallet was listening | `Kelvara Fixture (app-ready)` |
| `legacy` | `window.solana` (same object at `window.phantom.solana`) | `Kelvara Fixture (legacy)` |

The app always calls the object `register()` handed it, so whatever the extension put in
between is what runs. The Wallet Standard wallet uses `#private` fields like real wallets.

## Page API: `window.kelvaraTestDapp`

Types are exported from `test-dapp/src/index.ts` (`TestDappApi`, `SignArgs`, `SignResult`, `CallLog`).

| member | meaning |
|---|---|
| `ready: Promise<void>`, `isReady` | key made and wallets registered; also `<html data-test-dapp-ready="true">` |
| `address` | base58 address of the throwaway key |
| `discovered[path]` | `{ found, wrapped, name }`; `wrapped` is true when the app got a different object/function than the wallet installed, i.e. the hook is in place |
| `sign(args)` | never throws; resolves `{ ok: true, signed: string[], signatures? }` or `{ ok: false, error: { name, message, code } }` (a hook rejection is `code: 4001`) |
| `signMessage(path, text)` | message signing (passes through with a notice) |
| `calls()` | snapshot `CallLog`: `count` (tx-signing calls that reached the wallet), `byPath`, `calls[]` with `received` (base64, exactly the bytes the wallet got), `returned`, `signed`, plus `messageCount`, `messages[]` |
| `reset()` | zero the log |
| `lastForge` | report of the last forged-approval run: `attempts`, `learnedChannels`, `answeredRequests` (both must stay empty) |

`SignArgs`: `{ path, txs: base64[], method?: "signTransaction" | "signAndSendTransaction" | "signAllTransactions", legacyArg?: "bytes" | "object", chain?: string, forge?: boolean }`.
Defaults: `signTransaction` (legacy with several txs: `signAllTransactions`), `legacyArg: "object"` (web3.js-like `serialize()`), `chain: "solana:devnet"`.
Wallet Standard paths take several txs as several inputs to one call. `signAndSendTransaction` signs and returns the signature without sending.

The wallet fills its own signer slot when its key is a signer; fixture transactions with
other fee payers are counted and returned unchanged (`signed: [false]`).
`forge: true` runs a hostile page while the call is pending: patches `dispatchEvent` and
`CustomEvent` to sniff the channel, replays the hook-ready handshake, offers a fake
bridge channel, and sprays approval `postMessage`s and decision events every 100 ms.

DOM: `#call-count` (text and `data-count`), `#count-<path>`, `#found-<path>`, `#result` (`data-ok`), buttons `#sign-btn`, `#forge-btn`, `#msg-btn`, `#reset-btn`, inputs `#tx-input`, `#path-input`, `#method-input`.

## Example (Playwright)

```ts
await page.goto("http://127.0.0.1:5174/");
await page.evaluate(() => window.kelvaraTestDapp.ready);
const pending = page.evaluate((tx) => window.kelvaraTestDapp.sign({ path: "ws-app-ready", txs: [tx] }), txB64);
// ... click Block in the report ...
expect(await pending).toMatchObject({ ok: false, error: { code: 4001 } });
expect(await page.evaluate(() => window.kelvaraTestDapp.calls().count)).toBe(0);
```
