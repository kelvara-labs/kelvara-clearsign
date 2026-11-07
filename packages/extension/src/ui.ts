// ui entry point (M5): extension pages. Each page names itself with
// <html data-page="...">; the report UI mounts here too when it lands.
import { mountOptions } from "./options/page.js";

const page = document.documentElement.dataset.page;
if (page === "options") {
  mountOptions().catch(() => {
    const out = document.getElementById("result");
    if (out) out.textContent = "The options page failed to load its settings.";
  });
}
