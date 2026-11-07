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
- **real engine**: `packages/extension/package.json` depends on `@kelvara/core`.
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
  report is shown. The L1 notice must not carry it.
- Level: an element with `data-kelvara-level="L0".."L4"`.
- Buttons: `data-kelvara-action="block"` and `data-kelvara-action="sign-anyway"`.
  At L4 there is no sign-anyway element at all. At L3 Block has focus when the modal opens, a
  plain click on Sign anyway does not sign, and the button carries `data-hold-ms="<n>"`: holding
  the mouse down on it for n ms confirms. At L2 both buttons are present.
- The service worker keeps `chrome.storage.local.captureLog` (newest first) with at least
  `{ wallet, method, txCount, allow, level }` for every analyzed request, as it does today.
- Settings keys in `chrome.storage.local`: `heliusApiKey`, `network`.
- Removing the UI's host element from the page, or 90 s with no answer, rejects with 4001.
