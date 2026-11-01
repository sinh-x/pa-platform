import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigResource } from "../selected-config-source.js";
import type { TemplateSelection } from "../templates/registry.js";
import { loadTemplateRegistry } from "../templates/registry.js";
import { digest, type ReviewBundle } from "../workflows/contracts.js";
import type { WorkflowCaller } from "../workflows/service.js";
import type { WorkflowSelection } from "../workflows/selected.js";
import type { CapturedWorkflowResources, WorkflowResources } from "../workflows/resources.js";
import { templateFixture } from "./template-fixture.js";

let base: ConfigResource[] | undefined;
function templates(selection?: TemplateSelection): ConfigResource[] {
  if (!selection && base) return base;
  const fixture = selection ? undefined : templateFixture();
  try {
    if (fixture) {
      const entry = structuredClone(fixture.registry.entries[0]!); entry.id = "review-bundle";
      entry.source = { path: "skills/templates/review-bundle.md", sha256: digest("{{bundle}}\n"), selector: null };
      entry.bindings = { bundle: { type: "json", required: true } }; entry.validation = { kind: "review-bundle", sections: [] };
      fixture.registry.entries.push(entry); writeFileSync(join(fixture.root, entry.source.path), "{{bundle}}\n"); selection = fixture.save();
    }
    const loaded = loadTemplateRegistry(selection!);
    const result = ["contracts/templates-v1.json", ...new Set(loaded.registry.entries.map(entry => entry.source.path))].map(path => {
      const raw = readFileSync(join(selection!.root, path)); return { path, raw, sha256: digest(raw) };
    });
    if (fixture) base = result;
    return result;
  } finally { fixture?.dispose(); }
}
/** Explicit unsigned synthetic source owner for isolated state/native fixtures.
 * Production admissions register captureWorkflowResources instead. */
export function workflowResourceFixture(selection: WorkflowSelection, subject: ReviewBundle, caller: WorkflowCaller, templateSelection?: TemplateSelection): CapturedWorkflowResources {
  const files = new Map(templates(templateSelection).map(file => [file.path, { ...file, raw: Buffer.from(file.raw) }]));
  const put = (path: string, value: unknown) => { const raw = Buffer.from(typeof value === "string" ? value : JSON.stringify(value)); files.set(path, { path, raw, sha256: digest(raw) }); };
  const definitions = selection.definitions.map(row => {
    const file = `workflows/definitions/${row.definition.workflowId}.json`; put(file, row.raw instanceof Uint8Array ? Buffer.from(row.raw).toString() : row.raw);
    return { workflowId: row.definition.workflowId, version: row.definition.version, file, sha256: row.sha256 };
  });
  put("workflows/manifest.json", { schemaVersion: "pa-workflow-manifest/v1", definitions, bindings: selection.bindings });
  const consumers = selection.definitions.some(row => row.definition.steps.some(step => step.operation.id === "check.matrix")) ? [{ team: "requirements", mode: "review-auto" }] : [];
  const routes = [...new Map([{ team: caller.team, mode: caller.mode }, subject.route, ...consumers].map(route => [`${route.team}/${route.mode}`, route])).values()];
  for (const team of new Set(routes.map(route => route.team))) {
    const modes = routes.filter(route => route.team === team).map(route => ({ id: route.mode, label: route.mode, require_ticket: true }));
    put(`teams/${team}.yaml`, { name: team, description: "Synthetic retained team fixture", objective: "Synthetic fixture", agents: [], default_mode: modes[0]!.id, deploy_modes: modes });
  }
  const manifest: WorkflowResources = { schemaVersion: "pa-workflow-resources/v1", configRoot: selection.configRoot, configRevision: selection.configRevision, repositoryKey: subject.repository.key, workflowSha256: subject.workflow.sha256, registrySha256: files.get("contracts/templates-v1.json")!.sha256, routes, files: [...files.values()].map(({ path, sha256 }) => ({ path, sha256 })), absentReferences: [] };
  return { manifest: Buffer.from(JSON.stringify(manifest)), files: [...files.values()], assertCurrent() {} };
}
