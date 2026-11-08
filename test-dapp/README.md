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
| `account` | base58 address the wallet shows as connected now (`address`, or a presented one); DOM `#account` |
| `presentAccount(address \| null)` | show `address` (base58 public key) as the connected account on every path until changed; `null` = back to the throwaway key; throws on an invalid address |
| `reset()` | zero the log |
| `lastForge` | report of the last forged-approval run: `attempts`, `learnedChannels`, `answeredRequests` (both must stay empty) |

`SignArgs`: `{ path, txs: base64[], method?: "signTransaction" | "signAndSendTransaction" | "signAllTransactions", legacyArg?: "bytes" | "object", chain?: string, forge?: boolean, account?: string }`.
`account` (base58 public key) presents that address as the connected account for this call only, then restores the previous one: Wallet Standard `accounts[0]` and every `input.account`, legacy `provider.publicKey` (and `connect()`'s result). Use it to make a localnet scenario's signer the requesting wallet, so the extension's `SignRequest.account` is a required signer and wallet-bound rules fire. Public key only: the page never holds that account's private key and signs nothing for it, so the transaction is counted and returned byte-identical (`signed: [false]`). An invalid address resolves `{ ok: false }` without calling the wallet.
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

As a localnet scenario's signer (extension on localnet; `chain` selects localhost:8899 on Wallet Standard paths):

```ts
const pending = page.evaluate(
  ([tx, signer]) => window.kelvaraTestDapp.sign({ path: "ws-app-ready", txs: [tx], chain: "solana:localnet", account: signer }),
  [txB64, signerPubkey]
);
```

## Mock AI provider (loopback, for AI-intent e2e)

`scripts/mock-provider.mjs` is an OpenAI-compatible mock (node:http only, bound to 127.0.0.1). It serves
`POST /v1/chat/completions` and `POST /v1/responses`, parses the selection input exactly as the extension's
`client.ts` sends it, and answers according to a mode.

Start: `node test-dapp/scripts/mock-provider.mjs [--port N]` (prints `{"url","port","modes"}` as one JSON line; ephemeral port by default), or import `startMock({ port, mode, slowMs })` which resolves `{ url, port, last(), setMode(), close() }`.

Select a mode by URL path prefix (`<url>/mode/<name>/v1/chat/completions`, used as the provider API URL) or by `POST <url>/mode/<name>` (sets the default). `GET <url>/last` returns the last request (`path`, `mode`, `authorization`, `headers`, `bodyText`, `input`) or `null`; it is the mock's only introspection and it is loopback-only.

| Mode | Behavior | Extension result |
|---|---|---|
| `select-highest` | valid: highest-priority candidate with priority >= fallback, all its reasons in order | `source=ai`, `status=selected` |
| `fallback` | valid selection of the fallback candidate | `ai` / `selected` |
| `lower-priority` | candidate below fallback priority | engine template, `invalid` |
| `wrong-binding` | binding tampered | `invalid` |
| `invented-reason` | extra reason ID not in the candidate | `invalid` |
| `refusal` | refusal content | `invalid` |
| `malformed` | content is not JSON | `invalid` |
| `http-500` | HTTP 500 | `unavailable` |
| `redirect` | 307 (client uses `redirect: "error"`) | `unavailable` |
| `slow` | answers after 6.5 s (> `AI_TIMEOUT_MS` 5 s) | `unavailable` |
| `oversize` | body > `AI_OUTPUT_MAX` (16384 B) | `unavailable` |

Assertions via `/last`: `authorization` is `null` unless a key was configured; `bodyText` must not contain the key; `input` has only `binding`, `fallbackId`, `candidates` (no bytes, signatures, wallet or page content).

### Granting the optional host permission headlessly

`chrome.permissions.request` shows a native browser prompt that Playwright cannot accept, so Save with a fresh install hangs. Do not add any production permission. Instead, load a **test copy** of `packages/extension/dist` whose `manifest.json` has `"http://127.0.0.1/*"` appended to `host_permissions` (point `KELVARA_EXT_DIR` at the copy). The request then resolves `true` without a prompt, `permissions.contains({origins:["http://127.0.0.1:<port>/*"]})` is `true` (port-agnostic), and the real Options UI works: open `options.html`, expand `#ai-provider`, fill `#ai-url` (`<mock>/mode/<name>/v1/chat/completions`), `#ai-model`, optional `#ai-key`, check `#ai-enabled`, click `#ai-save`, then `#ai-test`. Verified with Chromium headless: Save succeeds, Test reports a valid selection, and `/last` shows `Authorization: Bearer <key>`.
