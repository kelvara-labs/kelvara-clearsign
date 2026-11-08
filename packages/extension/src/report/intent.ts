import type { Explanation } from "../shared/explanation.js";
import type { ReportIntent } from "../intent/selection.js";
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
  /** Shows the explanation text; the caption names who wrote it. */
  show(explanation: Explanation): void;
}

/**
 * Step 1 of the report: a plain-language assessment, one question and two choices. Text only. Neither choice
 * changes the transaction, its risk level or its signing controls: "Yes" only opens the review details,
 * "No" rejects the request.
 */
export function assessmentCard(intent: ReportIntent | undefined, level: number | null, question: string = GENERIC_QUESTION): Assessment {
  const asking = hasIntentQuestion(intent, level);
  const card = node("section", "", { class: "intent-card assessment", "data-report-step": "intent", "data-intent-status": intent?.status ?? "template" });
  if (asking) card.setAttribute("data-kelvara-intent", "");
  const caption = node("p", "Preparing assessment…", { class: "eyebrow caption", role: "status", "data-intent-source": intent?.source ?? "engine" });
  const body = node("div", "", { class: "explanation", "data-intent-explain": "" });
  card.append(node("h2", "Assessment", { id: "assessment-title" }), caption, body);

  if (asking) {
    const selected = intent.context.candidates.find((c) => c.id === intent.selectedId)!;
    card.append(node("h3", selected.question, { class: "question", "data-intent-question": selected.id }));
    const reasons = node("ul");
    for (const id of intent.reasonIds) {
      const reason = selected.reasons.find((r) => r.id === id)!;
      reasons.append(node("li", reason.text, { "data-intent-reason": id }));
    }
    card.append(reasons, node("p", intent.context.historyNote, { class: "muted", "data-intent-history": "" }));
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
    show(explanation) {
      caption.textContent = explanation.source === "ai" || intent?.source === "ai" ? "Assessment by your AI provider" : "Assessment by ClearSign";
      caption.setAttribute("data-explain-source", explanation.source);
      body.replaceChildren(...explanation.sentences.map((s) => node("p", s.text, { "data-claim-ids": s.claimIds.join(",") })));
    }
  };
}
