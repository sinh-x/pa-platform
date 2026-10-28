import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { readReviewEvidenceFile } from "../validation/review-contract.js";
import { array, digest, ID, literal, MAX_WORKFLOW_BYTES, object, parseWorkflowBinding, reject, relativePath, SHA256, strictJson, text, unique, type WorkflowBinding, type WorkflowDefinition } from "./contracts.js";
import { parseWorkflowDefinition } from "./definition.js";

export interface SelectedWorkflow {
  readonly definition: WorkflowDefinition; readonly raw: Uint8Array; readonly sha256: string;
  readonly configRoot: string; readonly configRevision: string; readonly manifestSha256: string;
}
export interface WorkflowSelection {
  readonly schemaVersion: "pa-workflow-selection/v1"; readonly configRoot: string; readonly configRevision: string;
  readonly manifestSha256: string | null; readonly bindings: readonly WorkflowBinding[]; readonly definitions: readonly SelectedWorkflow[];
}
/** Runtime dependency seam only; not exposed as a CLI/tool path or adoption override. */
export interface SelectedConfigReader {
  root(): string; revision(root: string): string; read(root: string, relative: string): Uint8Array | null;
}
function configGit(root: string, args: string[]): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", ["--no-replace-objects", "--no-optional-locks", "-C", root, ...args], { env, maxBuffer: MAX_WORKFLOW_BYTES + 1, stdio: ["ignore", "pipe", "ignore"] });
}
const selectedReader: SelectedConfigReader = {
  root: () => {
    const config = loadConfig(); const root = realpathSync(config.homeDir);
    if (realpathSync(config.teamsDir) !== join(root, "teams")) reject("WORKFLOW_SOURCE");
    return root;
  },
  revision: root => configGit(root, ["rev-parse", "HEAD"]).toString("utf8").trim(),
  read: (root, relative) => {
    const path = join(root, relative);
    if (!existsSync(path)) return null;
    const raw = readReviewEvidenceFile(path, MAX_WORKFLOW_BYTES, "workflow.selected");
    // Authority must be the selected revision's exact tracked bytes, not a dirty/untracked overlay.
    const committed = configGit(root, ["show", `HEAD:${relative}`]);
    if (digest(raw) !== digest(committed)) reject("WORKFLOW_SOURCE");
    return raw;
  },
};
/** Fixed selected PAPC manifest. Validation of an arbitrary local definition cannot call/adopt this loader. */
export function loadSelectedWorkflows(reader: SelectedConfigReader = selectedReader): WorkflowSelection {
  try {
    const root = reader.root(); const revision = text(reader.revision(root), /^[a-f0-9]{40}$/);
    const manifest = reader.read(root, "workflows/manifest.json");
    if (!manifest) return { schemaVersion: "pa-workflow-selection/v1", configRoot: root, configRevision: revision, manifestSha256: null, bindings: [], definitions: [] };
    const r = object(strictJson(manifest), ["schemaVersion", "definitions", "bindings"]);
    literal(r.schemaVersion, "pa-workflow-manifest/v1");
    const definitions = array(r.definitions, value => {
      const d = object(value, ["workflowId", "version", "file", "sha256"]);
      const file = relativePath(d.file); if (!file.startsWith("workflows/definitions/") || !file.endsWith(".json")) reject();
      const raw = reader.read(root, file); if (!raw || digest(raw) !== text(d.sha256, SHA256)) reject("WORKFLOW_SOURCE");
      const definition = parseWorkflowDefinition(raw);
      if (definition.workflowId !== text(d.workflowId, ID) || definition.version !== text(d.version, ID)) reject("WORKFLOW_SOURCE");
      return { definition, raw, sha256: digest(raw), configRoot: root, configRevision: revision, manifestSha256: digest(manifest) };
    });
    unique(definitions.map(d => `${d.definition.workflowId}/${d.definition.version}`));
    const bindings = array(r.bindings, parseWorkflowBinding); unique(bindings.map(b => `${b.team}/${b.mode}`));
    if (bindings.some(b => !definitions.some(d => d.definition.workflowId === b.workflowId && d.definition.version === b.workflowVersion))) reject("WORKFLOW_SOURCE");
    if (reader.revision(root) !== revision) reject("WORKFLOW_SOURCE");
    return { schemaVersion: "pa-workflow-selection/v1", configRoot: root, configRevision: revision, manifestSha256: digest(manifest), bindings, definitions };
  } catch { return reject("WORKFLOW_SOURCE"); }
}
export function selectNewWorkflow(selection: WorkflowSelection, team: string, mode: string): SelectedWorkflow {
  const binding = selection.bindings.find(b => b.team === team && b.mode === mode);
  if (!binding?.enabled) reject("WORKFLOW_DISABLED");
  const selected = selection.definitions.find(d => d.definition.workflowId === binding.workflowId && d.definition.version === binding.workflowVersion);
  if (!selected) reject("WORKFLOW_SOURCE");
  return selected;
}
