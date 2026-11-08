// Loopback OpenAI-compatible mock provider for extension AI-intent e2e. node:http only, 127.0.0.1 only.
// Usage: node scripts/mock-provider.mjs [--port N]   (prints {"url": "http://127.0.0.1:N"} on stdout)
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

export const MODES = ["select-highest", "fallback", "lower-priority", "wrong-binding", "invented-reason", "refusal", "malformed", "http-500", "redirect", "slow", "oversize"];
const OUTPUT_MAX = 16384;
const SLOW_MS = 6500;

function selection(input, mode) {
  const { binding, fallbackId, candidates } = input;
  const fb = candidates.find(c => c.id === fallbackId);
  const reasons = c => c.reasons.map(r => r.id);
  const pick = c => ({ binding, candidateId: c.id, reasonIds: reasons(c) });
  switch (mode) {
    case "fallback": return pick(fb);
    case "select-highest": {
      const best = candidates.filter(c => c.priority >= fb.priority).sort((a, b) => b.priority - a.priority)[0];
      return pick(best);
    }
    case "lower-priority": {
      const low = candidates.filter(c => c.priority < fb.priority).sort((a, b) => b.priority - a.priority)[0];
      if (!low) throw new Error("no candidate below fallback");
      return pick(low);
    }
    case "wrong-binding": return { ...pick(fb), binding: `${binding}:tampered` };
    case "invented-reason": return { ...pick(fb), reasonIds: [...reasons(fb), "invented-reason"] };
    default: return pick(fb);
  }
}

function completion(text, responses) {
  return responses
    ? { id: "resp_mock", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] }
    : { id: "chatcmpl-mock", object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }] };
}
function refusal(responses) {
  return responses
    ? { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "I cannot help with that." }] }] }
    : { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: null, refusal: "I cannot help with that." } }] };
}

/** Starts the mock. Resolves { url, port, close, last(), setMode(name) }. */
export async function startMock({ port = 0, mode = "select-highest", slowMs = SLOW_MS } = {}) {
  let defaultMode = mode;
  let lastRequest = null;
  const server = createServer((req, res) => {
    const send = (code, body, headers = {}) => {
      const raw = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
      res.end(raw);
    };
    let path = new URL(req.url, "http://127.0.0.1").pathname;
    const control = /^\/mode\/([a-z-]+)\/?$/.exec(path);
    if (control && req.method === "POST") {
      if (!MODES.includes(control[1])) return send(400, { error: "unknown mode" });
      defaultMode = control[1];
      return send(200, { mode: defaultMode });
    }
    if (path === "/last" && req.method === "GET") return send(200, lastRequest ?? null);
    if (path === "/redirected") return send(200, completion("{}", false));
    let reqMode = defaultMode;
    const prefix = /^\/mode\/([a-z-]+)(\/.*)$/.exec(path);
    if (prefix) {
      if (!MODES.includes(prefix[1])) return send(400, { error: "unknown mode" });
      reqMode = prefix[1];
      path = prefix[2];
    }
    if (req.method !== "POST" || (path !== "/v1/chat/completions" && path !== "/v1/responses")) return send(404, { error: "not found" });
    const responses = path === "/v1/responses";
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", async () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let body;
      let input;
      try {
        body = JSON.parse(bodyText);
        const raw = responses ? body.input : body.messages.find(m => m.role === "user").content;
        input = JSON.parse(raw);
      } catch { return send(400, { error: "bad request" }); }
      lastRequest = { path, mode: reqMode, authorization: req.headers.authorization ?? null, headers: req.headers, bodyText, body, input };
      try {
        if (reqMode === "http-500") return send(500, { error: "boom" });
        if (reqMode === "redirect") return send(307, "", { Location: "/redirected" });
        if (reqMode === "refusal") return send(200, refusal(responses));
        if (reqMode === "malformed") return send(200, completion("not json {", responses));
        if (reqMode === "oversize") {
          const text = JSON.stringify({ ...selection(input, "fallback"), pad: "x".repeat(OUTPUT_MAX + 1024) });
          return send(200, completion(text, responses));
        }
        if (reqMode === "slow") await new Promise(r => setTimeout(r, slowMs));
        if (res.destroyed) return;
        send(200, completion(JSON.stringify(selection(input, reqMode === "slow" ? "select-highest" : reqMode)), responses));
      } catch (e) { send(500, { error: String(e.message) }); }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const actual = server.address().port;
  return {
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    last: () => lastRequest,
    setMode: m => { if (!MODES.includes(m)) throw new Error("unknown mode"); defaultMode = m; },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); })
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--port");
  const mock = await startMock({ port: i > 0 ? Number(process.argv[i + 1]) : 0 });
  process.stdout.write(`${JSON.stringify({ url: mock.url, port: mock.port, modes: MODES })}\n`);
  const stop = () => mock.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
