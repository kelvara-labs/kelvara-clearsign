// Options "Programs" section: which programs ClearSign decodes in detail. Static data generated from the bundled
// registry (scripts/gen-programs.mjs); no network, no settings access, no engine import.
import { orbButton } from "../report/orb.js";
import { TRUSTED_SITES, type TrustedSite } from "../sw/trusted-sites.js";
import data from "./programs-data.json";

export interface ProgramRow {
  name: string;
  title: string;
  programId: string;
  kind: string;
  understands: string[];
  source: string;
  verification: string;
  detail: string;
}

export const PROGRAMS = data as ProgramRow[];

export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);
const understandsText = (p: ProgramRow) => (p.understands.length ? p.understands.join(", ") : "Instruction names only");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function cell(doc: Document, tag: string, className: string, text: string): HTMLElement {
  const e = doc.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}

export function renderRow(p: ProgramRow, doc: Document = document): HTMLElement {
  const row = doc.createElement("div");
  row.className = "row program-row";
  row.dataset.program = p.name;
  const text = doc.createElement("div");
  text.className = "row-text";
  const head = doc.createElement("span");
  head.className = "row-title";
  head.textContent = p.title;
  const id = cell(doc, "code", "program-id", shortId(p.programId));
  id.title = p.programId;
  id.setAttribute("aria-label", `Program id ${p.programId}`);
  head.append(" ", id);
  text.append(head, cell(doc, "p", "row-desc", cap(understandsText(p))));
  const meta = doc.createElement("div");
  meta.className = "row-control inline program-meta";
  const kind = cell(doc, "span", "pill", p.kind);
  const src = cell(doc, "span", "pill", /verified$/i.test(p.verification) ? `${p.source} · ${p.verification}` : p.source);
  src.dataset.verification = p.verification.toLowerCase().replace(/\s+/g, "-");
  src.title = p.detail;
  const orb = orbButton(p.programId, p.title, doc);
  meta.append(kind, src, ...(orb ? [orb] : []));
  row.append(text, meta);
  return row;
}

export function mountPrograms(root: Document = document, programs: ProgramRow[] = PROGRAMS): void {
  const list = root.querySelector<HTMLElement>("#programs-list");
  if (!list) return;
  list.replaceChildren(...programs.map((p) => renderRow(p, root)));
  const filter = root.querySelector<HTMLInputElement>("#programs-filter");
  const empty = root.querySelector<HTMLElement>("#programs-empty");
  const wrap = root.querySelector<HTMLElement>("#programs-search");
  if (wrap) wrap.hidden = programs.length <= 10;
  filter?.addEventListener("input", () => {
    const q = filter.value.trim().toLowerCase();
    let shown = 0;
    programs.forEach((p, i) => {
      const hit = !q || `${p.title} ${p.name} ${p.programId} ${p.kind} ${p.understands.join(" ")}`.toLowerCase().includes(q);
      (list.children[i] as HTMLElement).hidden = !hit;
      if (hit) shown++;
    });
    if (empty) empty.hidden = shown > 0;
  });
}

export function renderTrusted(t: TrustedSite, doc: Document = document): HTMLElement {
  const row = doc.createElement("div");
  row.className = "row trusted-row";
  row.setAttribute("role", "listitem");
  row.dataset.trusted = t.origin;
  const text = doc.createElement("div");
  text.className = "row-text";
  const head = cell(doc, "span", "row-title", t.name);
  head.append(" ", cell(doc, "code", "program-id", t.origin));
  text.append(head, cell(doc, "p", "row-desc", t.reason));
  const meta = doc.createElement("div");
  meta.className = "row-control inline program-meta";
  meta.append(cell(doc, "span", "pill", t.role === "perp-dex" ? "Perp DEX" : t.role === "aggregator" ? "Aggregator" : "Lending"));
  row.append(text, meta);
  return row;
}

export function mountTrusted(root: Document = document, sites: readonly TrustedSite[] = TRUSTED_SITES): void {
  root.querySelector<HTMLElement>("#trusted-list")?.replaceChildren(...sites.map((t) => renderTrusted(t, root)));
}
