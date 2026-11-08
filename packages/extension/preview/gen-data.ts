// Dev-only: builds real ReportView verdicts from recorded fixtures (never shipped). Run via preview/build.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { analyzeSession, buildIntentContext, ingestSession, ReportBuilder, type Report, type Session, type RpcClient } from "@kelvara/core";
import { buildRegistry } from "../src/sw/registry.js";
import { fromReport } from "../src/sw/from-report.js";
import { templateIntent } from "../src/intent/selection.js";
import { reviewMessage, messageVerdict } from "../src/sw/message-review.js";
import { b64encode } from "../src/shared/codec.js";
import { MINIMAL_MESSAGE } from "../test/helpers.js";
import { poisonManifest, requestCase } from "../../core/test/address-helpers.js";
import { analyze, decoder, sessionFromRuntime } from "../../core/test/rules-helpers.js";

const fx = (p: string) => new URL(`../../../fixtures/${p}`, import.meta.url);
const manifest = JSON.parse(readFileSync(fx("tx/manifest.json"), "utf8")) as { fixtures: { path: string; e2e?: string }[] };
const rpc: RpcClient = { network: "localnet", endpoint: "http://localhost:8899", stats: { requests: 0, retries: 0, cacheHits: 0, rateLimited: 0 }, call: async () => { throw new Error("offline preview"); }, clearCache() {} };
const reg = buildRegistry();

async function fromFixture(pathPart: string) {
  const entry = manifest.fixtures.find((f) => f.e2e === pathPart || f.path.includes(pathPart))!;
  const tx = JSON.parse(readFileSync(fx(entry.path), "utf8")) as { transaction: string };
  const session = await ingestSession([{ base64: tx.transaction, kind: "wire" }]);
  return analyzed(session, pathPart);
}
async function fromRuntime(file: URL, name: string) {
  const f = JSON.parse(readFileSync(file, "utf8")) as { transaction: string; meta: { loadedAddresses?: { writable: string[]; readonly: string[] } } };
  return analyzed(sessionFromRuntime(f.transaction, f.meta.loadedAddresses ?? { writable: [], readonly: [] }), name);
}
async function analyzed(session: Session, pathPart: string) {
  const result = await analyzeSession(session, { decoder: reg.decoder, squadsAccounts: reg.squadsAccounts, authorityMaps: reg.authorityMaps, rpc });
  const m = fromReport(result.report, result.intentContext.messageHashes);
  if (!m.ok) throw new Error(`${pathPart}: ${m.reason}`);
  return { m, context: result.intentContext };
}

const verdict = (level: number, report: unknown, reason: string) => ({ allow: false, hold: level <= 3, level, reason, report });
const out: Record<string, unknown> = {};
const tag = (name: string, x: { m: { level: number; report: unknown }; context?: unknown }, withIntent = false) => {
  const report = withIntent ? { ...(x.m.report as object), intent: templateIntent(x.context as never) } : x.m.report;
  out[name] = verdict(x.m.level, report, (x.m.report as { title: string }).title);
};

const DRIFT_ATTACKS = ["2HvMSgDEfKhNryYZKhjowrBY55rUx5MWtcWkG9hqxZCFBaTiahPwfynP1dxBSRk9s5UTVc8LFeS4Btvkm9pc2C4H", "4BKBmAJn6TdsENij7CsVbyMVLJU1tX27nfrMM1zgKv1bs2KJy6Am2NqdA3nJm4g9C6eC64UAf5sNs974ygB9RsN1"].map((sig) => JSON.parse(readFileSync(fx(`tx/drift-replay/${sig}.json`), "utf8")) as { transaction: string; label: string });
const session: Session = await ingestSession(DRIFT_ATTACKS.map((f) => ({ base64: f.transaction, kind: "wire" as const, label: f.label })));
/** Same shape as the core contract test's Drift report, plus a deploy-any-code preview and an L1 notice. */
function driftReport(sim: Report["simulation"] | null = null): Report {
  const b = new ReportBuilder(session);
  const ix = session.transactions.map((tx) =>
    tx.instructions.map((i) =>
      b.addEvidence({
        type: "instruction",
        source: "message",
        summary: `instruction ${i.index} calls ${i.programAddress}`,
        transactionIndex: tx.index,
        instructionPath: [i.index],
        address: i.programAddress
      })
    )
  );
  const nonce = b.addClaim({
    kind: "Fact",
    statement: "Transaction 2 starts with AdvanceNonceAccount: it uses a durable nonce and does not expire.",
    evidenceIds: [ix[1]![0]!],
    ruleId: "lifetime.durable_nonce",
    level: "L2"
  });
  const unknown = b.addClaim({ kind: "Unknown", statement: "One instruction could not be named.", evidenceIds: [ix[0]!.at(-1)!], level: "L1" });
  const derived = b.addClaim({
    kind: "Derived",
    statement: "Transaction 2 can be held and submitted at any later time.",
    dependsOn: [nonce],
    ruleId: "lifetime.durable_nonce",
    level: "L3"
  });
  const conditional = b.addClaim({
    kind: "Conditional",
    statement: "If the proposal reaches its threshold, the vault transaction executes.",
    evidenceIds: ix[0]!.slice(0, 1),
    dependsOn: [unknown],
    ruleId: "squads.threshold_met_in_session",
    assumptions: ["the multisig threshold read from chain is current"],
    level: "L3"
  });
  const program = session.transactions[0]!.instructions[0]!.programAddress;
  b.addCapability({ direction: "granted", capability: "token.freeze", class: "freeze", holder: null, target: null, claimId: conditional });
  b.addCapability({ direction: "revoked", capability: "protocol.admin", class: "admin_control", holder: program, target: program, claimId: derived });
  b.addCapability({ direction: "granted", capability: "protocol.admin", class: "admin_control", holder: null, target: program, claimId: derived });
  b.addCapability({ direction: "granted", capability: "program.upgrade", class: "code_control", holder: null, target: program, claimId: derived });
  b.addPreview({
    authority: null,
    programId: null,
    confidence: "observed",
    deployAnyCode: false,
    unlocks: [
      { instruction: "config_change", discriminator: null, changes: "configuration", class: "config" },
      { instruction: "admin_call", discriminator: "00ff", changes: "admin", class: "admin_control" }
    ],
    claimId: conditional
  });
  b.addPreview({ authority: null, programId: program, confidence: "verified", deployAnyCode: true, unlocks: [], claimId: derived });
  if (sim) b.setSimulation(sim);
  return b.build();
}


const driftMapped = fromReport(driftReport(), session.transactions.map((t) => t.messageHash));
if (!driftMapped.ok) throw new Error(driftMapped.reason);
const l3 = await fromFixture("l3-batch");
const l2 = await fromFixture("l2-trap");
const l4 = await fromFixture("l4-sweep");
const memo = await fromFixture("memo/");
const spl = await fromFixture("spl-token/");
const jup = await fromRuntime(fx(manifest.fixtures.find((f) => f.path.includes("jupiter-v6/"))!.path), "jupiter");
const vel = await fromRuntime(new URL("../../core/test/fixtures/velocity/316PMRR4pcZtEw9taNrJYC9peZ6sSQUFRKkNfzHywCqnnF7UWNEwBG4inZXnzHyZZ8y4CJkimCqFffcUu8hDfVp9.json", import.meta.url), "velocity");
out["jupiter"] = verdict(jup.m.level, { ...(jup.m.report as object), intent: templateIntent(jup.context as never) }, (jup.m.report as { title: string }).title);
out["velocity"] = verdict(vel.m.level, { ...(vel.m.report as object), intent: templateIntent(vel.context as never) }, (vel.m.report as { title: string }).title);
console.log("levels", { l3: l3.m.level, l2: l2.m.level, l4: l4.m.level, memo: memo.m.level, spl: spl.m.level });

const poisonCase = poisonManifest.cases.find((c) => c.kind === "poisoning" && c.network === "devnet")!;
const replayed = await requestCase(poisonCase);
const poisoningContext = buildIntentContext({ ...replayed, report: analyze(replayed.session, replayed.state), decoded: decoder.decodeSession(replayed.session) });
const poisonView = fromReport(analyze(replayed.session, replayed.state), poisoningContext.messageHashes);
if (!poisonView.ok) throw new Error(poisonView.reason);
console.log("poison level", poisonView.level);

out["L3"] = verdict(3, driftMapped.report, driftMapped.report.title);
out["L1-spl"] = verdict(1, spl.m.report, (spl.m.report as { title: string }).title);
tag("L2-intent", l3, true);
tag("L2", l3);
tag("L4", { m: poisonView });
tag("L0-memo", memo);
tag("L4-intent", { m: poisonView, context: poisoningContext }, true);
tag("poison-intent", { m: poisonView, context: poisoningContext }, true);
const ai = JSON.parse(JSON.stringify(out["poison-intent"])) as { report: { intent: { source: string; status: string } } };
ai.report.intent.source = "ai";
ai.report.intent.status = "selected";
out["poison-intent-ai"] = ai;
out["blocked-null"] = { allow: false, hold: false, level: null, reason: "Blocked: request could not be analyzed", report: null };
const ACCOUNT = "HH7x3VCwrHQKWHLy11TNd6zd3AL1VSzD2nLsAGgUaZez";
const msgReq = (extra: Record<string, unknown>) => ({ v: 1, kind: "message", id: "0123456789abcdef0123456789abcdef", method: "solana:signMessage", wallet: "Phantom", account: ACCOUNT, chain: null, message: null, signIn: null, ...extra }) as never;
const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const deps = { now: () => NOW, isTransaction: (b: Uint8Array) => b.length > 64 && b[0] === 1 };
const siwsGood = { domain: "dapp.example", address: ACCOUNT, statement: "Welcome", uri: "https://dapp.example/login", version: "1", chainId: "mainnet", nonce: "abcd1234", issuedAt: "2026-11-08T11:59:00.000Z", expirationTime: "2026-11-08T13:00:00.000Z" };
const review = (req: unknown) => messageVerdict(reviewMessage(req as never, "https://dapp.example/app", deps));
out["msg-siws-ok"] = review(msgReq({ method: "solana:signIn", signIn: siwsGood }));
out["msg-siws-mismatch"] = review(msgReq({ method: "solana:signIn", signIn: { ...siwsGood, domain: "evil-airdrop.example", uri: "https://evil-airdrop.example/login" } }));
out["msg-text"] = review(msgReq({ message: b64encode(new TextEncoder().encode("Please confirm you own this account.\nNonce: 8f2a91")) }));
out["msg-binary"] = review(msgReq({ message: b64encode(Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0x9a, 0x42])) }));
out["msg-hidden-tx"] = review(msgReq({ message: b64encode(Uint8Array.from([1, ...new Uint8Array(64), ...MINIMAL_MESSAGE])) }));
for (const [name, v] of Object.entries(out)) {
  const x = v as { report: Record<string, unknown> | null };
  if (x.report && !x.report.message) { x.report.origin = "https://app.squads.so"; x.report.network = name === "L4" || name.startsWith("poison") || name === "L0-memo" ? "devnet" : "mainnet"; }
}
writeFileSync(process.argv[2]!, JSON.stringify(out));
console.log("wrote", Object.keys(out).join(","));
