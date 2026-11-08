# SignGuard design brief (coordinator → designer, D1)

Owner: coordinator. Binding for the designer role together with the "Designer rules" in CLAUDE.md.
Where this brief and a test-facing contract disagree, the contract wins: ask the coordinator.

## 1. Product and user
SignGuard sits between a dApp and the user's wallet. It interrupts a signing request, shows what the
transaction really does, and waits for the user's decision before the wallet ever opens. The user is in
the middle of a task, slightly impatient, possibly being phished. The design job is to make the right
decision obvious in two seconds and the evidence available in ten, without crying wolf on harmless
transactions.

Reference bar: Phantom's transaction confirmation and settings. Match its calm density, legibility,
and single-primary-action clarity. Do not copy its branding, illustrations or layout literally.

## 2. Audit of the current UI (what to fix)
- Type is too small: 23 declarations at 9-11 px in interface.css. Minimum body 13 px, minimum
  meta/label 11 px (uppercase eyebrows 11 px with tracking, never 9 px).
- Two style systems: report.html carries its own inline `<style>`; popup/options use interface.css.
  The AI-provider block appended at the end of interface.css uses off-palette hex values
  (#10141d, #303b4b, #edf1f7). Unify everything onto one token set.
- interface.css is minified into eight lines; it must become readable, sectioned source
  (tokens, base, components, surfaces, utilities). Size is irrelevant at this scale.
- Risk levels are not a designed scale: L0-L4 need distinct, consistent colour, icon and wording.
- `Inter` is named in the font stack but not shipped: either bundle nothing and use the system stack
  (preferred, zero network), or ship a local font file with its licence row in LICENSES.md. No CDN.

## 3. Principles
1. Decision first. Level, headline risk and the primary action are above the fold at 375×640.
2. One primary action per screen. On L0/L1 it is Continue; on L2-L4 the safe action (Block) is
   visually primary and Sign anyway is secondary/destructive.
3. Progressive disclosure. Summary → "what you authorize" → capabilities → claims/evidence → hashes.
   Detail lives in collapsible sections; nothing important is only in a tooltip.
4. Honest tone. Neutral for L0, informative L1, caution L2, warning L3, danger L4. Never green
   "safe" language: SignGuard reports evidence, it does not certify safety.
5. Calm surfaces, loud signals. Neutral dark surfaces; colour is reserved for meaning.
6. Same system everywhere: report, popup, options and the playground share tokens and components.

## 4. Design tokens (single source: top of interface.css; copied verbatim into playground style.css)
Name tokens semantically; values below are the starting point, tune for contrast but keep the roles.

Colour (dark theme, colour-scheme: dark):
- `--surface-0` app background `#0b101b`; `--surface-1` card `#121a28`; `--surface-2` raised/inputs
  `#182233`; `--border` `rgba(174,193,229,.14)`; `--border-strong` `rgba(174,193,229,.24)`.
- `--text-1` `#edf2fc`; `--text-2` `#a3b0c6` (must pass 4.5:1 on surface-1); `--text-3` placeholder only.
- Brand: `--brand-mint` `#80efd3`, `--brand-violet` `#a99aff`, `--brand-gradient` (primary button only).
- Risk scale, each with `-fg`, `-bg` (≈8% tint) and `-border` (≈25% tint):
  `--risk-0` neutral slate, `--risk-1` blue `#89c6f7`, `--risk-2` amber `#ffc886`,
  `--risk-3` orange `#ff9f6e`, `--risk-4` red `#ff6b7a`, plus `--risk-blocked` (analysis
  unavailable) = red outline style distinct from L4 fill.
- Focus ring `--focus` = mint, 2 px, offset 2 px, always visible on keyboard focus.

Type (system stack: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
mono: ui-monospace, "SF Mono", Menlo, monospace):
- Display 22/28 650 (report headline, popup hero) · Title 17/24 600 · Body 14/21 400 ·
  Body-sm 13/19 · Label 12/16 600 · Meta 11/16 500 (uppercase eyebrow: 11 px, +0.08em).
- Numbers and amounts `font-variant-numeric: tabular-nums`. Addresses and hashes in mono 12-13 px.

Space: 4 px base: 4, 8, 12, 16, 20, 24, 32, 40. Card padding 16 (popup/report) or 24 (options).
Radius: 8 controls, 12 cards, 16 modal, 999 pills. Elevation: one modal shadow, one card shadow.
Motion: 120-180 ms ease-out for hover/expand; no motion on decision controls beyond state;
`prefers-reduced-motion` removes all transitions.

## 5. Components (build once, use on every surface)
- Button: primary (gradient, dark text), secondary (surface-2, border), danger (risk-4 fill for
  L4/blocked Block, or risk-4 outline for Sign anyway), ghost/text. Heights 44 (default) / 36
  (compact). Disabled and "not yet armed" states must be visually distinct and explained by text.
- Hold-to-confirm (L3 Sign anyway, data-hold-ms): keep behaviour; show a progress fill across the
  button driven by existing state, with an accessible label. Never make it look primary.
- Risk banner: icon + "L3 · Warning"-style label + one-line headline, coloured by risk token.
  Keep the existing `data-kelvara-level` element and level text.
- Card / collapsible section: header row (title, count badge, chevron), body. Use native
  `<details>/<summary>` where they already exist.
- Pill/badge: level, network (devnet/mainnet/localnet), claim kind, "AI-selected" vs "Engine".
- Address/hash: mono, middle-truncated visually (first 4…last 4) with the full value in the DOM and
  revealed on expand; never lose characters in the accessible text. Lookalike comparison keeps
  per-character `<mark>` for matching prefix/suffix with a clear legend.
- Key-value row, list row, empty state, inline status/result message (ok/info/error tones).

## 6. Surfaces
### Report modal (report.html, src/report/*)
Layout top to bottom, max width 440 px centred, full-bleed under 480 px:
1. Header: SignGuard mark, requesting site origin, network pill.
2. Risk banner (level, headline). L4: strongest treatment, red, no Sign anyway element exists.
   Blocked: distinct "analysis unavailable" treatment.
3. Summary sentence and "What you authorize" (the single most important line, emphasised).
4. Intent question card: question as a title, reasons as a short list, source badge
   ("Engine template" / "AI-selected · engine-authored question"), history note in text-2,
   "Compare addresses" collapsible, "That's not my intent" choices as secondary chips.
5. Capabilities (ranked, risk-tinted dots), capability preview, claims with evidence explorer.
6. Message hashes (collapsed, mono).
7. Sticky decision footer, always visible: L0/L1 Continue (primary) + Block (secondary);
   L2 Block (primary) + Sign anyway (secondary); L3 Block (primary) + hold-to-sign (danger outline);
   L4/blocked Block/Dismiss only. Keep the anti-clickjacking/readiness hint text visible near controls.
### Toolbar popup (popup.html, src/popup/page.ts), 360-380 px wide
Header (mark, settings icon), status hero (ready / setup needed / error), three metrics, recent
activity list with level-coloured rows, footer with network and privacy note.
### Options (options.html, src/options/*page.ts)
Single column, max 720 px: page title, setup indicator, cards for Helius key, default network,
optional AI provider (collapsed `<details>` with disclosure text; key field never prefilled), footer.
Inputs 44 px, labels above, hints below, inline result messages.
### Playground (packages/scenarios/demo)
Same tokens and components. Header with SignGuard mark + "Devnet playground", the connected-account
card, then scenario cards (GOOD, trap, admin, sweep, fees) each with a risk-tinted badge for its
expected level, a one-line description, and a primary action. Disabled-when-disconnected state must be
obvious. It must read as the same product as the extension.

## 7. Accessibility
WCAG 2.2 AA: text contrast ≥ 4.5:1 (≥ 3:1 for ≥ 18 px), non-text UI ≥ 3:1, colour never the only
signal (icon + word for every level), focus order follows reading order, the modal traps focus and
Block is focused when ready (existing behaviour), hit targets ≥ 36×36 (44 preferred), `lang` set,
live regions only where they already exist.

## 8. Acceptance (designer must show all in worker_done)
- Screenshots before/after at 360, 375 and 1280 px: report L0, L1, L2, L3, L4, blocked; with engine
  and AI-selected intent; poisoning comparison open; popup ready/setup/activity; options with AI
  section collapsed and expanded; playground connected/disconnected.
- A contrast table for every text/background token pair used.
- No 9-10 px text anywhere (`rg "font-size:(9|10)px"` empty); one token block; report.html inline
  style removed or reduced to tokens-only references.
- Zip file list unchanged apart from changed assets; no new hosts, permissions, dependencies.
- Extension unit tests, typecheck, eslint, build, release, `selfcheck --only G10`, `--fast` G1-G4 PASS.
- Token-drift check between extension and playground passes.
