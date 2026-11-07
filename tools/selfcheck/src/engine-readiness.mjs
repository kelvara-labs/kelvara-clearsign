// Only proven stub wiring may defer G7. Unknown wiring runs the engine cases.
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export function hasRealEngine(root) {
  const read = (name) => {
    const file = path.join(root, "packages/extension/src", name);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) throw new Error(`cannot inspect engine wiring: ${name}`);
    return source;
  };
  const worker = read("service-worker.ts");
  const stub = read("sw/engine-stub.ts");
  const imports = worker.statements.filter(ts.isImportDeclaration);
  const binding = (module, name) => imports.flatMap((s) =>
    s.moduleSpecifier.text === module && !s.importClause?.isTypeOnly && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)
      ? s.importClause.namedBindings.elements.filter((e) => !e.isTypeOnly && (e.propertyName ?? e.name).text === name)
      : []);
  const [engine] = binding("./sw/engine-stub.js", "stubEngine");
  const [decide] = binding("./sw/policy.js", "decide");
  if (!engine || !decide) return true;
  let calls = 0;
  let unknown = false;
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === decide.name.text && node !== decide.name) {
      if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) unknown = true;
      else {
        calls++;
        const arg = node.parent.arguments[2];
        if (!arg || !ts.isIdentifier(arg) || arg.text !== engine.name.text) unknown = true;
      }
    }
    if (ts.isIdentifier(node) && node.text === engine.name.text && node !== engine.name && node !== engine.propertyName) {
      const call = node.parent;
      if (!ts.isCallExpression(call) || call.arguments[2] !== node || !ts.isIdentifier(call.expression) || call.expression.text !== decide.name.text) unknown = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(worker);
  if (unknown || !calls) return true;

  // A stub-named adapter may itself have been integrated. Only the fixed L2,
  // call-free literal report is recognized; changes default to running G7.
  const declarations = stub.statements.filter(ts.isVariableStatement).flatMap((s) => s.declarationList.declarations);
  const value = declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === "stubEngine")?.initializer;
  if (!value || !ts.isObjectLiteralExpression(value) || value.properties.length !== 1) return true;
  const method = value.properties[0];
  if (!ts.isMethodDeclaration(method) || method.name.getText(stub) !== "analyze" || method.body?.statements.length !== 1) return true;
  const statement = method.body.statements[0];
  const report = ts.isReturnStatement(statement) ? statement.expression : undefined;
  if (!report || !ts.isObjectLiteralExpression(report)) return true;
  const level = report.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(stub) === "level");
  if (!level || !ts.isNumericLiteral(level.initializer) || level.initializer.text !== "2") return true;
  const inspect = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isSpreadAssignment(node) || ts.isFunctionLike(node) || ts.isComputedPropertyName(node)) unknown = true;
    ts.forEachChild(node, inspect);
  };
  inspect(report);
  // No executable top-level adapter setup beyond the stub declaration.
  if (stub.statements.some((s) => !(ts.isImportDeclaration(s) ? s.importClause?.isTypeOnly : ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || (ts.isVariableStatement(s) && s.declarationList.declarations.length === 1 && s.declarationList.declarations[0].initializer === value)))) unknown = true;
  return unknown;
}
