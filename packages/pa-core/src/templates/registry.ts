import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformHomeDir, getTeamsDir } from "../paths.js";
import { readReviewEvidenceFile } from "../validation/review-contract.js";
import { digest, MAX_TEMPLATE_BYTES, parseTemplateRegistry, reject, TemplateError, utf8, type TemplateRegistry } from "./schema.js";

/** Host-owned selection. Never accepted from a CLI/tool request or template. A
 * qualification harness may supply a disposable content-addressed selection. */
export interface TemplateSelection { root: string; configRevision: string; registrySha256: string }
export interface LoadedTemplates { registry: TemplateRegistry; identity: TemplateSelection; sources: ReadonlyMap<string, { raw: string; body: string }> }
function read(path: string, limit = MAX_TEMPLATE_BYTES, immutableRuntimePin = false): Uint8Array {
  try {
    const before = lstatSync(path);
    if (before.nlink !== 1 && !immutableRuntimePin) reject("TEMPLATE_PATH", "resource", "hard-linked resources are unsupported");
    return readReviewEvidenceFile(path, limit, "template.resource");
  } catch (error) { if (error instanceof TemplateError) throw error; return reject("TEMPLATE_IO", "resource", "selected regular unaliased resource is missing, changed or unreadable"); }
}
/** Bounded metadata observation only: no Git process, hooks, object evaluation,
 * index refresh or network. Relevant registry/resource bytes are independently
 * pinned below, including staged/unstaged substitutions and inventory additions. */
export function selectedConfigHead(root: string): string {
  try {
    if (realpathSync(root) !== root || resolve(root) !== root) reject("TEMPLATE_PAIR", "selection", "physical selected config root required");
    const marker = join(root, ".git"), stat = lstatSync(marker);
    let gitDir = marker, commonDir = marker;
    if (stat.isFile()) {
      const match = /^gitdir: (\/[^\r\n]+)\n?$/.exec(utf8(read(marker, 4096)));
      if (!match || resolve(match[1]!) !== match[1]) reject("TEMPLATE_PAIR", "selection", "exact physical Git worktree metadata required");
      gitDir = match[1]!;
      if (!/\/worktrees\/[^/]+$/.test(gitDir) || utf8(read(join(gitDir, "commondir"), 128)).trimEnd() !== "../..") reject("TEMPLATE_PAIR", "selection", "unsupported Git common-directory metadata");
      commonDir = dirname(dirname(gitDir));
      if (utf8(read(join(gitDir, "gitdir"), 4096)).trimEnd() !== marker) reject("TEMPLATE_PAIR", "selection", "Git worktree metadata does not bind the selected physical root");
    } else if (!stat.isDirectory() || stat.isSymbolicLink()) reject("TEMPLATE_PAIR", "selection", "selected config must be versioned");
    if (realpathSync(gitDir) !== gitDir || realpathSync(commonDir) !== commonDir) reject("TEMPLATE_PAIR", "selection", "Git metadata aliases are unsupported");
    const head = utf8(read(join(gitDir, "HEAD"), 4096)).trimEnd();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref: (refs\/heads\/[A-Za-z0-9_./-]+)$/.exec(head)?.[1];
    if (!ref || ref.split("/").some(part => !part || part === "." || part === "..") || ref.includes("..")) reject("TEMPLATE_PAIR", "selection", "unsupported selected HEAD grammar");
    const refPath = join(commonDir, ref);
    let exists = false;
    try { lstatSync(refPath); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (exists) {
      const value = utf8(read(refPath, 128)).trimEnd();
      if (!/^[0-9a-f]{40}$/.test(value)) reject("TEMPLATE_PAIR", "selection", "unsupported selected ref grammar");
      return value;
    }
    const matches = utf8(read(join(commonDir, "packed-refs"))).split("\n").filter(line => line.endsWith(` ${ref}`));
    if (matches.length !== 1 || !new RegExp(`^[0-9a-f]{40} ${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(matches[0]!)) reject("TEMPLATE_PAIR", "selection", "selected packed ref is missing or ambiguous");
    return matches[0]!.slice(0, 40);
  } catch (error) { if (error instanceof TemplateError) throw error; return reject("TEMPLATE_PAIR", "selection", "selected config Git identity cannot be proved"); }
}
/** Runtime-owned pins are deliberately absent until separately scoped companion
 * integration. No newest checkout, PA_CONFIG, caller hash or bundled prose fallback. */
export function selectedTemplates(): TemplateSelection {
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  // Nix store optimisation legitimately hard-links immutable package metadata.
  // This exception is fixed to runtime-owned pins, never template resources.
  const immutablePins = /^\/nix\/store\/[a-z0-9]{32}-[^/]+\/share\/pa-platform$/.test(runtimeRoot);
  const configRevision = utf8(read(join(runtimeRoot, ".pa-platform-config.sha"), 41, immutablePins)).trimEnd();
  const registrySha256 = utf8(read(join(runtimeRoot, ".pa-template-registry.sha"), 65, immutablePins)).trimEnd();
  if (!/^[0-9a-f]{40}$/.test(configRevision) || !/^[0-9a-f]{64}$/.test(registrySha256)) reject("TEMPLATE_PAIR", "selection", "exact runtime-owned config and registry pins required");
  const root = getPlatformHomeDir();
  try {
    if (getTeamsDir() !== join(root, "teams") || realpathSync(getTeamsDir()) !== getTeamsDir() || selectedConfigHead(root) !== configRevision) reject("TEMPLATE_PAIR", "selection", "selected physical config/team root and Git HEAD must match the runtime pin");
  } catch (error) {
    if (error instanceof TemplateError) throw error;
    reject("TEMPLATE_PAIR", "selection", "selected physical config/team identity cannot be proved");
  }
  return { root, configRevision, registrySha256 };
}
export function loadTemplateRegistry(selection?: TemplateSelection): LoadedTemplates {
  const observeSelection = selection === undefined;
  selection ??= selectedTemplates();
  try {
    if (!/^[0-9a-f]{40}$/.test(selection.configRevision) || !/^[0-9a-f]{64}$/.test(selection.registrySha256)
      || !selection.root.startsWith("/") || resolve(selection.root) !== selection.root || realpathSync(selection.root) !== selection.root || !lstatSync(selection.root).isDirectory()) reject("TEMPLATE_PAIR", "selection", "exact physical selected root and content pins required");
    const fingerprints = new Map<string, string>();
    const fingerprint = (path: string): string => { const s = lstatSync(path, { bigint: true }); return [s.dev, s.ino, s.size, s.mode, s.mtimeNs, s.ctimeNs, s.nlink].join(":"); };
    const resource = (path: string): Uint8Array => {
      const before = fingerprint(path), bytes = read(path), after = fingerprint(path);
      if (before !== after) reject("TEMPLATE_IO", "resource", "selected resource changed during observation");
      fingerprints.set(path, after); return bytes;
    };
    const bytes = resource(join(selection.root, "contracts/templates-v1.json"));
    if (digest(bytes) !== selection.registrySha256) reject("TEMPLATE_PAIR", "registry", "selected registry raw digest differs from runtime pin");
    const registry = parseTemplateRegistry(bytes);
    // A committed registry cannot contain its own commit SHA. The explicit
    // `selected` selector binds the externally authenticated runtime pin; it is
    // not filesystem discovery or a newest-revision fallback.
    if (registry.configRevision !== "selected" && registry.configRevision !== selection.configRevision) reject("TEMPLATE_PAIR", "registry", "selected config revision differs from runtime pin");
    registry.configRevision = selection.configRevision;
    const sources = new Map<string, { raw: string; body: string }>(), identities = new Map<string, string>();
    for (const entry of registry.entries) {
      if (identities.has(entry.source.path) && identities.get(entry.source.path) !== entry.source.sha256) reject("TEMPLATE_DIGEST", "registry", "one shared source path must identify exactly one raw digest");
      identities.set(entry.source.path, entry.source.sha256);
      const path = join(selection.root, entry.source.path);
      const bytes = resource(path);
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
    if (files.length > 128 || files.length !== declared.size || files.some((file) => !file.isFile() || !declared.has(`skills/templates/${file.name}`))) reject("TEMPLATE_INVENTORY", "inventory", "canonical family contains an undeclared or nonregular standard");
    for (const [path, original] of fingerprints) if (fingerprint(path) !== original || realpathSync(path) !== path) reject("TEMPLATE_IO", "resource", "selected source set changed before the result was available");
    if (observeSelection && (getPlatformHomeDir() !== selection.root || getTeamsDir() !== join(selection.root, "teams") || selectedConfigHead(selection.root) !== selection.configRevision)) reject("TEMPLATE_PAIR", "selection", "selected config identity changed during template observation");
    return { registry, identity: { ...selection }, sources };
  } catch (error) { if (error instanceof TemplateError) throw error; return reject("TEMPLATE_IO", "selection", "cannot authenticate selected template resources; no fallback is permitted"); }
}
