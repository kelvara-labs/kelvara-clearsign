// G10 network-target analysis (V10). Parses a JS bundle with the TypeScript parser (root devDependency, used
// here as a plain JS parser) and returns every value that reaches a network sink:
//   fetch(), importScripts(), navigator.sendBeacon(), import(), xhr.open() / window.open(), location.assign/replace,
//   new WebSocket / EventSource / Worker / SharedWorker / Request, el.setAttribute("src"|"href"|...),
//   and runtime assignments to .src / .href / .action / .srcset / .location.
// For each sink argument it collects the hosts named by string and template literals anywhere inside it (so
// `fetch(new URL("/x", "https://h"))` counts) plus the literals one hop away through a variable (`const u="https://h";
// fetch(u)`). A template whose host is a substitution (`https://${e}/`) is reported as dynamic. What this cannot see
// (values built across functions or modules) is covered by G7's runtime request recorder.
import ts from "typescript";

export const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>)\\]+/gi;
const CALL_SINKS = new Set(["fetch", "importScripts", "sendBeacon"]);
const NEW_SINKS = new Set(["WebSocket", "EventSource", "Worker", "SharedWorker", "Request", "XMLHttpRequest"]);
const ASSIGN_SINKS = new Set(["src", "href", "action", "formAction", "srcset", "location"]);
const ATTR_SINKS = new Set(["src", "href", "action", "formaction", "srcset", "data", "poster", "background"]);

const nameOf = (e) => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null);

/** Text of a literal with `${}` in place of substitutions, or null if the node is not a string/template literal. */
function literalText(n) {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => "${" + s.expression.getText() + "}" + s.literal.text).join("");
  return null;
}

/** Hosts named in a literal's text: [{ host, url, dynamic }]. Relative URLs name no host. */
export function hostsInText(text) {
  const out = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;]+$/, "");
    const auth = url.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0].replace(/^[^@]*@/, "");
    if (auth.includes("${")) { out.push({ host: auth, url, dynamic: true }); continue; }
    let host = null;
    try { host = new URL(url).hostname.toLowerCase(); } catch { /* unparseable */ }
    out.push({ host: host ?? auth, url, dynamic: false });
  }
  return out;
}

/** Every sink use in a JS source: [{ sink, pos, line, hosts: [{host,url,dynamic,via}] }] (hosts may be empty). */
export function findSinkTargets(source, fileName = "bundle.js") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  // name -> initializer/assigned expressions (scope-unaware on purpose: a minified name that collides only widens the net)
  const defs = new Map();
  const fetchAliases = new Set(["fetch"]);
  const addDef = (name, expr) => { if (!defs.has(name)) defs.set(name, []); defs.get(name).push(expr); };
  // `i = e.fetch ?? globalThis.fetch.bind(globalThis)`: any `??`/`||` alternative that is a fetch reference.
  const isFetchRef = (e) => e.getText(sf).replace(/\s+/g, "").split(/\?\?|\|\|/)
    .some((alt) => /^(?:[\w$]+\.)*fetch(?:\.bind\([^)]*\))?$/.test(alt.replace(/^\(+|\)+$/g, "")));
  (function collect(n) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      addDef(n.name.text, n.initializer);
      if (isFetchRef(n.initializer)) fetchAliases.add(n.name.text);
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
      addDef(n.left.text, n.right);
      if (isFetchRef(n.right)) fetchAliases.add(n.left.text);
    }
    ts.forEachChild(n, collect);
  })(sf);

  const hostsIn = (expr, depth = 0, seen = new Set()) => {
    const out = [];
    (function walk(n) {
      const t = literalText(n);
      if (t !== null) {
        for (const h of hostsInText(t)) out.push({ ...h, via: depth ? "variable" : "literal" });
        // `${base}/rpc`: the substitutions may carry the host; follow them like any other expression.
        if (ts.isTemplateExpression(n)) for (const s of n.templateSpans) walk(s.expression);
        return;
      }
      if (ts.isIdentifier(n) && depth === 0 && !seen.has(n.text) && defs.has(n.text)) {
        seen.add(n.text);
        for (const d of defs.get(n.text)) out.push(...hostsIn(d, 1, seen));
        return;
      }
      ts.forEachChild(n, walk);
    })(expr);
    return out;
  };

  const found = [];
  const record = (sink, node, args) => {
    const hosts = args.flatMap((a) => hostsIn(a));
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push({ sink, pos: node.getStart(sf), line: line + 1, hosts });
  };
  (function visit(n) {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = nameOf(callee);
      if (callee.kind === ts.SyntaxKind.ImportKeyword) record("import()", n, n.arguments);
      else if (name && (CALL_SINKS.has(name) || (ts.isIdentifier(callee) && fetchAliases.has(name)))) record(`${name}()`, n, n.arguments);
      else if (name === "open" && ts.isPropertyAccessExpression(callee)) record(".open()", n, n.arguments);
      else if ((name === "assign" || name === "replace") && ts.isPropertyAccessExpression(callee) && nameOf(callee.expression) === "location") record(`location.${name}()`, n, n.arguments);
      else if (name === "setAttribute" && n.arguments.length >= 2) {
        const attr = literalText(n.arguments[0]);
        if (attr === null || ATTR_SINKS.has(attr.toLowerCase())) record(`setAttribute(${attr ?? "?"})`, n, [n.arguments[1]]);
      }
    } else if (ts.isNewExpression(n)) {
      const name = nameOf(n.expression);
      if (name && NEW_SINKS.has(name)) record(`new ${name}()`, n, [...(n.arguments ?? [])]);
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(n.left) && ASSIGN_SINKS.has(n.left.name.text)) {
      record(`.${n.left.name.text}=`, n, [n.right]);
    }
    ts.forEachChild(n, visit);
  })(sf);
  return found;
}

/** HTML attributes that load a resource: <script src>, <link href>, <img src>, <form action>, <iframe src>, ... */
export function findHtmlSinkTargets(html) {
  const out = [];
  for (const m of html.matchAll(/\b(src|href|action|formaction|srcset|data|poster)\s*=\s*["']?([^"'\s>]+)/gi)) {
    out.push({ sink: `${m[1].toLowerCase()}=`, pos: m.index, line: html.slice(0, m.index).split("\n").length, hosts: hostsInText(m[2]).map((h) => ({ ...h, via: "attribute" })) });
  }
  return out;
}
