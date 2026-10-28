import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformHomeDir } from "../paths.js";
import { readReviewEvidenceFile } from "../validation/review-contract.js";
import { digest, MAX_TEMPLATE_BYTES, parseTemplateRegistry, reject, TemplateError, utf8, type TemplateRegistry } from "./schema.js";

/** Host-owned selection. Never accepted from a CLI/tool request or template. A
 * qualification harness may supply a disposable content-addressed selection. */
export interface TemplateSelection { root: string; configRevision: string; registrySha256: string }
export interface LoadedTemplates { registry: TemplateRegistry; identity: TemplateSelection; sources: ReadonlyMap<string, { raw: string; body: string }> }
function read(path: string, limit = MAX_TEMPLATE_BYTES): Uint8Array {
  try {
    const before = lstatSync(path);
    if (before.nlink !== 1) reject("TEMPLATE_PATH", "resource", "hard-linked resources are unsupported");
    return readReviewEvidenceFile(path, limit, "template.resource");
  } catch (error) { if (error instanceof TemplateError) throw error; return reject("TEMPLATE_IO", "resource", "selected regular unaliased resource is missing, changed or unreadable"); }
}
/** Runtime-owned pins are deliberately absent until separately scoped companion
 * integration. No newest checkout, PA_CONFIG, caller hash or bundled prose fallback. */
export function selectedTemplates(): TemplateSelection {
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const configRevision = utf8(read(join(runtimeRoot, ".pa-platform-config.sha"), 41)).trimEnd();
  const registrySha256 = utf8(read(join(runtimeRoot, ".pa-template-registry.sha"), 65)).trimEnd();
  if (!/^[0-9a-f]{40}$/.test(configRevision) || !/^[0-9a-f]{64}$/.test(registrySha256)) reject("TEMPLATE_PAIR", "selection", "exact runtime-owned config and registry pins required");
  return { root: getPlatformHomeDir(), configRevision, registrySha256 };
}
export function loadTemplateRegistry(selection: TemplateSelection = selectedTemplates()): LoadedTemplates {
  try {
    if (!/^[0-9a-f]{40}$/.test(selection.configRevision) || !/^[0-9a-f]{64}$/.test(selection.registrySha256)
      || !selection.root.startsWith("/") || resolve(selection.root) !== selection.root || realpathSync(selection.root) !== selection.root || !lstatSync(selection.root).isDirectory()) reject("TEMPLATE_PAIR", "selection", "exact physical selected root and content pins required");
    const bytes = read(join(selection.root, "contracts/templates-v1.json"));
    if (digest(bytes) !== selection.registrySha256) reject("TEMPLATE_PAIR", "registry", "selected registry raw digest differs from runtime pin");
    const registry = parseTemplateRegistry(bytes);
    if (registry.configRevision !== selection.configRevision) reject("TEMPLATE_PAIR", "registry", "selected config revision differs from runtime pin");
    const sources = new Map<string, { raw: string; body: string }>();
    for (const entry of registry.entries) {
      const path = join(selection.root, entry.source.path);
      const bytes = read(path);
      if (digest(bytes) !== entry.source.sha256) reject("TEMPLATE_DIGEST", "resource", "raw source digest differs from selected registry");
      const raw = utf8(bytes); let body = raw;
      if (entry.source.selector) {
        const { start, end } = entry.source.selector;
        const first = raw.indexOf(start), last = raw.indexOf(end);
        if (first < 0 || last < first + start.length || raw.indexOf(start, first + start.length) !== -1 || raw.indexOf(end, last + end.length) !== -1) reject("TEMPLATE_SELECTOR", "resource", "one ordered exact delimiter pair required");
        body = raw.slice(first + start.length, last);
      }
      sources.set(entry.id, { raw, body });
    }
    // Directory enumeration is only a closure check, never discovery authority.
    const family = join(selection.root, "skills/templates");
    if (realpathSync(family) !== family) reject("TEMPLATE_PATH", "inventory", "canonical family must not be aliased");
    const declared = new Set(registry.entries.map((entry) => entry.source.path));
    const files = readdirSync(family, { withFileTypes: true });
    if (files.length > 128 || files.some((file) => !file.isFile() || !declared.has(`skills/templates/${file.name}`))) reject("TEMPLATE_INVENTORY", "inventory", "canonical family contains an undeclared or nonregular standard");
    return { registry, identity: { ...selection }, sources };
  } catch (error) { if (error instanceof TemplateError) throw error; return reject("TEMPLATE_IO", "selection", "cannot authenticate selected template resources; no fallback is permitted"); }
}
