import { assessmentCard } from "./intent.js";
import { orbButton } from "./orb.js";
import { withTokens } from "./tokens.js";
import { messageReview } from "./message.js";
// The report page inside the extension iframe (report.html). Receives the verdict from
// the bridge with the per-report secret and a MessagePort, renders it as text only, and
// answers { allow } on the port. Contract for G7: test-dapp/e2e/README.md.
import { fallbackExplanation, readExplanation, type Explanation } from "../shared/explanation.js";
import { isId, SW_EXPLAIN, validateWorkerVerdict, type WorkerVerdict } from "../shared/protocol.js";
import { rankedCapabilities, type Claim, type EvidenceItem, type RawInstruction, type ReportView } from "../shared/report-view.js";
import { buttonsFor, HoldGesture, IntentFlow, LEVEL_NAMES, reportMode, statusLine, VisibilityGate } from "./model.js";

type Kids = (Node | string | null | false)[];
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kids): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k !== null && k !== false) e.append(k);
  return e;
}

/** Full value stays in the DOM text; CSS shows it middle-truncated (head ellipsis, fixed tail). */
function addr(value: string): HTMLElement {
  if (value.length <= 14 || /\s/.test(value)) return el("code", {}, value);
  return el("code", { class: "addr", title: value }, el("span", { class: "addr-head" }, value.slice(0, -6)), el("span", { class: "addr-tail" }, value.slice(-6)));
}

/** Site and network as pills; part of the header's wrapping pill row. */
function contextPills(r: ReportView | null): HTMLElement[] {
  if (!r) return [];
  return [
    r.origin ? el("span", { "data-kelvara-origin": "", "data-kelvara-trusted": String(!!r.trustedSite), ...(r.impostor ? { "data-kelvara-impostor": "true" } : {}), role: "note", "aria-label": r.impostor ? `Impostor of ${r.impostor.name}` : r.trustedSite ? `Trusted site: ${r.trustedSite}` : "Not on the trusted list", title: r.origin }, r.origin) : null,
    r.network ? el("span", { "data-kelvara-network": "", class: `net-${r.network}` }, r.network) : null
  ].filter((x): x is HTMLElement => !!x);
}

function section(title: string, ...kids: Kids): HTMLElement {
  return el("section", {}, el("h2", {}, title), ...kids);
}

/** Evidence explorer row: where the evidence sits in the request and what was decoded or read. */
function evidenceCard(e: EvidenceItem): HTMLElement {
  const rows: [string, string][] = [];
  if (e.tx !== null) rows.push(["Transaction", String(e.tx)]); // 0-based, as in the engine's statements
  if (e.path !== null) rows.push(["Instruction path", e.path]);
  if (e.address !== null) rows.push(["Address", e.address]);
  if (e.idl !== null) rows.push(["IDL", e.idl]);
  const label = e.type === "instruction" ? "Decoded arguments and accounts" : e.type === "account" ? "Account snapshot" : "Data";
  return el(
    "details",
    { class: "evidence", "data-evidence": e.id, "data-evidence-type": e.type },
    el("summary", {}, el("code", {}, e.id), ` ${e.type} from ${e.source}: ${e.summary}`),
    rows.length ? el("dl", { class: "where" }, ...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, el("code", {}, v))])) : null,
    e.fields.length
      ? el("div", { class: "fields" }, el("h3", {}, label), el("dl", {}, ...e.fields.flatMap((f) => [el("dt", {}, f.key), el("dd", {}, el("code", {}, f.value))])))
      : null
  );
}

function claimCard(c: Claim, evidence: Map<string, EvidenceItem>, tokens?: ReportView["tokens"]): HTMLElement {
  const items = c.evidenceIds.map((id) => evidence.get(id)).filter((e): e is EvidenceItem => !!e);
  const card = el(
    "details",
    { class: "claim", "data-claim": c.id, "data-claim-kind": c.kind.toLowerCase() },
    c.rule?.startsWith("fact.")
      ? el("summary", {}, el("strong", { class: "claim-title" }, c.title))
      : el("summary", {}, el("span", { class: `kind kind-${c.kind}` }, c.kind), c.level ? el("span", { class: "claim-level", "data-lv": c.level.slice(1) }, c.level) : null, " ", el("strong", { class: "claim-title" }, c.title)),
    el("p", { class: "claim-text" }, ...withTokens(c.text, tokens)),
    c.advice ? el("p", { class: "advice" }, c.advice) : null,
    items.length ? el("div", { class: "explorer" }, ...items.map(evidenceCard)) : el("p", { class: "muted" }, "No evidence attached."),
    c.moreEvidence ? el("p", { class: "muted" }, `and ${c.moreEvidence} more evidence item${c.moreEvidence === 1 ? "" : "s"}`) : null,
    el("p", { class: "muted" }, el("code", {}, c.rule ? `${c.id} · ${c.rule}` : c.id))
  );
  if (c.rule) card.setAttribute("data-rule", c.rule);
  return card;
}

/** "Ledger hash  7vde…x8T": a quiet line; the full value stays in the DOM text, the title and the accessible name. */
export function hashLine(hashes: string[]): HTMLElement {
  return el(
    "p",
    { class: "ledger-hash" },
    el("span", { class: "ledger-label" }, hashes.length > 1 ? "Ledger hashes" : "Ledger hash"),
    ...hashes.map((h) => el("code", { class: "addr", title: h, "aria-label": `Ledger hash ${h}`, "data-kelvara-hash": "" }, el("span", { class: "addr-head" }, h.slice(0, -4)), el("span", { class: "addr-tail" }, h.slice(-4))))
  );
}

/** "setComputeUnitLimit" -> "Set compute unit limit"; "microLamports" -> "Micro lamports". */
const humanName = (n: string): string => { const w = n.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim(); return w.charAt(0).toUpperCase() + w.slice(1); };

/** Instructions in request order: "System Program · transfer", with the decoded arguments and accounts. */
function instructionList(r: ReportView): HTMLElement | null {
  const unreadable = r.routedBy ? `Third-party program, routed by ${r.routedBy}` : "Unreadable instruction";
  const list = r.details?.instructions ?? [];
  if (!list.length) return null;
  const multi = r.messageHashes.length > 1;
  const line = (i: (typeof list)[number]) =>
    el(
      "li",
      { class: i.name ? "ix" : "ix ix-unknown", "data-ix": `${i.tx}:${i.path}` },
      el("div", { class: "ix-head" }, el("span", { class: "ix-program" }, i.program), el("strong", { class: "ix-name" }, i.name ? humanName(i.name) : unreadable), i.programId ? orbButton(i.programId, i.program) : null, i.raw ? copyRawButton(i.raw) : null),
      i.args.length || i.accounts.length
        ? el("dl", { class: "ix-args" }, ...[...i.args, ...i.accounts].flatMap((f) => [el("dt", {}, humanName(f.key)), el("dd", {}, ...(/^\d+$/.test(f.value) ? [Number(f.value).toLocaleString("en-US")] : r.tokens?.some((t) => f.value.includes(t.label)) ? withTokens(f.value, r.tokens, document, false) : [addr(f.value)]))]))
        : null
    );
  const cb = multi ? [] : list.filter((i) => /compute budget/i.test(i.program) && i.name && /^set(ComputeUnit|LoadedAccounts)/.test(i.name));
  const bar = cb.length ? computeBar(r, cb, line) : null;
  const rest = bar ? list.filter((i) => !cb.includes(i)) : list;
  const main = rest.length ? section("Instructions", el("ol", { class: "instructions" }, ...rest.map(line))) : null;
  if (!multi) return bar ? el("div", { class: "ix-group" }, bar, ...(main ? [main] : [])) : main;
  const txs = [...new Set(list.map((i) => i.tx))];
  return section("Instructions", ...txs.flatMap((t) => [el("h3", {}, `Transaction ${t + 1}`), el("ol", { class: "instructions" }, ...list.filter((i) => i.tx === t).map(line))]));
}

const num = (v: string | undefined): number | null => (v !== undefined && /^[\d,]+$/.test(v) ? Number(v.replace(/,/g, "")) : null);
const sol = (s: string | undefined): number | null => (s !== undefined && /^\d+(\.\d+)?$/.test(s) ? Number(s) : null);

/** One compact "Compute & fees" block instead of one card per Compute Budget instruction. Shows only values the report carries. */
function computeBar(r: ReportView, cb: NonNullable<ReportView["details"]>["instructions"], line: (i: NonNullable<ReportView["details"]>["instructions"][number]) => HTMLElement): HTMLElement {
  const arg = (key: string) => cb.flatMap((i) => i.args).find((a) => a.key === key)?.value;
  const limit = num(arg("units"));
  const price = num(arg("microLamports"));
  const consumed = r.evidence.flatMap((e) => e.fields).map((f) => (/^units_?consumed$/i.test(f.key) ? num(f.value) : null)).find((x) => x !== null) ?? null;
  const feeLine = [...(r.details?.balances ?? []), ...(r.authorizes?.split("\n") ?? [])].find((l) => /^Fees\b/.test(l)) ?? "";
  const net = sol(/([\d.]+) SOL network/.exec(feeLine)?.[1]);
  const prio = sol(/up to ([\d.]+) SOL priority/.exec(feeLine)?.[1]);
  const lamports = (v: number) => `${Math.round(v * 1e9).toLocaleString("en-US")} lamports`;
  const fmt = (v: number) => `${v.toLocaleString("en-US", { maximumFractionDigits: 9 })} SOL`;
  const rows: HTMLElement[] = [];
  if (limit !== null) {
    const pct = consumed !== null && limit > 0 ? Math.min(100, (consumed / limit) * 100) : 0;
    const max = `${limit.toLocaleString("en-US")} CU`;
    rows.push(
      el(
        "div",
        { class: "cf-row", "data-compute": "units" },
        el("div", { class: "cf-line" }, el("span", { class: "cf-label" }, "Compute units"), el("span", { class: "cf-value", title: consumed !== null ? `${consumed.toLocaleString("en-US")} used of ${limit.toLocaleString("en-US")} requested` : `${limit.toLocaleString("en-US")} requested, usage not simulated` }, consumed !== null ? `${consumed.toLocaleString("en-US")} used` : "Usage not simulated")),
        el("div", { class: "cf-bar cf-units", role: "img", "aria-label": consumed !== null ? `${consumed.toLocaleString("en-US")} of ${max} used` : `Limit ${max}, usage not simulated` }, el("i", { style: `width:${pct.toFixed(1)}%` })),
        el("div", { class: "cf-ends", "aria-hidden": "true" }, el("span", {}, "0"), el("span", {}, max))
      )
    );
  }
  if (net !== null || prio !== null || price !== null) {
    const total = (net ?? 0) + (prio ?? 0);
    const share = total > 0 ? ((net ?? 0) / total) * 100 : 100;
    rows.push(
      el(
        "div",
        { class: "cf-row", "data-compute": "fees" },
        el("div", { class: "cf-line" }, el("span", { class: "cf-label" }, "Fees"), el("span", { class: "cf-value", title: total > 0 ? `${lamports(net ?? 0)} network + up to ${lamports(prio ?? 0)} priority` : "" }, total > 0 ? `${prio ? "Up to " : ""}${fmt(total)}` : "No priority fee")),
        total > 0 ? el("div", { class: "cf-bar cf-split", "aria-hidden": "true" }, el("i", { class: "cf-net", style: `width:${share.toFixed(1)}%` }), el("i", { class: "cf-prio" })) : null,
        el(
          "div",
          { class: "cf-legend" },
          net !== null ? el("span", { class: "cf-key cf-net-key", title: lamports(net) }, `Network ${fmt(net)}`) : null,
          prio !== null ? el("span", { class: "cf-key cf-prio-key", title: `up to ${lamports(prio)}` }, `Priority up to ${fmt(prio)}`) : null,
          price !== null ? el("span", { class: "cf-price" }, `${price.toLocaleString("en-US")} micro-lamports per CU`) : null
        )
      )
    );
  }
  return section("Compute & fees", el("div", { class: "compute-bar", "data-compute-bar": "" }, ...rows), el("details", { class: "compute-raw" }, el("summary", {}, "Show instructions"), el("ol", { class: "instructions" }, ...cb.map(line))));
}

/** Small "Copy raw" button: copies the instruction as JSON on click only. Not a decision control. */
export function copyRawButton(raw: RawInstruction, clipboard: () => Pick<Clipboard, "writeText"> | undefined = () => navigator.clipboard): HTMLButtonElement {
  const b = el("button", { type: "button", class: "copy-raw", "data-copy-raw": `${raw.transaction}:${raw.index}`, "aria-label": "Copy raw instruction as JSON", title: "Copy raw instruction as JSON" }, "Copy raw");
  let timer: ReturnType<typeof setTimeout> | undefined;
  b.addEventListener("click", () => {
    void Promise.resolve(clipboard()?.writeText(JSON.stringify(raw, null, 2))).then(
      () => {
        b.textContent = "Copied";
        b.setAttribute("data-copied", "true");
        clearTimeout(timer);
        timer = setTimeout(() => { b.textContent = "Copy raw"; b.setAttribute("data-copied", "false"); }, 2000);
      },
      () => { b.textContent = "Copy failed"; }
    );
  });
  return b;
}

/** "You send · −23.18 USDC": who/what split, coloured by direction. */
function balanceRow(b: string, tokens: ReportView["tokens"]): HTMLElement {
  const [who, ...rest] = b.split(" · ");
  const what = rest.join(" · ");
  const dir = /^You send/.test(b) || what.startsWith("−") ? "out" : /^You receive/.test(b) || what.startsWith("+") ? "in" : "state";
  return el("li", { "data-balance": "", class: dir }, el("span", { class: "who" }, who ?? b), el("span", { class: "what" }, ...withTokens(what, tokens)));
}

/** "Key risks": one plain sentence per alert claim, at most three, first on page 2 for L2 to L4. */
function keyRisksBlock(r: ReportView): HTMLElement {
  return el(
    "section",
    { class: "key-risks", "data-key-risks": "" },
    el("h2", {}, "Key risks"),
    el("ul", {}, ...(r.keyRisks ?? []).map((k) => el("li", { "data-key-risk": k.id }, el("strong", {}, k.headline), " ", el("span", { class: "key-risk-text" }, ...withTokens(k.text, r.tokens)))))
  );
}

/** Step 2: simulation, instructions, new states, capability changes, claims with evidence, Ledger hash. */
export function detailsStep(v: WorkerVerdict, r: ReportView | null): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (!r) return [el("p", { class: "summary" }, v.reason)];
  if (r.message) return [messageReview(r.message)];
  const risky = v.level !== null && v.level >= 2;
  if (risky && r.keyRisks?.length) out.push(keyRisksBlock(r));
  if (r.simulation !== null || r.authorizes !== null) {
    out.push(
      el(
        "section",
        { class: "versus" },
        r.authorizes !== null ? el("div", { class: "authorize" }, el("h2", {}, risky ? "What changes" : "What you actually authorize"), r.authorizes.includes("\n") ? el("ul", { class: "authorize-list" }, ...r.authorizes.split("\n").filter(Boolean).map((line) => el("li", {}, ...withTokens(line, r.tokens)))) : el("p", {}, ...withTokens(r.authorizes, r.tokens))) : null,
        el(
          "div",
          { class: "simulation" },
          el("h2", {}, "What simulation shows"),
          r.details?.balances?.length
            ? el("ul", { class: "balances" }, ...r.details.balances.map((b) => balanceRow(b, r.tokens)))
            : el("p", {}, r.simulation ?? "Not simulated"),
          r.details?.other?.length ? el("details", { class: "other-accounts", "data-other-accounts": "" }, el("summary", {}, `Other accounts (${r.details.other.length})`), el("ul", { class: "balances" }, ...r.details.other.map((b) => balanceRow(b, r.tokens)))) : null
        )
      )
    );
  }
  const ix = instructionList(r);
  if (ix) out.push(risky ? el("details", { class: "collapsed-instructions", "data-collapsed": "instructions" }, el("summary", {}, `Show ${r.details?.instructions.length ?? 0} instruction${r.details?.instructions.length === 1 ? "" : "s"}`), ix) : ix);
  const changes = r.details?.changes ?? [];
  // One "what changes" list: the authorize lines already hold grants and revokes first, then the facts, fees last.
  if (r.authorizes === null && changes.length) out.push(section("What changes", el("ul", { class: "changes" }, ...changes.map((c) => el("li", {}, ...withTokens(c, r.tokens))))));
  const caps = r.limited ? rankedCapabilities(r) : [];
  if (caps.length) {
    out.push(
      section(
        r.limited ? "Top finding" : "Permission changes, most dangerous first",
        el("ol", { class: "caps" }, ...caps.map((c) => el("li", { "data-risk": c.risk }, el("span", { class: "risk" }, c.risk), ` ${c.change === "granted" ? "Grants" : "Revokes"} `, ...withTokens(c.authority, r.tokens), " → ", ...(r.tokens?.some((t) => c.holder.includes(t.label)) ? withTokens(c.holder, r.tokens) : [addr(c.holder)]))))
      )
    );
  }
  for (const p of r.preview) {
    out.push(
      section(
        `What ${p.authority} can do`,
        el("p", { class: "muted" }, `Confidence: ${p.confidence}`),
        p.can.length ? el("ol", { class: "preview-list" }, ...p.can.map((a) => el("li", {}, el("strong", {}, a.name), a.detail ? ` · ${a.detail}` : ""))) : el("p", {}, "Unknown: not shown as harmless.")
      )
    );
  }
  if (r.claims.length) {
    const byId = new Map(r.evidence.map((e) => [e.id, e]));
    // Facts ("What this transaction does") come first on L0/L1 and after the risk findings on L2+.
    const isFact = (c: Claim) => c.kind === "Fact" && !!c.rule?.startsWith("fact.");
    const facts = r.claims.filter(isFact);
    const risks = r.claims.filter((c) => !isFact(c));
    const factSection = facts.length ? section("What this transaction does", ...facts.map((c) => claimCard(c, byId, r.tokens))) : null;
    const riskSection = risks.length ? section(r.limited ? "Top finding" : "Findings (open for evidence)", ...risks.map((c) => claimCard(c, byId, r.tokens))) : null;
    const first = v.level !== null && v.level <= 1;
    const sections = [first ? factSection : riskSection, first ? riskSection : factSection].filter((x): x is HTMLElement => !!x);
    if (risky && !r.limited) out.push(el("details", { class: "all-findings", "data-collapsed": "findings" }, el("summary", {}, `Show all findings (${r.claims.length})`), ...sections));
    else out.push(...sections);
  }
  return out;
}

const BUILT_IN_PROGRAMS = new Set(["11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "MemoSq4gqABAXKb96qnH8TyPvNuhpXdvZqgexAcCRwL", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo", "BPFLoaderUpgradeab1e11111111111111111111111", "AddressLookupTab1e1111111111111111111111111"]);
/** First named instruction whose program is not a built-in: the program the title is about. */
function primaryProgram(r: ReportView | null): { id: string; name: string } | null {
  const i = r?.details?.instructions.find((x) => x.name && x.programId && !BUILT_IN_PROGRAMS.has(x.programId));
  return i?.programId ? { id: i.programId, name: i.program } : null;
}

function titleOrb(r: ReportView | null): HTMLElement | null {
  const p = primaryProgram(r);
  return p ? orbButton(p.id, p.name) : null;
}

/** The header: title, level, site and network as rounded pills in one wrapping row. */
export function levelHeader(v: WorkerVerdict, r: ReportView | null): HTMLElement[] {
  const title = r?.title ?? v.reason;
  const level = v.level;
  const pills = contextPills(r);
  if (level === 0) {
    const calm = !/^Can't fully verify/.test(title);
    const [lead, rest] = /^No risks found/.test(title) ? ["No risks found", title.replace(/^No risks found\s*[·:]?\s*/, "").trim()] : (() => { const [a, ...b] = title.split(" · "); return [a ?? title, b.join(" · ")]; })();
    return [
      el(
        "section",
        { class: calm ? "calm-head report-head" : "calm-head unverified report-head" },
        el("span", { class: "level-icon", "aria-hidden": "true" }),
        el("h1", { id: "title", class: "pill title-pill" }, el("strong", {}, lead), rest ? el("span", { class: "headline" }, " ", ...withTokens(rest, r?.tokens)) : null),
        el("span", { class: "level-chip pill", "data-kelvara-level": "L0", title: "Alert level L0" }, "L0"),
        ...pills,
        titleOrb(r)
      )
    ];
  }
  if (level === 1) {
    const rest = title.replace(/^Notice\s*[·:]\s*/, "").trim();
    return [
      el(
        "section",
        { class: "notice-line report-head" },
        el("span", { class: "level-icon", "aria-hidden": "true" }),
        el("h1", { id: "title", class: "pill title-pill" }, ...withTokens(rest || title, r?.tokens)),
        el("span", { class: "level-chip pill", "data-kelvara-level": "L1" }, `L1 · ${LEVEL_NAMES[1]}`),
        ...pills,
        titleOrb(r)
      )
    ];
  }
  const badge = el("span", { class: "level pill" }, level === null ? "Blocked · analysis unavailable" : `L${level} · ${LEVEL_NAMES[level]}`);
  if (level !== null) badge.setAttribute("data-kelvara-level", `L${level}`);
  return [el("section", { class: "risk-banner report-head" }, el("span", { class: "level-icon", "aria-hidden": "true" }), el("h1", { id: "title", class: "pill title-pill", ...(r?.fullTitle ? { title: r.fullTitle } : {}) }, ...withTokens(title, r?.tokens)), badge, ...(r?.moreRisks ? [el("span", { class: "more-risks", "data-more-risks": String(r.moreRisks), title: r.fullTitle ?? "" }, `+${r.moreRisks} more risk${r.moreRisks === 1 ? "" : "s"}`)] : []), ...pills, titleOrb(r))];
}

/** What the assessment card shows when the worker has no explanation: the report's own one-line summary. */
const localExplanation = (v: WorkerVerdict, r: ReportView | null): Explanation => (r ? fallbackExplanation(r) : { source: "signguard", sentences: [{ text: v.reason, claimIds: [] }] });
const EXPLAIN_WAIT_MS = 6000;

function render(v: WorkerVerdict, deadline: number, answer: (allow: boolean) => void, explain: (() => Promise<unknown>) | null): void {
  const mode = reportMode(v);
  const r = v.report;
  const b = buttonsFor(v);
  const card = el("main", { role: "alertdialog", "aria-labelledby": "title", class: `card mode-${mode}` });
  if (b.modal) card.setAttribute("data-kelvara-modal", "");
  if (r?.limited) card.setAttribute("data-kelvara-limited", "");
  card.setAttribute("aria-modal", "true");
  document.documentElement.dataset.level = v.level === null ? "blocked" : `L${v.level}`;
  const status = el("p", { class: "status", role: "status" });
  const secondsLeft = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  status.textContent = statusLine(v, secondsLeft());
  card.append(el("header", {}, el("div", { class: "brand" }, el("img", { class: "brand-mark", src: "mark.svg", alt: "" }), el("span", { class: "brand-lockup" }, el("span", { class: "brand-word" }, "Clear", el("span", {}, "Sign")), el("span", { class: "brand-by" }, "by Kelvara")))), ...levelHeader(v, r));

  let answered = false;
  let sign: HTMLButtonElement | null = null;
  const block = el("button", { type: "button", class: "block", "data-kelvara-action": "block" }, b.block);
  const done = (allow: boolean) => {
    if (answered) return;
    answered = true;
    flow.close();
    block.disabled = true;
    if (sign) sign.disabled = true;
    if (assessment) assessment.confirm.disabled = assessment.reject.disabled = true;
    status.textContent = allow ? "Sending to your wallet…" : mode === "hold" ? "Blocked." : "Closed.";
    answer(allow);
  };
  block.addEventListener("click", () => done(false));

  // Hold mode is two steps: confirm the intent first, then the review details and the decision controls.
  const stepped = mode === "hold" && !!r;
  const assessment = stepped ? assessmentCard(r!.message ? undefined : r!.intent, v.level, r!.message ? "Did you intend to sign this message?" : undefined, r!.tokens) : null;
  const details = el("div", { class: "review-details", "data-report-step": "details" }, ...detailsStep(v, r));
  const footer = el("footer", { class: "decision" }, status, mode === "hold" ? el("div", { class: "countdown", "aria-hidden": "true", style: `--total:${secondsLeft()}s` }, el("i")) : null, block);
  if (assessment) {
    card.setAttribute("data-report-current", "intent");
    details.hidden = true;
    const keyBlock = details.querySelector("[data-key-risks]");
    if (keyBlock) keyBlock.after(assessment.explanation);
    else details.prepend(assessment.explanation);
    card.append(assessment.node, details);
  } else {
    card.setAttribute("data-report-current", "details");
    card.append(...(r ? [el("p", { class: "summary" }, ...withTokens(r.summary, r.tokens))] : []), details);
  }

  const flow = new IntentFlow();
  const syncChoices = () => {
    if (!assessment || answered) return;
    assessment.reject.disabled = !flow.canReject;
    assessment.confirm.disabled = !flow.canConfirm;
  };
  if (assessment) {
    const local = localExplanation(v, r);
    let explainedOnce = false;
    const settle = (e: Explanation) => {
      if (explainedOnce) return;
      explainedOnce = true;
      flow.setExplained();
      assessment.show(e);
      syncChoices();
    };
    syncChoices();
    if (explain && r && !r.message) {
      // Never wait on the provider longer than its own timeout: show ClearSign's text and enable the choices.
      const safety = setTimeout(() => settle(local), EXPLAIN_WAIT_MS);
      explain().then((x) => settle(readExplanation(x) ?? local), () => settle(local)).finally(() => clearTimeout(safety));
    } else {
      settle(r?.message ? { source: "signguard", sentences: [{ text: r.summary, claimIds: [] }] } : local);
    }
    assessment.reject.addEventListener("click", () => done(false));
    assessment.confirm.addEventListener("click", (e) => {
      if (answered || !flow.confirm(e.isTrusted)) return;
      card.setAttribute("data-report-current", "details");
      assessment.node.hidden = true;
      details.hidden = false;
      mountSign();
      card.scrollTop = 0;
      block.focus({ preventScroll: true });
    });
  }

  function mountSign(): void {
    if (!b.signAnyway) return;
    const holdMs = b.signAnyway.holdMs;
    const harmless = v.level === 0 || v.level === 1;
    const label = harmless ? "Continue to wallet" : holdMs ? `Hold ${holdMs / 1000} s to sign anyway` : "Sign anyway";
    const s = el("button", { type: "button", class: "sign", "data-kelvara-action": harmless ? "continue" : "sign-anyway", "data-armed": "false" }, label);
    sign = s;
    if (holdMs) s.setAttribute("data-hold-ms", String(holdMs));
    footer.append(s);
    const hint = el("p", { class: "hint", "aria-live": "polite" });
    footer.append(hint);

    // Anti-clickjacking: Sign anyway works only while nothing covers or fades the report.
    const gate = new VisibilityGate();
    // Not aria-disabled/opacity: IntersectionObserver v2 counts an element's own opacity as hidden.
    const setEnabled = () => s.setAttribute("data-armed", String(gate.open(performance.now())));
    try {
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) gate.update((e as IntersectionObserverEntry & { isVisible?: boolean }).isVisible, performance.now());
          if (!gate.open(performance.now())) gesture?.cancel();
          setEnabled();
        },
        { threshold: [1], trackVisibility: true, delay: 100 } as IntersectionObserverInit
      );
      io.observe(s);
    } catch {
      /* no IntersectionObserver v2: the gate never opens, Sign anyway never works */
    }
    const tick = setInterval(setEnabled, 100);
    window.addEventListener("pagehide", () => clearInterval(tick));
    const blockedHint = () => (hint.textContent = `${harmless ? "Continue to wallet" : "Sign anyway"} is off while the report is covered, faded or just opened.`);

    let gesture: HoldGesture | null = null;
    if (holdMs) {
      const g = new HoldGesture(holdMs);
      gesture = g;
      let raf = 0;
      const reset = () => {
        g.cancel();
        cancelAnimationFrame(raf);
        s.style.setProperty("--progress", "0");
        if (!answered) s.textContent = label;
      };
      const frameTick = () => {
        const now = performance.now();
        if (!g.pressing) return;
        if (!gate.open(now)) return reset();
        s.style.setProperty("--progress", String(g.progress(now)));
        if (g.done(now)) return done(true);
        raf = requestAnimationFrame(frameTick);
      };
      const press = () => {
        if (answered) return;
        if (!gate.open(performance.now())) return void blockedHint();
        if (g.pressing) return;
        g.press(performance.now());
        s.textContent = "Keep holding…";
        raf = requestAnimationFrame(frameTick);
      };
      s.addEventListener("pointerdown", (e) => {
        if (e.isTrusted && e.button === 0) press();
      });
      for (const ev of ["pointerup", "pointerleave", "pointercancel", "blur"]) s.addEventListener(ev, reset);
      window.addEventListener("blur", reset);
      s.addEventListener("keydown", (e) => {
        if (!e.isTrusted || (e.key !== " " && e.key !== "Enter")) return;
        e.preventDefault();
        if (!e.repeat) press();
      });
      s.addEventListener("keyup", (e) => {
        if (e.key === " " || e.key === "Enter") reset();
      });
      // A plain click is not a deliberate second step.
      s.addEventListener("click", (e) => e.preventDefault());
    } else {
      s.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        if (!gate.open(performance.now())) return void blockedHint();
        done(true);
      });
    }
  }

  if (!assessment) mountSign();
  card.append(footer);
  document.body.replaceChildren(card);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") done(false);
    if (e.key === "Tab") {
      const focusable = Array.from(card.querySelectorAll<HTMLElement>('button:not(:disabled), summary, [tabindex="0"]')).filter(node => node.getClientRects().length > 0);
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      if (focusable.length && (index < 0 || (e.shiftKey ? index === 0 : index === focusable.length - 1))) {
        e.preventDefault();
        focusable[e.shiftKey ? focusable.length - 1 : 0]!.focus();
      }
    }
  });
  // A newly attached cross-origin iframe can have layout before its compositor hit-test
  // region exists. Keep decisions inert until intersection delivery and a painted frame.
  block.disabled = true;
  if (sign) (sign as HTMLButtonElement).disabled = true;
  let warming = false;
  const ready = new IntersectionObserver((entries) => {
    if (warming || !entries.some((e) => e.isIntersecting)) return;
    warming = true;
    ready.disconnect();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (answered) return;
      block.disabled = false;
      if (sign) (sign as HTMLButtonElement).disabled = false;
      flow.setWarmed();
      syncChoices();
      block.focus({ preventScroll: true });
    }));
  });
  ready.observe(card);

  if (mode === "hold") {
    const t = setInterval(() => {
      if (answered) return clearInterval(t);
      status.textContent = statusLine(v, secondsLeft());
    }, 1000);
  }
}

export function mountReport(): void {
  const secret = location.hash.slice(1);
  window.addEventListener("message", function receive(event: MessageEvent<unknown>) {
    if (event.source !== parent || !event.data || typeof event.data !== "object") return;
    const data = event.data as Record<string, unknown>;
    const port = event.ports[0];
    if (!secret || data.secret !== secret || !port) return;
    window.removeEventListener("message", receive);
    const verdict = validateWorkerVerdict(data.verdict);
    const deadline = typeof data.deadline === "number" && Number.isFinite(data.deadline) ? data.deadline : Date.now();
    if (!verdict) {
      port.postMessage({ allow: false });
      return;
    }
    const id = isId(data.id) ? data.id : null;
    try {
      render(verdict, deadline, (allow) => port.postMessage({ allow }), id ? () => chrome.runtime.sendMessage({ type: SW_EXPLAIN, id, secret }) : null);
    } catch {
      port.postMessage({ allow: false });
    }
  });
}
