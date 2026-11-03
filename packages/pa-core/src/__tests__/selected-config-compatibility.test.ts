import assert from "node:assert/strict";
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommittedConfigSource, SelectedConfigError } from "../selected-config-source.js";
import { loadTemplateRegistry, selectedTemplates } from "../templates/registry.js";
import { digest, TemplateError } from "../templates/schema.js";
import { templateService } from "../templates/service.js";
import { loadSelectedWorkflows } from "../workflows/selected.js";
import { committedConfigFixture } from "./committed-config-fixture.js";

test("one runtime supports multiple committed compatible config and registry revisions without package-pin edits", () => {
  const f = committedConfigFixture(); try {
    const initial = selectedTemplates(), loaded = loadTemplateRegistry();
    assert.equal(initial.configRevision, f.revision); assert.equal(loaded.registry.entries.length, 17);
    assert.equal(loadSelectedWorkflows().configRevision, f.revision);
    f.write("docs/new-compatible-guide.md", "# Unrelated compatible addition\n");
    const second = f.commit(); assert.notEqual(second, initial.configRevision);
    assert.equal(selectedTemplates().configRevision, second);
    assert.equal(templateService('{"action":"list"}').ok, true);
    const entry = f.registry.entries.find(entry => entry.id === "review-bundle")!;
    f.write(entry.source.path, "{{bundle}}\n\n"); entry.source.sha256 = digest("{{bundle}}\n\n");
    const third = f.commit(), current = loadTemplateRegistry();
    assert.equal(current.identity.configRevision, third); assert.notEqual(current.identity.registrySha256, initial.registrySha256);
    assert.equal(current.sources.get("review-bundle")!.raw, "{{bundle}}\n\n");
    assert.equal(loadSelectedWorkflows().configRevision, third);
    assert.throws(() => CommittedConfigSource.at(f.root, initial.configRevision), SelectedConfigError);
  } finally { f.close(); }
});

for (const variant of ["dirty-registry", "self-consistent-dirty-resource", "untracked-resource", "symlink", "hardlink", "wrong-team", "root-alias", "unsupported-registry", "unsupported-workflow"] as const) {
  test(`coherent selection rejects ${variant} without fallback or leaking resource bytes`, () => {
    const f = committedConfigFixture(); try {
      const entry = f.registry.entries.find(entry => entry.id === "review-bundle")!, path = join(f.root, entry.source.path);
      if (variant === "dirty-registry") appendFileSync(join(f.root, "contracts/templates-v1.json"), " ");
      if (variant === "self-consistent-dirty-resource") { f.write(entry.source.path, "PRIVATE-SENTINEL"); entry.source.sha256 = digest("PRIVATE-SENTINEL"); f.save(); }
      if (variant === "untracked-resource") { f.write("skills/templates/foreign.md", "PRIVATE-SENTINEL"); }
      if (variant === "symlink") { rmSync(path); symlinkSync(join(f.root, "docs/common.md"), path); }
      if (variant === "hardlink") { rmSync(path); linkSync(join(f.root, "docs/common.md"), path); }
      if (variant === "wrong-team") process.env.PA_PLATFORM_TEAMS = f.root;
      if (variant === "root-alias") { const alias = `${f.root}-alias`; symlinkSync(f.root, alias); process.env.PA_PLATFORM_HOME = alias; try { assert.throws(() => loadTemplateRegistry(), TemplateError); } finally { rmSync(alias); } return; }
      if (variant === "unsupported-registry") { Object.assign(f.registry, { runtimeContract: "pa-template-runtime/future" }); f.commit(); }
      if (variant === "unsupported-workflow") {
        const d = structuredClone(f.workflow); d.steps[0]!.operation.id = "shell.exec";
        const raw = JSON.stringify(d), manifestPath = join(f.root, "workflows/manifest.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.definitions[0].sha256 = digest(raw); f.write("workflows/definitions/software.json", raw); f.write("workflows/manifest.json", JSON.stringify(manifest)); f.commit();
        assert.throws(() => loadSelectedWorkflows(), /WORKFLOW_SOURCE/); return;
      }
      assert.throws(() => loadTemplateRegistry(), error => error instanceof TemplateError && !error.message.includes("PRIVATE-SENTINEL"));
      assert.equal(templateService('{"action":"list"}').ok, false);
    } finally { f.close(); }
  });
}

test("source closure rejects mid-read revision/byte drift and does not expose mutable cached content", () => {
  const f = committedConfigFixture(); try {
    const source = CommittedConfigSource.selected(), first = source.read("docs/common.md")!;
    first[0] = 0; assert.equal(Buffer.from(source.read("docs/common.md")!).toString(), "# Shared guide\nNo execution authority.\n");
    f.write("docs/common.md", "changed\n"); f.write("docs/common.md", "# Shared guide\nNo execution authority.\n");
    assert.throws(() => source.assertCurrent(), SelectedConfigError);
    const another = CommittedConfigSource.selected(); another.read("docs/common.md");
    f.write("docs/next.md", "new committed revision\n"); f.commit();
    assert.throws(() => another.assertCurrent(), SelectedConfigError);
  } finally { f.close(); }
});

test("missing optional manifests are observations, but inserted files and alias parents invalidate them", () => {
  const f = committedConfigFixture(); try {
    const source = CommittedConfigSource.selected(); assert.equal(source.read("future/optional.json", true), null);
    mkdirSync(join(f.root, "future")); f.write("future/optional.json", "{}");
    assert.throws(() => source.assertCurrent(), SelectedConfigError);
    rmSync(join(f.root, "future"), { recursive: true }); symlinkSync(join(f.root, "docs"), join(f.root, "future"));
    assert.throws(() => CommittedConfigSource.selected().read("future/optional.json", true), SelectedConfigError);
  } finally { f.close(); }
});

test("committed source reads do not run selected Git monitors, hooks, replacements or ambient Git configuration", () => {
  const f = committedConfigFixture(); try {
    const marker = `${f.root}-monitor`, script = join(f.root, "monitor.sh");
    writeFileSync(script, `#!/bin/sh\nprintf forbidden > '${marker}'\n`, { mode: 0o700 });
    f.git("config", "core.fsmonitor", script); f.git("config", "core.hooksPath", f.root);
    process.env.GIT_CONFIG_COUNT = "1"; process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor"; process.env.GIT_CONFIG_VALUE_0 = script;
    const loaded = loadTemplateRegistry(); assert.equal(loaded.registry.entries.length, 17);
    assert.equal(existsSync(marker), false);
    const source = CommittedConfigSource.selected(); source.read("docs/common.md"); source.assertCurrent();
    assert.equal(existsSync(marker), false);
  } finally { f.close(); }
});
