import type { ReportIntent } from "../intent/selection.js";
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.textContent = text;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
/** Render only validated engine text. Corrections never mutate the report or authorize anything. */
export function intentCard(intent: ReportIntent, onBlock?: () => void): HTMLElement {
  const { context } = intent;
  const selected = context.candidates.find(c => c.id === intent.selectedId)!;
  const card = node("section", "", { class: "intent-card", "data-kelvara-intent": "", "data-intent-status": intent.status });
  card.append(node("p", intent.source === "ai" ? "AI-selected · engine-authored question" : "Engine template", { class: "eyebrow", "data-intent-source": intent.source }));
  card.append(node("h2", selected.question, { "data-intent-question": selected.id }));
  const reasons = node("ul");
  for (const id of intent.reasonIds) {
    const reason = selected.reasons.find(r => r.id === id)!;
    reasons.append(node("li", reason.text, { "data-intent-reason": id }));
  }
  card.append(reasons, node("p", context.historyNote, { class: "muted", "data-intent-history": "" }));
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
  const correction = node("details", "", { "data-intent-correction": "" });
  correction.append(node("summary", "That's not my intent"), node("p", "Choosing an intent does not change this transaction, its risk level or its signing controls. Cancel / Block below and ask the site for corrected bytes if these effects are wrong."));
  const feedback = node("p", "", { role: "status", "data-intent-feedback": "" });
  const choices = ["I expected a transfer", "I expected a fee change", "I did not expect an authority change", "I need more information"];
  choices.forEach((text, index) => {
    const button = node("button", text, { type: "button", class: "chip", "data-intent-choice": String(index) });
    button.addEventListener("click", () => { feedback.textContent = `${text}. This transaction has not changed. Use Cancel / Block below; a changed transaction requires a fresh report.`; });
    correction.append(button);
  });
  correction.append(feedback);
  if (onBlock) {
    const cancel = node("button", "Cancel / Block this request", { type: "button", "data-intent-cancel": "" });
    cancel.addEventListener("click", onBlock);
    correction.append(cancel);
  }
  card.append(correction);
  return card;
}
