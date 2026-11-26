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
const MAX_SELECTOR_LENGTH = 4096;
const MAX_EVALUATION_STEPS = 8192;
const OPAQUE_NAMES = new Set(["eval", "Function", "URL", "globalThis", "global", "Reflect", "require", "module", "exports", "createRequire", "getBuiltinModule", "constructor", "prototype", "__proto__", "defineProperty", "defineProperties", "setPrototypeOf", "getPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors"]);
type Value = string | number | Value[] | { external: true };
const EXTERNAL = Object.freeze({ external: true as const });
interface Module {
  source: TS.SourceFile; constants: Map<string, TS.Expression>; imports: Map<string, { path: string; name: string }>;
  fs: Map<string, string>; fsNamespaces: Set<string>; bindings: Map<string, number>; writes: Set<string>;
  uses: Map<string, TS.Identifier[]>; bound: Map<string, TS.Identifier[]>; stableArrays: Set<string>;
}
/** Finite named/side-effect import graphs, literal resource paths and file URLs
 * composed from unambiguous local/imported const strings and primitive arrays.
 * Opaque sharing/loaders and unresolved selectors reject, never fall back.
 * Caller-owned input files are not configuration; this is not a JS sandbox. */
export class ConfigScriptDependencies {
  private readonly modules = new Map<string, Module>();
  private evaluationSteps = 0;
  constructor(private readonly read: (path: string, optional: boolean) => string | null) {}
  private relative(from: string, target: string): string {
    if (!FILE.test(target) || target.startsWith("/") || target.split("/").some(part => part.toLowerCase() === ".git")) return fail();
    const result = posix.normalize(posix.join(posix.dirname(from), target));
    if (!ROOT.test(result) || result.split("/").some(part => !part || part === "." || part === "..")) return fail();
    return result;
  }
  private dependency(from: string, target: string): string | undefined {
    if (isBuiltin(target)) {
      if (/^(?:node:)?(?:module|vm|child_process|worker_threads|process)$/.test(target)) return fail();
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
    const module: Module = { source, constants: new Map(), imports: new Map(), fs: new Map(), fsNamespaces: new Set(),
      bindings: new Map(), writes: new Set(), uses: new Map(), bound: new Map(), stableArrays: new Set() };
    this.modules.set(path, module);
    const bind = (name: TS.BindingName): void => {
      if (ts.isIdentifier(name)) {
        module.bindings.set(name.text, (module.bindings.get(name.text) ?? 0) + 1);
        const bound = module.bound.get(name.text) ?? []; bound.push(name); module.bound.set(name.text, bound);
      } else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
    };
    const write = (node: TS.Node): void => {
      // Destructuring and property/index writes are restrictive too. Including
      // property keys is conservative: ambiguity rejects rather than guesses.
      const pending = [node];
      while (pending.length) {
        const next = pending.pop()!;
        if (ts.isIdentifier(next)) module.writes.add(next.text);
        ts.forEachChild(next, child => { pending.push(child); });
      }
    };
    const pending: TS.Node[] = [source]; let count = 0;
    while (pending.length) {
      const node = pending.pop()!; if (++count > 200_000) return fail();
      if (ts.isIdentifier(node)) {
        const uses = module.uses.get(node.text) ?? []; uses.push(node); module.uses.set(node.text, uses);
      }
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bind(node.name);
      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) bind(node.name);
      if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) bind(node.name);
      if (ts.isImportClause(node) && node.name) bind(node.name);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) write(node.left);
      if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) write(node.initializer);
      if (ts.isDeleteExpression(node) || (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) write(ts.isDeleteExpression(node) ? node.expression : node.operand);
      ts.forEachChild(node, child => { pending.push(child); });
    }
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) {
        for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) module.constants.set(declaration.name.text, declaration.initializer);
      }
      if (ts.isImportDeclaration(statement)) {
        if (!ts.isStringLiteral(statement.moduleSpecifier)) return fail();
        const target = statement.moduleSpecifier.text, dependency = this.dependency(path, target), bindings = statement.importClause?.namedBindings;
        // Opaque module namespaces/defaults could mutate another importer's
        // selector arrays without a named binding we can validate.
        if (dependency && (statement.importClause?.name || bindings && ts.isNamespaceImport(bindings))) return fail();
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
  private stable(module: Module, name: string, array: boolean): void {
    // This grammar deliberately rejects shadowing instead of interpreting scopes.
    if (module.bindings.get(name) !== 1 || module.writes.has(name)) return fail();
    if (!array || module.stableArrays.has(name)) return;
    const ts = compiler();
    for (const node of module.uses.get(name) ?? []) {
      const parent = node.parent;
      if ((ts.isVariableDeclaration(parent) || ts.isImportSpecifier(parent)) && parent.name === node
        || ts.isElementAccessExpression(parent) && parent.expression === node && parent.argumentExpression && ts.isNumericLiteral(parent.argumentExpression)
        || (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.expression === node
        || ts.isPropertyAccessExpression(parent) && (parent.name === node || parent.expression === node && parent.name.text === "length")
        || ts.isPropertyAssignment(parent) && parent.name === node) continue;
      // Array aliases, function arguments, mutators and object escapes cannot
      // establish immutable selector data. Flat primitive arrays need no aliases.
      return fail();
    }
    module.stableArrays.add(name);
  }
  private computedRead(module: Module, node: TS.ElementAccessExpression): boolean {
    const ts = compiler(), key = node.argumentExpression;
    if (key && ts.isNumericLiteral(key)) return true;
    if (!key || !ts.isIdentifier(key) || module.writes.has(key.text)) return false;
    // Schema validators may read dictionaries using finite immutable for-of
    // keys. Do not treat arbitrary computed strings as safe loader properties.
    for (let owner: TS.Node | undefined = node.parent; owner; owner = owner.parent) {
      if (!ts.isForOfStatement(owner) || !ts.isVariableDeclarationList(owner.initializer)
        || !(owner.initializer.flags & ts.NodeFlags.Const) || owner.initializer.declarations.length !== 1) continue;
      const name = owner.initializer.declarations[0]!.name;
      if (!ts.isIdentifier(name) || name.text !== key.text) continue;
      if ((module.bound.get(key.text) ?? []).some(binding => binding.pos >= owner.statement.pos && binding.end <= owner.statement.end)) return false;
      const values = this.value(owner.expression, module.source.fileName);
      return Array.isArray(values) && values.every(value => typeof value === "string" && !OPAQUE_NAMES.has(value));
    }
    return false;
  }
  private value(node: TS.Expression, path: string, depth = 0): Value {
    if (++this.evaluationSteps > MAX_EVALUATION_STEPS || depth > 32) return fail();
    const ts = compiler();
    const next = (value: TS.Expression, owner = path) => this.value(value, owner, depth + 1);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.length <= MAX_SELECTOR_LENGTH ? node.text : fail();
    if (ts.isNumericLiteral(node)) return Number.isFinite(Number(node.text)) ? Number(node.text) : fail();
    if (ts.isParenthesizedExpression(node)) return next(node.expression);
    if (ts.isArrayLiteralExpression(node) && node.elements.length <= 256) return node.elements.map(element => {
      const value = next(element);
      return typeof value === "string" || typeof value === "number" ? value : fail();
    });
    if (ts.isIdentifier(node)) {
      const module = this.module(path), constant = module.constants.get(node.text), imported = module.imports.get(node.text);
      if (constant) {
        const value = next(constant); this.stable(module, node.text, Array.isArray(value)); return value;
      }
      if (imported) {
        const target = this.module(imported.path), declaration = target.constants.get(imported.name);
        if (!declaration) return fail();
        const value = next(declaration, imported.path);
        this.stable(target, imported.name, Array.isArray(value)); this.stable(module, node.text, Array.isArray(value));
        return value;
      }
      return fail();
    }
    if (ts.isElementAccessExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText() === "process" && node.expression.name.text === "argv") {
        const module = this.module(path);
        if (module.bindings.has("process") || module.writes.has("process")) return fail();
        for (const use of module.uses.get("process") ?? []) if (!ts.isPropertyAccessExpression(use.parent) || use.parent.expression !== use) return fail();
        return EXTERNAL;
      }
      const values = next(node.expression), index = node.argumentExpression ? next(node.argumentExpression) : fail();
      if (Array.isArray(values) && typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < values.length) return values[index]!;
      return fail();
    }
    if (ts.isTemplateExpression(node)) {
      let result = node.head.text;
      if (result.length > MAX_SELECTOR_LENGTH) return fail();
      for (const span of node.templateSpans) {
        const value = next(span.expression);
        if (typeof value !== "string" && typeof value !== "number") return fail();
        if (result.length + String(value).length + span.literal.text.length > MAX_SELECTOR_LENGTH) return fail();
        result += value + span.literal.text;
      }
      return result;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = next(node.left), right = next(node.right);
      if (typeof left === "number" && typeof right === "number") return Number.isFinite(left + right) ? left + right : fail();
      if ((typeof left === "string" || typeof left === "number") && (typeof right === "string" || typeof right === "number")) {
        if (String(left).length + String(right).length > MAX_SELECTOR_LENGTH) return fail();
        return `${left}${right}`;
      }
    }
    return fail();
  }
  references(path: string, text: string): string[] {
    // Depth alone does not bound repeated constant expansion or concatenation.
    this.evaluationSteps = 0;
    const ts = compiler();
    const module = this.module(path, text), resources = new Set<string>();
    const dependency = (target: string) => { const value = this.dependency(path, target); if (value) resources.add(value); };
    const resource = (target: string, locator = false) => { resources.add(this.relative(locator ? "" : path, target.split("#")[0]!)); };
    const fileUrl = (node: TS.NewExpression): boolean => ts.isIdentifier(node.expression) && node.expression.text === "URL";
    const pending: TS.Node[] = [module.source]; let count = 0;
    while (pending.length) {
      const node = pending.pop()!; if (++count > 200_000) return fail();
      if (ts.isExportDeclaration(node)) return fail(); // Only direct declaration exports have qualified binding ownership.
      if (ts.isImportDeclaration(node)) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) return fail();
        dependency(node.moduleSpecifier.text);
      }
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(module.source) === "process" && node.name.text === "argv"
        && !(ts.isElementAccessExpression(node.parent) && node.parent.expression === node)
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && node.parent.name.text === "length")) return fail();
      if (ts.isComputedPropertyName(node)) return fail();
      if (ts.isStringLiteral(node) && OPAQUE_NAMES.has(node.text)) {
        const parent = node.parent;
        if (ts.isBindingElement(parent) && parent.propertyName === node
          || ts.isImportSpecifier(parent) && parent.propertyName === node
          || (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
            || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node) return fail();
      }
      if (ts.isIdentifier(node) && OPAQUE_NAMES.has(node.text)
        && !(node.text === "URL" && ts.isNewExpression(node.parent) && node.parent.expression === node)) return fail();
      if (ts.isIdentifier(node) && node.text === "process"
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && ["argv", "env", "exit", "exitCode", "stdout", "stderr"].includes(node.parent.name.text))) return fail();
      // Computed property names can hide loaders/constructors or mutator methods.
      // Only numeric reads and finite immutable dictionary keys are qualified.
      if (ts.isElementAccessExpression(node) && !this.computedRead(module, node)) return fail();
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return fail();
      if (ts.isNewExpression(node) && !fileUrl(node) && node.arguments?.some(argument => argument.getText(module.source) === "import.meta.url")) return fail();
      if (ts.isNewExpression(node) && fileUrl(node)) {
        if (module.bindings.has("URL") || module.writes.has("URL") || node.arguments?.length !== 2 || node.arguments[1]!.getText(module.source) !== "import.meta.url") return fail();
        const target = this.value(node.arguments[0]!, path); if (typeof target !== "string") return fail(); resource(target);
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        // Root-owned paths in exported data (for example readingTemplates) are
        // supporting resources too. Regexes/comments are not string literals.
        if (ROOT.test(node.text) && FILE.test(node.text)
          && !(ts.isNewExpression(node.parent) && fileUrl(node.parent) && node.parent.arguments?.[0] === node)) resource(node.text, true);
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
          this.stable(module, ts.isIdentifier(node.expression) ? node.expression.text : (node.expression as TS.PropertyAccessExpression).expression.getText(module.source), false);
          const name = ts.isIdentifier(node.expression) ? module.fs.get(node.expression.text)! : (node.expression as TS.PropertyAccessExpression).name.text;
          // Configuration helpers are captured as inert code, not executed.
          // Directory enumeration and computed config paths cannot prove closure.
          if (!/^(?:readFile|readFileSync|stat|statSync|lstat|lstatSync|access|accessSync|existsSync)$/.test(name)) return fail();
          const argument = node.arguments[0]; if (!argument) return fail();
          if (!(ts.isNewExpression(argument) && fileUrl(argument))) {
            const value = this.value(argument, path);
            if (typeof value === "object" && !Array.isArray(value) && value.external) { /* explicit caller input, not configuration */ }
            else return fail(); // Filesystem strings use runtime CWD, not import.meta.url.
          }
        }
      }
      ts.forEachChild(node, child => { pending.push(child); });
    }
    // A selector array is shared by every named importer, not just the module
    // that used it in a URL. Recheck known importers after each graph expansion;
    // this rejects mutation/escape regardless of dependency traversal order.
    for (const owner of this.modules.values()) for (const [local, imported] of owner.imports) {
      if (this.modules.get(imported.path)?.stableArrays.has(imported.name)) this.stable(owner, local, true);
    }
    return [...resources];
  }
}
