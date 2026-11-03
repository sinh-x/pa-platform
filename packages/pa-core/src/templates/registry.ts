import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { readReviewEvidenceFile } from "../validation/review-contract.js";
import { CommittedConfigSource, configSourceHead, SelectedConfigError } from "../selected-config-source.js";
import { digest, MAX_TEMPLATE_BYTES, parseTemplateRegistry, reject, TemplateError, utf8, type TemplateRegistry } from "./schema.js";

/** Host-owned qualification seam only. No public request accepts selection identities. */
export interface TemplateSelection { root: string; configRevision: string; registrySha256: string }
export interface LoadedTemplates { registry: TemplateRegistry; identity: TemplateSelection; sources: ReadonlyMap<string, { raw: string; body: string }> }
function read(path: string, limit = MAX_TEMPLATE_BYTES): Uint8Array {
  try {
    if (lstatSync(path).nlink !== 1) reject("TEMPLATE_PATH", "resource", "hard-linked resources are unsupported");
    return readReviewEvidenceFile(path, limit, "template.resource");
  } catch (error) { if (error instanceof TemplateError) throw error; return reject("TEMPLATE_IO", "resource", "selected regular unaliased resource is missing, changed or unreadable"); }
}
function selectedFailure(error: unknown): never {
  if (error instanceof TemplateError) throw error;
  const kind = error instanceof SelectedConfigError ? error.kind : "identity";
  return reject(kind === "limit" ? "TEMPLATE_SIZE" : kind === "resource" ? "TEMPLATE_DIGEST" : "TEMPLATE_PAIR", "selected-config", "coherent committed physical selection and exact resource bytes are required; no fallback is permitted");
}
/** Compatibility export for existing callers; underlying metadata grammar is unchanged. */
export function selectedConfigHead(root: string): string { try { return configSourceHead(root); } catch (error) { return selectedFailure(error); } }
function observeSelection(): { source: CommittedConfigSource; identity: TemplateSelection } {
  try {
    const source = CommittedConfigSource.selected(), raw = source.read("contracts/templates-v1.json")!;
    const registry = parseTemplateRegistry(raw);
    if (registry.configRevision !== "selected" && registry.configRevision !== source.revision) reject("TEMPLATE_PAIR", "registry", "registry revision must bind the authenticated selected commit");
    source.assertCurrent();
    return { source, identity: { root: source.root, configRevision: source.revision, registrySha256: digest(raw) } };
  } catch (error) { return selectedFailure(error); }
}
/** Supported schemas/consumers, committed Git closure and exact physical selection
 * replace whole-package HEAD coupling. Package pins remain build provenance,
 * never an implicit latest-selection or runtime compatibility grant. */
export function selectedTemplates(): TemplateSelection { return observeSelection().identity; }
export function loadTemplateRegistry(selection?: TemplateSelection, retained?: ReadonlyMap<string, Uint8Array>): LoadedTemplates {
  if (retained && !selection) reject("TEMPLATE_PAIR", "retained", "retained resources require their original exact selection");
  let committed: CommittedConfigSource | undefined;
  if (!selection) { const observed = observeSelection(); committed = observed.source; selection = observed.identity; }
  try {
    if (!/^[0-9a-f]{40}$/.test(selection.configRevision) || !/^[0-9a-f]{64}$/.test(selection.registrySha256)
      || !selection.root.startsWith("/") || resolve(selection.root) !== selection.root || (!retained && (realpathSync(selection.root) !== selection.root || !lstatSync(selection.root).isDirectory()))) reject("TEMPLATE_PAIR", "selection", "exact physical selected root and content pins required");
    const fingerprints = new Map<string, string>();
    const fingerprint = (path: string): string => { const s = lstatSync(path, { bigint: true }); return [s.dev, s.ino, s.size, s.mode, s.mtimeNs, s.ctimeNs, s.nlink].join(":"); };
    const resource = (relative: string): Uint8Array => {
      if (retained) { const raw = retained.get(relative); if (!raw || raw.byteLength > MAX_TEMPLATE_BYTES) reject("TEMPLATE_IO", "retained", "exact retained resource is missing or oversized"); return Buffer.from(raw); }
      const path = join(selection.root, relative), before = fingerprint(path);
      const bytes = committed ? committed.read(relative)! : read(path), after = fingerprint(path);
      if (before !== after) reject("TEMPLATE_IO", "resource", "selected resource changed during observation");
      fingerprints.set(path, after); return bytes;
    };
    const bytes = resource("contracts/templates-v1.json");
    if (digest(bytes) !== selection.registrySha256) reject("TEMPLATE_PAIR", "registry", "selected registry raw digest differs from the observed identity");
    const registry = parseTemplateRegistry(bytes);
    if (registry.configRevision !== "selected" && registry.configRevision !== selection.configRevision) reject("TEMPLATE_PAIR", "registry", "registry revision differs from the exact selected identity");
    registry.configRevision = selection.configRevision;
    const sources = new Map<string, { raw: string; body: string }>(), identities = new Map<string, string>();
    for (const entry of registry.entries) {
      if (identities.has(entry.source.path) && identities.get(entry.source.path) !== entry.source.sha256) reject("TEMPLATE_DIGEST", "registry", "one shared source path must identify exactly one raw digest");
      identities.set(entry.source.path, entry.source.sha256);
      const bytes = resource(entry.source.path);
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
    const family = join(selection.root, "skills/templates");
    if (!retained && realpathSync(family) !== family) reject("TEMPLATE_PATH", "inventory", "canonical family must not be aliased");
    const declared = new Set(registry.entries.map(entry => entry.source.path));
    const files = retained ? [...retained.keys()].filter(path => path.startsWith("skills/templates/")) : readdirSync(family, { withFileTypes: true }).map(file => file.isFile() ? `skills/templates/${file.name}` : "unsupported");
    if (files.length > 128 || files.length !== declared.size || files.some(file => !declared.has(file))) reject("TEMPLATE_INVENTORY", "inventory", "canonical family contains an undeclared or nonregular standard");
    for (const [path, original] of fingerprints) if (fingerprint(path) !== original || realpathSync(path) !== path) reject("TEMPLATE_IO", "resource", "selected source set changed before the result was available");
    committed?.assertCurrent();
    return { registry, identity: { ...selection }, sources };
  } catch (error) {
    if (error instanceof SelectedConfigError) return selectedFailure(error);
    if (error instanceof TemplateError) throw error;
    return reject("TEMPLATE_IO", "selection", "cannot authenticate selected template resources; no fallback is permitted");
  }
}
