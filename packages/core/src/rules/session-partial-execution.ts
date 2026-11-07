// session.partial_execution: the transactions of a session land one by one, never as one atomic
// unit, so part of the session can land without the rest. Fires per transaction whose effect stands
// on its own (later transactions depend on it, or it grants a power directly), and when separate
// simulations disagree (some transactions succeed, others fail).
import { instructionEvidence } from "./common.js";
import { grantText, outsideGrants } from "./session-links.js";
import type { Rule, RuleContext } from "./types.js";

export const RULE_ID = "session.partial_execution";

export const sessionPartialExecutionRule: Rule = {
  id: RULE_ID,
  ruleIds: [RULE_ID],
  description: "Part of a multi-transaction session can land without the rest",
  run(ctx: RuleContext) {
    const n = ctx.session.transactions.length;
    if (n < 2) return;
    const grants = outsideGrants(ctx).filter((g) => !g.proposed);
    for (let i = 0; i < n; i++) {
      const dependents: number[] = [];
      for (let j = i + 1; j < n; j++) if (ctx.claims.has(`dependency:${i}:${j}`)) dependents.push(j);
      const direct = grants.filter((g) => g.txs.length === 1 && g.txs[0] === i);
      if (!dependents.length && !direct.length) continue;
      const others = [...Array(n).keys()].filter((t) => t !== i);
      const names = [...new Set((ctx.decoded[i] ?? []).filter((ix) => ix.status === "named").map((ix) => ix.name!))];
      const parts: string[] = [`Transactions in this session land one by one, not as one unit: transaction ${i} (${names.join(", ") || "unnamed instructions"}) can land even if transaction${others.length > 1 ? "s" : ""} ${others.join(", ")} fail${others.length > 1 ? "" : "s"} or ${others.length > 1 ? "are" : "is"} never sent`];
      if (dependents.length) parts.push(`then the session stops halfway, and transaction${dependents.length > 1 ? "s" : ""} ${dependents.join(", ")}, which depend${dependents.length > 1 ? "" : "s"} on it, can still be landed later by whoever holds ${dependents.length > 1 ? "them" : "it"}`);
      if (direct.length) parts.push(`on its own it gives ${direct.map(grantText).join("; ")}`);
      const nonce = ctx.claims.get(`nonce:${i}`);
      const deps = [
        ...dependents.map((j) => ctx.claims.get(`dependency:${i}:${j}`)!),
        ...direct.map((g) => g.cap.claimId),
        ...dependents.map((j) => ctx.claims.get(`nonce:${j}`)).filter((c): c is string => !!c),
        ...(nonce ? [nonce] : [])
      ];
      const anyNonce = nonce || dependents.some((j) => ctx.claims.has(`nonce:${j}`));
      ctx.report.addClaim({
        kind: "Derived",
        ruleId: RULE_ID,
        level: "L1",
        statement: `${parts.join("; ")}.${anyNonce ? " Durable nonces keep these transactions valid, so the holder chooses when, and whether, each one lands." : ""}`,
        dependsOn: deps,
        transactionIndices: [i, ...dependents]
      });
    }

    // Separate simulations that disagree: part of the session would land as sent.
    const sims = ctx.state.simulations ?? {};
    const ok = Object.keys(sims).map(Number).filter((t) => t < n && sims[t]!.ok);
    const failed = Object.keys(sims).map(Number).filter((t) => t < n && !sims[t]!.ok);
    if (!ok.length || !failed.length) return;
    for (const t of failed) {
      const s = sims[t]!;
      const upstream = [...Array(t).keys()].filter((i) => ctx.claims.has(`dependency:${i}:${t}`));
      const evidence = [
        ctx.report.addEvidence({ type: "simulation", source: "simulation", transactionIndex: t, summary: `simulation of transaction ${t} alone fails`, data: { ok: false, err: s.err === undefined ? null : s.err, logs: s.logs.slice(-5) } }),
        ...ok.map((o) => ctx.report.addEvidence({ type: "simulation", source: "simulation", transactionIndex: o, summary: `simulation of transaction ${o} alone succeeds`, data: { ok: true, unitsConsumed: sims[o]!.unitsConsumed } })),
        ...(ctx.decoded[t] ?? []).slice(0, 1).map((ix) => instructionEvidence(ctx, t, ix))
      ];
      ctx.report.addClaim({
        kind: upstream.length ? "Conditional" : "Fact",
        ruleId: RULE_ID,
        level: "L1",
        statement: `Simulated on its own, transaction ${t} fails (${JSON.stringify(s.err ?? null).slice(0, 120)}) while transaction${ok.length > 1 ? "s" : ""} ${ok.join(", ")} succeed${ok.length > 1 ? "" : "s"}: sent as is, part of this session can land without the rest.`,
        evidenceIds: evidence,
        dependsOn: upstream.map((i) => ctx.claims.get(`dependency:${i}:${t}`)!),
        assumptions: upstream.length ? [`Transaction ${t} depends on transaction${upstream.length > 1 ? "s" : ""} ${upstream.join(", ")}, which the simulation does not chain; it may succeed once ${upstream.length > 1 ? "they land" : "that lands"}.`] : [],
        transactionIndices: [...new Set([t, ...ok])]
      });
    }
  }
};
