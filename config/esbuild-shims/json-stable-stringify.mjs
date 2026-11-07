// Drop-in for json-stable-stringify's default call `stringify(value)` (codama visitors-core uses no options).
// Same output: keys sorted, no whitespace, toJSON honoured, undefined/function members skipped, undefined in arrays -> null.
// Why: the real package pulls in function-bind, whose `Function("binder", ...)` trips G10 "no eval" in the MV3 service worker.
export default function stableStringify(value) {
  const seen = [];
  return (function walk(node) {
    if (node && typeof node.toJSON === "function") node = node.toJSON();
    if (node === undefined) return undefined;
    if (typeof node === "number") return Number.isFinite(node) ? String(node) : "null";
    if (typeof node === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
    if (node === null || typeof node !== "object") return typeof node === "function" ? undefined : JSON.stringify(node);
    if (seen.includes(node)) throw new TypeError("Converting circular structure to JSON");
    seen.push(node);
    let out;
    if (Array.isArray(node)) {
      out = "[" + node.map((v) => walk(v) ?? "null").join(",") + "]";
    } else {
      const parts = [];
      for (const key of Object.keys(node).sort()) {
        const v = walk(node[key]);
        if (v !== undefined) parts.push(JSON.stringify(key) + ":" + v);
      }
      out = "{" + parts.join(",") + "}";
    }
    seen.splice(seen.indexOf(node), 1);
    return out;
  })(value);
}
