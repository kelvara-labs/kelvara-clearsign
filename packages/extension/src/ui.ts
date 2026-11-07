// ui entry point (M5): extension pages. Each page names itself with <html data-page="...">.
import { mountOptions } from "./options/page.js";
import { mountReport } from "./report/page.js";

const page = document.documentElement.dataset.page;
if (page === "options") {
  mountOptions().catch(() => {
    const out = document.getElementById("result");
    if (out) out.textContent = "The options page failed to load its settings.";
  });
} else if (page === "report") {
  mountReport();
}
