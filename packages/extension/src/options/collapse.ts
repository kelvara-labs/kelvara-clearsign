// Options long lists: a count and a Show all / Hide toggle in the list's header. Presentational only:
// the rows stay in the DOM and CSS hides all but the first five while the list is collapsed. Nothing is stored.
const LISTS: { list: string; noun: string }[] = [
  { list: "programs-list", noun: "programs" },
  { list: "trusted-list", noun: "sites" },
  { list: "labels-list", noun: "programs" }
];
export const COLLAPSE_OVER = 8;

export function mountCollapsibles(root: Document = document): void {
  for (const { list, noun } of LISTS) {
    const rows = root.getElementById(list);
    const card = rows?.closest<HTMLElement>(".group-card");
    const head = card?.previousElementSibling;
    if (!rows || !card || !head?.classList.contains("group-head")) continue;
    const count = rows.children.length;
    if (count <= COLLAPSE_OVER) continue;
    const total = root.createElement("span");
    total.className = "list-count";
    total.textContent = `${count} ${noun}`;
    const toggle = root.createElement("button");
    toggle.type = "button";
    toggle.className = "secondary compact list-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", list);
    toggle.textContent = "Show all";
    const set = (open: boolean) => {
      card.dataset.collapsed = String(!open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Hide" : "Show all";
    };
    toggle.addEventListener("click", () => set(toggle.getAttribute("aria-expanded") !== "true"));
    const wrap = root.createElement("div");
    wrap.className = "list-tools";
    wrap.append(total, toggle);
    head.append(wrap);
    set(false);
  }
}
