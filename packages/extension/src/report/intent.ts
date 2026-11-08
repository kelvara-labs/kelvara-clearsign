import type { Explanation } from "../shared/explanation.js";
import type { TokenRef } from "../shared/report-view.js";
import { withTokens } from "./tokens.js";
import type { ReportIntent } from "../intent/selection.js";
function setRich(e: HTMLElement, text: string, tokens?: TokenRef[]): HTMLElement {
  const parts = withTokens(text, tokens);
  if (parts.length === 1 && typeof parts[0] === "string") e.textContent = parts[0];
  else e.append(...parts);
  return e;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.textContent = text;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export const CONFIRM_LABEL = "Yes, this is what I intended";
export const REJECT_LABEL = "No, reject";
export const GENERIC_QUESTION = "Is this what you intended to do?";

/** A question is shown only when there is something to confirm: a complex request or a notice level or higher. */
export function hasIntentQuestion(intent: ReportIntent | undefined, level: number | null): intent is ReportIntent {
  return !!intent && (intent.context.complex || (level ?? 0) >= 1);
}

export interface Assessment {
  node: HTMLElement;
  confirm: HTMLButtonElement;
  reject: HTMLButtonElement;
  /** Fills the page-2 Explanation section; the heading tooltip names who wrote it. */
  show(explanation: Explanation): void;
  /** Page 2 section "Explanation": filled by show(). */
  explanation: HTMLElement;
}

/**
 * Step 1 of the report: a plain-language assessment, one question and two choices. Text only. Neither choice
 * changes the transaction, its risk level or its signing controls: "Yes" only opens the review details,
 * "No" rejects the request.
 */
export function assessmentCard(intent: ReportIntent | undefined, level: number | null, question: string = GENERIC_QUESTION, tokens?: TokenRef[]): Assessment {
  const asking = hasIntentQuestion(intent, level);
  const card = node("section", "", { class: "intent-card assessment", "data-report-step": "intent", "data-intent-status": intent?.status ?? "template" });
  if (asking) card.setAttribute("data-kelvara-intent", "");
  const heading = node("h2", "Intent Assessment", { id: "assessment-title", "data-intent-source": intent?.source ?? "engine", title: "Written by ClearSign" });
  const body = node("div", "", { class: "explanation", "data-intent-explain": "" });
  const explanation = node("section", "", { class: "explanation-section", "data-report-explanation": "" });
  explanation.append(node("h2", "Explanation"), body);
  card.append(heading);

  if (asking) {
    const selected = intent.context.candidates.find((c) => c.id === intent.selectedId)!;
    const question = node("h3", "", { class: "question", "data-intent-question": selected.id });
    setRich(question, selected.question, tokens);
    card.append(question);
    const reasons = node("ul");
    for (const id of intent.reasonIds.slice(0, 1)) {
      const reason = selected.reasons.find((r) => r.id === id)!;
      reasons.append((() => { const li = node("li", "", { "data-intent-reason": id }); setRich(li, reason.text, tokens); return li; })());
    }
    card.append(reasons);
    if (selected.kind === "transfer" || selected.kind === "poisoning") card.append(node("p", intent.context.historyNote, { class: "muted", "data-intent-history": "" }));
    if (selected.comparison) {
      const compare = node("details", "", { "data-intent-compare": "", open: "" });
      compare.append(node("summary", "Compare addresses"));
      const { proposed, previous, prefix, suffix } = selected.comparison;
      for (const [label, address] of [["Proposed recipient", proposed], ["Previous recipient", previous]]) {
        compare.append(node("p", label, { class: "cmp-label" }));
        const code = node("code");
        // Mark exact matching prefix/suffix positions, while retaining full addresses as text.
        for (let i = 0; i < address!.length; i++) code.append(node(i < prefix || i >= address!.length - suffix ? "mark" : "span", address![i]!));
        compare.append(code);
      }
      compare.append(node("p", `Matching positions: first ${prefix} and last ${suffix} characters. Similarity does not prove identity.`, { class: "cmp-note" }));
      card.append(compare);
    }
  } else {
    card.append(node("h3", question, { class: "question" }));
  }

  const confirm = node("button", CONFIRM_LABEL, { type: "button", class: "choice choice-yes", "data-intent-confirm": "" });
  const reject = node("button", REJECT_LABEL, { type: "button", class: "choice choice-no", "data-intent-reject": "" });
  const actions = node("div", "", { class: "intent-actions" });
  actions.append(confirm, reject);
  card.append(actions, node("p", "Answering Yes only opens the details. It does not change the transaction or its risk level.", { class: "muted fine" }));

  return {
    node: card,
    confirm,
    reject,
    explanation,
    show(e) {
      heading.setAttribute("title", e.source === "ai" || intent?.source === "ai" ? "Written by your AI provider" : "Written by ClearSign");
      heading.setAttribute("data-explain-source", e.source);
      body.replaceChildren(...e.sentences.map((s) => {
        const text = s.text.replace(/\s*\[c\d+\]/g, "");
        const p = node("p", "", { "data-claim-ids": s.claimIds.join(",") });
        setRich(p, text, tokens);
        return p;
      }));
    }
  };
}
