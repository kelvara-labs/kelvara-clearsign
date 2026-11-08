// Message-review view for the report frame (signMessage / signIn). Text only, no HTML.
// Stable hooks for tests and styling: data-kelvara-message-review, data-message-kind,
// data-message-field="<name>", data-message-rule="<rule id>".
import { MESSAGE_KINDS, type MessageReview } from "../shared/message-view.js";

const KIND_LABELS: Record<(typeof MESSAGE_KINDS)[number], string> = {
  siws: "Sign-In With Solana",
  text: "Plain text message",
  binary: "Binary message",
  "hidden-tx": "Transaction hidden in a message"
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string>, ...kids: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k !== null) e.append(k);
  return e;
}

export function messageReview(m: MessageReview): HTMLElement {
  const root = el("section", { class: "message-review", "data-kelvara-message-review": "", "data-message-kind": m.kind, "data-message-rule": m.rule });
  root.append(
    el("h2", {}, KIND_LABELS[m.kind]),
    el("p", { class: "muted", "data-message-field": "origin" }, `Requested by ${m.origin}`)
  );
  root.append(
    el("ul", { class: "message-findings" }, ...m.findings.map((f) => el("li", { "data-message-rule": f.rule, "data-message-level": `L${f.level}` }, el("span", { class: "claim-level" }, `L${f.level}`), ` ${f.text}`)))
  );
  if (m.fields.length) {
    root.append(el("dl", { class: "where message-fields" }, ...m.fields.flatMap((f) => [el("dt", {}, f.name), el("dd", { "data-message-field": f.name }, el("pre", { class: "message-value" }, f.value))])));
  }
  if (m.text !== null) {
    root.append(
      el("h3", {}, "Full message text"),
      el("pre", { class: "message-text", "data-message-field": "text" }, m.text)
    );
    if (m.truncated) root.append(el("p", { class: "muted", "data-message-field": "truncated" }, "The message is longer than shown here."));
  } else {
    root.append(el("p", { class: "muted", "data-message-field": "size" }, `${m.size} bytes. The content is not shown.`));
  }
  return root;
}
