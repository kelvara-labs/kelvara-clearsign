// Classify a Playwright JSON report for G7. Pure: no I/O, so it is unit-tested.
//   failed / timedOut / interrupted / flaky   -> FAIL
//   skipped with a "pending" annotation        -> PENDING (feature not landed; the spec says which)
//   skipped without one                        -> FAIL (no plain skips: CLAUDE.md, never skip a failing test)
//   passed                                     -> PASS
// No tests at all is a FAIL.

function* walkSpecs(suite, titles = []) {
  const t = suite.title ? [...titles, suite.title] : titles;
  for (const spec of suite.specs ?? []) yield { spec, titles: t };
  for (const s of suite.suites ?? []) yield* walkSpecs(s, t);
}

export function classifyReport(report) {
  const cases = [];
  for (const top of report?.suites ?? []) {
    for (const { spec, titles } of walkSpecs(top)) {
      for (const t of spec.tests ?? []) {
        const results = t.results ?? [];
        const last = results[results.length - 1];
        const status = last?.status ?? "skipped";
        const annotations = [...(t.annotations ?? []), ...(last?.annotations ?? [])];
        const pend = annotations.find((a) => a.type === "pending");
        const name = [...titles.slice(1), spec.title].join(" › ") || spec.title;
        const file = spec.file ?? titles[0] ?? "";
        let verdict;
        let detail = "";
        if (t.status === "flaky") { verdict = "FAIL"; detail = "flaky"; }
        else if (status === "passed") verdict = pend ? "PENDING" : "PASS";
        else if (status === "skipped") { verdict = pend ? "PENDING" : "FAIL"; detail = pend ? pend.description ?? "" : "skipped without a pending reason"; }
        else { verdict = "FAIL"; detail = firstError(last); }
        if (pend && verdict === "PENDING") detail = pend.description ?? "";
        cases.push({ name: `${file}: ${name}`, verdict, detail });
      }
    }
  }
  const errors = (report?.errors ?? []).map((e) => oneLine(e.message ?? String(e)));
  return { cases, errors };
}

function firstError(result) {
  const e = result?.errors?.[0] ?? result?.error;
  return e ? oneLine(e.message ?? String(e)) : String(result?.status ?? "failed");
}

// eslint-disable-next-line no-control-regex
const oneLine = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2).join(" | ").slice(0, 300);

export function gateVerdict({ cases, errors }) {
  if (errors.length) return "FAIL";
  if (!cases.length) return "FAIL";
  if (cases.some((c) => c.verdict === "FAIL")) return "FAIL";
  if (cases.some((c) => c.verdict === "PENDING")) return "PENDING";
  return "PASS";
}
