// The report page inside the extension iframe (report.html). Receives the verdict from
// the bridge with the per-report secret and a MessagePort, renders it as text only, and
// answers { allow } on the port. Contract for G7: test-dapp/e2e/README.md.
import { validateWorkerVerdict, type WorkerVerdict } from "../shared/protocol.js";
import { rankedCapabilities, type ReportView } from "../shared/report-view.js";
import { buttonsFor, HoldGesture, LEVEL_NAMES, reportMode, statusLine, VisibilityGate } from "./model.js";

type Kids = (Node | string | null | false)[];
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kids): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k !== null && k !== false) e.append(k);
  return e;
}

function section(title: string, ...kids: Kids): HTMLElement {
  return el("section", {}, el("h2", {}, title), ...kids);
}

function renderReport(v: WorkerVerdict, r: ReportView | null): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (!r) {
    out.push(el("p", { class: "summary" }, v.reason));
    return out;
  }
  out.push(el("p", { class: "summary" }, r.summary));
  if (r.simulation !== null || r.authorizes !== null) {
    out.push(
      el(
        "section",
        { class: "versus" },
        el("div", {}, el("h2", {}, "What simulation shows"), el("p", {}, r.simulation ?? "Not simulated")),
        el("div", {}, el("h2", {}, "What you actually authorize"), el("p", {}, r.authorizes ?? "Unknown"))
      )
    );
  }
  const caps = rankedCapabilities(r);
  if (caps.length) {
    out.push(
      section(
        r.limited ? "Top finding" : "Capability changes, most dangerous first",
        el("ol", { class: "caps" }, ...caps.map((c) => el("li", { "data-risk": c.risk }, el("span", { class: "risk" }, c.risk), ` ${c.change === "granted" ? "Grants" : "Revokes"} ${c.authority} → `, el("code", {}, c.holder))))
      )
    );
  }
  for (const p of r.preview) {
    out.push(
      section(
        `What ${p.authority} can do`,
        el("p", { class: "muted" }, `Confidence: ${p.confidence}`),
        p.can.length ? el("ol", {}, ...p.can.map((a) => el("li", {}, el("strong", {}, a.name), a.detail ? ` · ${a.detail}` : ""))) : el("p", {}, "Unknown: not shown as harmless.")
      )
    );
  }
  if (r.claims.length) {
    out.push(
      section(
        r.limited ? "Top finding" : "Claims (open for evidence)",
        ...r.claims.map((c) =>
          el(
            "details",
            { class: "claim", "data-claim": c.id },
            el("summary", {}, el("span", { class: `kind kind-${c.kind}` }, c.kind), ` ${c.text}`),
            c.evidence.length ? el("ul", {}, ...c.evidence.map((e) => el("li", {}, e))) : el("p", { class: "muted" }, "No evidence attached."),
            el("p", { class: "muted" }, el("code", {}, c.id))
          )
        )
      )
    );
  }
  if (r.messageHashes.length) {
    out.push(
      section(
        r.messageHashes.length > 1 ? "Message hashes (match on your Ledger)" : "Message hash (match on your Ledger)",
        el("ol", { class: "hashes" }, ...r.messageHashes.map((h) => el("li", {}, el("code", { "data-kelvara-hash": "" }, h))))
      )
    );
  }
  return out;
}

function render(v: WorkerVerdict, deadline: number, answer: (allow: boolean) => void): void {
  const mode = reportMode(v);
  const r = v.report;
  const b = buttonsFor(v);
  const levelText = v.level === null ? "Blocked · analysis unavailable" : `L${v.level} · ${LEVEL_NAMES[v.level]}`;
  const card = el("main", { role: mode === "notice" ? "status" : "alertdialog", "aria-labelledby": "title", class: `card mode-${mode}` });
  if (b.modal) card.setAttribute("data-kelvara-modal", "");
  if (r?.limited) card.setAttribute("data-kelvara-limited", "");
  if (mode !== "notice") card.setAttribute("aria-modal", "true");
  const badge = el("span", { class: "level" }, levelText);
  if (v.level !== null) badge.setAttribute("data-kelvara-level", `L${v.level}`);
  document.documentElement.dataset.level = v.level === null ? "blocked" : `L${v.level}`;
  const status = el("p", { class: "status", role: "status" });
  const secondsLeft = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  status.textContent = statusLine(v, secondsLeft());
  card.append(el("header", {}, el("small", { class: "brand" }, "Kelvara SignGuard"), badge), el("h1", { id: "title" }, r?.title ?? v.reason));
  if (mode !== "notice") card.append(...renderReport(v, r));
  card.append(status);

  let answered = false;
  const block = el("button", { type: "button", class: "block", "data-kelvara-action": "block" }, b.block);
  const done = (allow: boolean) => {
    if (answered) return;
    answered = true;
    block.disabled = true;
    if (sign) sign.disabled = true;
    status.textContent = allow ? "Sending to your wallet…" : mode === "hold" ? "Blocked." : "Closed.";
    answer(allow);
  };
  block.addEventListener("click", () => done(false));
  let sign: HTMLButtonElement | null = null;
  const footer = el("footer", {}, block);

  if (b.signAnyway) {
    const holdMs = b.signAnyway.holdMs;
    const label = holdMs ? `Hold ${holdMs / 1000} s to sign anyway` : "Sign anyway";
    sign = el("button", { type: "button", class: "sign", "data-kelvara-action": "sign-anyway", "data-armed": "false" }, label);
    if (holdMs) sign.setAttribute("data-hold-ms", String(holdMs));
    footer.append(sign);
    const s = sign;
    const hint = el("p", { class: "hint muted", "aria-live": "polite" });
    card.append(hint);

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
    const blockedHint = () => (hint.textContent = "Sign anyway is off while the report is covered, faded or just opened.");

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
  card.append(footer);
  document.body.replaceChildren(card);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") done(false);
    if (e.key === "Tab" && sign) {
      // Keep focus inside the two buttons.
      e.preventDefault();
      (document.activeElement === block ? sign : block).focus();
    }
  });
  block.focus();

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
    render(verdict, deadline, (allow) => port.postMessage({ allow }));
  });
}
