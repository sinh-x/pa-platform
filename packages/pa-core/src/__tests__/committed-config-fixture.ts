import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { digest } from "../templates/schema.js";
import { bytes, definition } from "./workflow-fixtures.js";
import { templateFixture } from "./template-fixture.js";

/** Disposable committed source, never live config or human/native approval. */
export function committedConfigFixture() {
  const f = templateFixture(), originalEnv = process.env;
  const write = (path: string, content: string | Uint8Array) => { mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), content); };
  const git = (...args: string[]) => execFileSync("git", ["--no-pager", "--no-replace-objects", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", f.root, ...args], { env: { PATH: originalEnv.PATH, HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  f.registry.configRevision = "selected";
  const entry = structuredClone(f.registry.entries[0]!); entry.id = "review-bundle";
  entry.source = { path: "skills/templates/review-bundle.md", sha256: digest("{{bundle}}\n"), selector: null };
  entry.bindings = { bundle: { type: "json", required: true } }; entry.validation = { kind: "review-bundle", sections: [] };
  f.registry.entries.push(entry); write(entry.source.path, "{{bundle}}\n");
  write("teams/requirements.yaml", "name: requirements\ndescription: Synthetic committed analyst\nobjective: Synthetic\nagents:\n  - name: analyst\n    role: Analyst\n    instruction: skills/requirements/analyst.md\nglobal_docs: [docs/common.md]\ndeploy_modes:\n  - id: analyze\n    label: Analyze\n    objective: skills/requirements/analyze.md\n    skills:\n      - name: pa-startup\n        inject-as: reference\n");
  write("teams/builder.yaml", "name: builder\ndescription: Synthetic committed builder\nobjective: Synthetic\nagents:\n  - name: orchestrator\n    role: Builder\n    instruction: skills/builder/orchestrator.md\ndeploy_modes:\n  - id: orchestrator\n    label: Orchestrator\n    objective: skills/builder/objective.md\n    global_docs: [docs/common.md]\n    project_guides:\n      example: [docs/example.md]\n");
  for (const [path, body] of Object.entries({ "skills/requirements/analyst.md": "# Analyst\nRead [the shared guide](../../docs/common.md).\n", "skills/requirements/analyze.md": "# Analyze\nUse exact selected templates.\n", "skills/builder/orchestrator.md": "# Orchestrator\nDo only authorized work.\n", "skills/builder/objective.md": "# Build\nRetain the exact subject.\n", "skills/global/pa-startup/SKILL.md": "# Startup\nInspect current bulletins.\n", "docs/common.md": "# Shared guide\nNo execution authority.\n", "docs/example.md": "# Project guide\nProject-specific context only.\n" })) write(path, body);
  const workflow = definition(), raw = bytes(workflow);
  write("workflows/definitions/software.json", raw);
  write("workflows/manifest.json", JSON.stringify({ schemaVersion: "pa-workflow-manifest/v1", definitions: [{ workflowId: workflow.workflowId, version: workflow.version, file: "workflows/definitions/software.json", sha256: digest(raw) }], bindings: [{ schemaVersion: "pa-workflow-binding/v1", team: "requirements", mode: "analyze", enabled: true, workflowId: workflow.workflowId, workflowVersion: workflow.version }] }));
  const commit = () => { f.save(); git("add", "--", "."); git("-c", "user.name=Synthetic config fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Disposable compatible config"); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "develop"); const revision = commit();
  process.env = { ...originalEnv, PA_PLATFORM_HOME: f.root, PA_PLATFORM_TEAMS: join(f.root, "teams"), PA_PLATFORM_SKILLS: join(f.root, "skills/global"), PA_PLATFORM_CONFIG: join(f.root, "operator-config") };
  return { ...f, write, git, commit, revision, workflow, close: () => { process.env = originalEnv; f.dispose(); } };
}
