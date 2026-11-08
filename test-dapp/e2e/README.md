# G7 end-to-end specs (verifier)

Headless Chromium (Playwright's bundled `chromium` channel, which loads extensions headless)
with `packages/extension/dist` against the test dApp (`test-dapp/README.md`).

```sh
pnpm --filter @kelvara/selfcheck test:e2e              # what G7 runs: self-tests, build, specs, verdict
node tools/selfcheck/src/e2e.mjs test-dapp/e2e/levels.spec.ts   # spot check (extra args go to playwright test)
```

Exit 0 PASS, 1 FAIL, 78 PENDING. Playwright is a devDependency of `tools/selfcheck`; specs import
it through `tools/selfcheck/src/playwright.mjs`. No traces, screenshots or videos are kept.

## Cases

| spec | case | needs |
|---|---|---|
| hook-paths | all three paths discovered through the hook's wrapper | — |
| hook-paths | 8 path × method combos caught: SW logged it, outcome consistent (passed = once, identical bytes; blocked = 4001, count 0) | — |
| forged-approval | per path: page forges approvals while the request is pending; 4001, count 0, forger learned no channel and answered nothing | report UI (to forge against a held request) |
| levels | L4 sweep rejected without any click, count 0; report shows L4 and no Sign anyway | real engine, `l4-sweep` fixture; UI for the report half |
| levels | L3 batch (L3 tx + benign tx, one call) held, Block focused by default, Block → 4001, count 0 | real engine, `l3-batch` fixture, UI |
| levels | L3 Sign anyway: plain click does nothing; hold → wallet called once with identical bytes (ws-register, legacy bytes) | real engine, `l3-batch`, UI |
| levels | L2 trap held with both buttons; Block → 4001, count 0 | real engine, `l2-trap` fixture, UI |
| levels | benign transfer: no modal, wallet called once with identical bytes (ws-app-ready, legacy) | real engine, Helius key |
| fail-closed | held request unanswered: still pending at 85 s, 4001 by 115 s, count 0 | UI |
| fail-closed | page removes every element added after the request (the shadow host): 4001 within 5 s, count 0 | UI |

A case marks itself PENDING (`pending(reason)` in support.ts) only when a feature it needs is
absent, after asserting everything that already exists. A plain skip is a FAIL.

Feature detection (static, from the tree under test):
- **report UI**: `dist/manifest.json` has `web_accessible_resources` listing an `.html` page.
- **real engine**: TypeScript AST inspection of the service worker and its stub adapter. Only direct
  `decide(..., stubEngine)` calls using the imported, fixed L2 literal placeholder defer cases.
  A workspace dependency alone changes nothing. Non-stub, mixed, indirect or unrecognized wiring
  runs the engine assertions; unreadable/invalid source fails rather than becoming PENDING.
  Comments, unused stub imports and a real analyzer hidden inside a stub-named adapter cannot
  suppress integrated failures. Regression self-tests run before every G7 invocation.
- **fixtures**: an entry in `fixtures/tx/manifest.json` with `"e2e": "<role>"`, role one of
  `benign`, `l4-sweep`, `l3-batch`, `l2-trap` (scenarios tags them; real executed bytes only).
  Until `benign` is tagged, the real mainnet System transfer `51AfDTHp…` is used.
- **Helius key**: `HELIUS_API_KEY` from the main checkout's `.env`, written into the extension's
  options storage of a throwaway profile. Never printed; runner output is redacted.

## Contract for the extension

The specs code against these; nothing else in the UI is assumed.

- The report UI is a `chrome-extension://<id>/…` frame in the page (inside a closed shadow root
  is fine: Playwright reaches frames, the page cannot).
- Modal report: an element with `data-kelvara-modal`, visible while the request is held or an L4
  report is shown. L0/L1 also show this full modal and wait for a decision.
- Level: an element with `data-kelvara-level="L0".."L4"`.
- Buttons: `data-kelvara-action="block"` and `data-kelvara-action="sign-anyway"`.
  L0/L1 instead offer `data-kelvara-action="continue"` labelled Continue to wallet, armed with
  `data-armed="true"` by the same visibility gate. Only a trusted click forwards, once with identical bytes;
  Block is focused by default and rejects with 4001 without calling the wallet. Full reports have message hashes
  and no `data-kelvara-limited` marker. Harmless engine levels remain L0/L1 while held.
  At L4 there is no sign-anyway element at all. At L3 Block has focus when the modal opens, a
  plain click on Sign anyway does not sign, and the button carries `data-hold-ms="<n>"`: holding
  the mouse down on it for n ms confirms. At L2 both buttons are present.
- The service worker keeps `chrome.storage.local.captureLog` (newest first) with at least
  `{ wallet, method, txCount, allow, level }` for every analyzed request, as it does today.
- Settings keys in `chrome.storage.local`: `heliusApiKey`, `network`.
- Removing the UI's host element from the page, or 90 s with no answer, rejects with 4001.

V14 provider/intent contract: `intent-provider.spec.ts` requires initially collapsed
`#ai-provider` details with URL `#ai-url`, password `#ai-key`, and model `#ai-model`
all invisible until the summary is opened, including after reload. A stored seeded
key must never be prefilled or appear in the DOM; `#ai-delete` clears configuration.
These tests use fake provider credentials and do not demonstrate paid model usage.

`ext.approveConfiguredProvider()` refreshes the G7 runtime oracle after a Save user
gesture: it reads `aiProvider` and Chrome's actual granted origins, requires the
exact configured origin pattern, and permits only that origin. Optional wildcard
capability in the manifest does not count as a runtime grant. Redirects fail even
if the destination is otherwise allowed. The guard does not infer authorization
from provider storage alone. Provider tests must mock transport explicitly and
assert request shape/failures; a mock response is not live provider evidence.
