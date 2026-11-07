// Human summary of a report: alert, "what simulation shows", claims by level, capabilities, preview.
import { levelValue, type Report } from "@kelvara/core";
import type { ReadNote } from "@kelvara/core";

const short = (a: string | null): string => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a ?? "?");

export function humanSummary(report: Report, ctx: { command: string; network: string; reads?: ReadNote[]; notes?: string[] }): string {
  const out: string[] = [];
  const a = report.alert;
  out.push(`Kelvara SignGuard ${ctx.command}  network ${ctx.network}  session ${report.session.id}  ${report.session.transactions.length} transaction(s)${report.session.complete ? "" : "  (incomplete: unresolved accounts)"}`);
  out.push(`ALERT ${a.level} ${a.label} -> ${a.action}`);
  out.push(report.simulation.status === "not_run" ? "Simulation: not run." : report.simulation.summary);
  const claims = [...report.claims].sort((x, y) => levelValue(y.level) - levelValue(x.level) || Number(x.id.slice(1)) - Number(y.id.slice(1)));
  out.push(`Claims (${claims.length}):`);
  for (const c of claims) out.push(`  [${c.level} ${c.kind}] ${c.ruleId ?? "-"} ${c.id}: ${c.statement}`);
  if (report.capabilities.granted.length || report.capabilities.revoked.length) {
    out.push("Capabilities:");
    for (const k of report.capabilities.granted) out.push(`  granted #${k.rank} ${k.class} ${k.capability} -> ${short(k.holder)} on ${short(k.target)}`);
    for (const k of report.capabilities.revoked) out.push(`  revoked #${k.rank} ${k.class} ${k.capability} from ${short(k.holder)} on ${short(k.target)}`);
  }
  for (const p of report.preview) {
    const names = p.unlocks.slice(0, 6).map((u) => u.instruction).join(", ");
    out.push(`Preview (${p.confidence}): ${short(p.authority)}${p.deployAnyCode ? " can deploy any code" : ""}${p.unlocks.length ? ` unlocks ${p.unlocks.length}: ${names}${p.unlocks.length > 6 ? ", …" : ""}` : " (unknown; treat as full control)"}`);
  }
  if (ctx.reads?.length) {
    const failed = ctx.reads.filter((r) => !r.ok);
    out.push(`State reads: ${ctx.reads.length - failed.length} ok, ${failed.length} not read${failed.length ? ":" : ""}`);
    for (const f of failed) out.push(`  ${f.what} ${f.address ?? ""}: ${f.detail ?? "failed"}`);
  }
  for (const n of ctx.notes ?? []) out.push(`Note: ${n}`);
  out.push(`Digest ${report.digest}`);
  return out.join("\n");
}
