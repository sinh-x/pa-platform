import { createRequire, isBuiltin } from "node:module";
import { posix } from "node:path";
import type * as TS from "typescript";

const requireCompiler = createRequire(import.meta.url);
let selectedCompiler: typeof TS | undefined;
const compiler = (): typeof TS => selectedCompiler ??= requireCompiler("typescript");

/** Resource discovery only. Parsing captured JavaScript never evaluates it,
 * imports a module, executes a helper or grants permission to run that helper. */
export class ConfigScriptDependencyError extends Error {}
const fail = (): never => { throw new ConfigScriptDependencyError("Unsupported configuration script dependency"); };
export const CONFIG_RESOURCE_ROOTS = "(?:teams|skills|docs|primers|policies|contracts|scripts|workflows)";
export const CONFIG_RESOURCE_PREFIX = new RegExp(`^${CONFIG_RESOURCE_ROOTS}/`);
const ROOT = CONFIG_RESOURCE_PREFIX;
const FILE = /^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$/;
type Value = string | number | Value[] | { external: true };
const EXTERNAL = Object.freeze({ external: true as const });
interface Module { source: TS.SourceFile; constants: Map<string, TS.Expression>; imports: Map<string, { path: string; name: string }>; fs: Map<string, string>; fsNamespaces: Set<string> }
/** Finite literal import/require graphs, literal resource paths and file URLs
 * composed from local/imported const strings/arrays. Unresolved module or URL
 * selectors fail closed. Caller-owned input files are not configuration. */
export class ConfigScriptDependencies {
  private readonly modules = new Map<string, Module>();
  constructor(private readonly read: (path: string, optional: boolean) => string | null) {}
  private relative(from: string, target: string): string {
    if (!FILE.test(target) || target.startsWith("/") || target.split("/").some(part => part.toLowerCase() === ".git")) return fail();
    const result = ROOT.test(target) ? target : posix.normalize(posix.join(posix.dirname(from), target));
    if (!ROOT.test(result) || result.split("/").some(part => !part || part === "." || part === "..")) return fail();
    return result;
  }
  private dependency(from: string, target: string): string | undefined {
    if (isBuiltin(target)) {
      if (/^(?:node:)?(?:module|vm|child_process|worker_threads)$/.test(target)) return fail();
      return undefined;
    }
    if (!/^\.\.?\//.test(target)) return fail(); // No package/absolute/live-config resolution.
    return this.relative(from, target);
  }
  private module(path: string, text?: string): Module {
    const previous = this.modules.get(path); if (previous) return previous;
    if (this.modules.size >= 256) return fail();
    const body = text ?? this.read(path, false) ?? fail();
    if (!/\.(?:mjs|cjs|js)$/.test(path)) return fail();
    const ts = compiler();
    const source = ts.createSourceFile(path, body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if ((source as TS.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length) return fail();
    const module: Module = { source, constants: new Map(), imports: new Map(), fs: new Map(), fsNamespaces: new Set() };
    this.modules.set(path, module);
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) {
        for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) module.constants.set(declaration.name.text, declaration.initializer);
      }
      if (ts.isImportDeclaration(statement)) {
        if (!ts.isStringLiteral(statement.moduleSpecifier)) return fail();
        const target = statement.moduleSpecifier.text, dependency = this.dependency(path, target), bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
          const name = binding.propertyName?.text ?? binding.name.text;
          if (dependency) module.imports.set(binding.name.text, { path: dependency, name });
          if (["node:fs", "fs", "node:fs/promises", "fs/promises"].includes(target)) {
            if (name === "promises") module.fsNamespaces.add(binding.name.text);
            else module.fs.set(binding.name.text, name);
          }
        }
        if (["node:fs", "fs", "node:fs/promises", "fs/promises"].includes(target)) {
          if (statement.importClause?.name) module.fsNamespaces.add(statement.importClause.name.text);
          if (bindings && ts.isNamespaceImport(bindings)) module.fsNamespaces.add(bindings.name.text);
        }
      }
    }
    return module;
  }
  private value(node: TS.Expression, path: string, depth = 0): Value {
    if (depth > 32) return fail();
    const ts = compiler();
    const next = (value: TS.Expression, owner = path) => this.value(value, owner, depth + 1);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isParenthesizedExpression(node)) return next(node.expression);
    if (ts.isArrayLiteralExpression(node) && node.elements.length <= 256) return node.elements.map(element => next(element));
    if (ts.isIdentifier(node)) {
      const module = this.module(path), constant = module.constants.get(node.text), imported = module.imports.get(node.text);
      if (constant) return next(constant);
      if (imported) {
        const target = this.module(imported.path), declaration = target.constants.get(imported.name);
        if (!declaration) return fail();
        return next(declaration, imported.path);
      }
      return fail();
    }
    if (ts.isElementAccessExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText() === "process" && node.expression.name.text === "argv") return EXTERNAL;
      const values = next(node.expression), index = node.argumentExpression ? next(node.argumentExpression) : fail();
      if (Array.isArray(values) && typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < values.length) return values[index]!;
      return fail();
    }
    if (ts.isTemplateExpression(node)) {
      let result = node.head.text;
      for (const span of node.templateSpans) { const value = next(span.expression); if (typeof value !== "string" && typeof value !== "number") return fail(); result += value + span.literal.text; }
      return result;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = next(node.left), right = next(node.right);
      if ((typeof left === "string" || typeof left === "number") && (typeof right === "string" || typeof right === "number")) return `${left}${right}`;
    }
    return fail();
  }
  references(path: string, text: string): string[] {
    const ts = compiler();
    const module = this.module(path, text), resources = new Set<string>();
    const dependency = (target: string) => { const value = this.dependency(path, target); if (value) resources.add(value); };
    const resource = (target: string) => { resources.add(this.relative(path, target.split("#")[0]!)); };
    const fileUrl = (node: TS.NewExpression): boolean => ts.isIdentifier(node.expression) && node.expression.text === "URL";
    const pending: TS.Node[] = [module.source]; let count = 0;
    while (pending.length) {
      const node = pending.pop()!; if (++count > 200_000) return fail();
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) return fail();
        dependency(node.moduleSpecifier.text);
      }
      if (ts.isIdentifier(node) && ["eval", "Function"].includes(node.text)) return fail();
      if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
        && ["eval", "Function", "require"].includes(node.argumentExpression.text)) return fail();
      if (ts.isIdentifier(node) && node.text === "require" && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) return fail();
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        const argument = node.arguments[0];
        if (node.arguments.length !== 1 || !argument || !ts.isStringLiteral(argument)) return fail();
        if (ts.isIdentifier(node.expression) && /^(?:node:)?fs(?:\/promises)?$/.test(argument.text)) return fail();
        dependency(argument.text);
      }
      if (ts.isNewExpression(node) && fileUrl(node)) {
        if (node.arguments?.length !== 2 || node.arguments[1]!.getText(module.source) !== "import.meta.url") return fail();
        const target = this.value(node.arguments[0]!, path); if (typeof target !== "string") return fail(); resource(target);
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        // Root-owned paths in exported data (for example readingTemplates) are
        // supporting resources too. Regexes/comments are not string literals.
        if (ROOT.test(node.text) && FILE.test(node.text)) resource(node.text);
      }
      if (ts.isIdentifier(node) && module.fsNamespaces.has(node.text)
        && !ts.isImportClause(node.parent) && !ts.isNamespaceImport(node.parent) && !ts.isImportSpecifier(node.parent)
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) return fail();
      if (ts.isIdentifier(node) && module.fs.has(node.text) && !ts.isImportSpecifier(node.parent)
        && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) return fail();
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && module.fsNamespaces.has(node.expression.text)
        && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) return fail();
      if (ts.isCallExpression(node)) {
        const direct = ts.isIdentifier(node.expression) && module.fs.has(node.expression.text);
        const namespaced = ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && module.fsNamespaces.has(node.expression.expression.text);
        if (direct || namespaced) {
          const name = ts.isIdentifier(node.expression) ? module.fs.get(node.expression.text)! : (node.expression as TS.PropertyAccessExpression).name.text;
          // Configuration helpers are captured as inert code, not executed.
          // Directory enumeration and computed config paths cannot prove closure.
          if (!/^(?:readFile|readFileSync|stat|statSync|lstat|lstatSync|access|accessSync|existsSync)$/.test(name)) return fail();
          const argument = node.arguments[0]; if (!argument) return fail();
          if (!(ts.isNewExpression(argument) && fileUrl(argument))) {
            const value = this.value(argument, path);
            if (typeof value === "object" && !Array.isArray(value) && value.external) { /* explicit caller input, not configuration */ }
            else if (typeof value === "string") resource(value);
            else return fail();
          }
        }
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
    return [...resources];
  }
}
