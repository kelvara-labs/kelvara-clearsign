// Options "Recognized by name" list: programs with a display name from the Helius program catalog whose instructions
// ClearSign does not decode. Static data (packages/idls/labels.json); no network, no engine import.
import { LABEL_LIST, LABELS_SOURCE } from "../shared/program-labels.js";
import { shortId } from "./programs.js";

export interface LabelRow { programId: string; name: string }

export function mountLabels(root: Document = document, labels: readonly LabelRow[] = LABEL_LIST): void {
  const list = root.querySelector<HTMLElement>("#labels-list");
  if (!list) return;
  const rows = labels.map((l) => {
    const row = root.createElement("div");
    row.className = "row program-row";
    row.dataset.program = l.programId;
    const text = root.createElement("div");
    text.className = "row-text";
    const head = root.createElement("span");
    head.className = "row-title";
    head.textContent = l.name;
    const id = root.createElement("code");
    id.className = "program-id";
    id.textContent = shortId(l.programId);
    id.title = l.programId;
    id.setAttribute("aria-label", `Program id ${l.programId}`);
    head.append(" ", id);
    const desc = root.createElement("p");
    desc.className = "row-desc";
    desc.textContent = "Name from Helius catalog, not verified decoding";
    text.append(head, desc);
    row.append(text);
    return row;
  });
  list.replaceChildren(...rows);
  const note = root.querySelector<HTMLElement>("#labels-source");
  if (note) note.textContent = `${LABELS_SOURCE}. A name does not mean ClearSign can read the program's instructions or that the program is safe.`;
  const filter = root.querySelector<HTMLInputElement>("#labels-filter");
  const empty = root.querySelector<HTMLElement>("#labels-empty");
  filter?.addEventListener("input", () => {
    const q = filter.value.trim().toLowerCase();
    let shown = 0;
    labels.forEach((l, i) => {
      const hit = !q || `${l.name} ${l.programId}`.toLowerCase().includes(q);
      (rows[i] as HTMLElement).hidden = !hit;
      if (hit) shown++;
    });
    if (empty) empty.hidden = shown > 0;
  });
}
