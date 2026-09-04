import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { join } from "node:path";

const configRoot = process.env["PA_PHASE5_CONFIG_ROOT"];
const templatePath = configRoot ? join(configRoot, "skills", "templates", "orchestration-report.md") : "";

function readTemplate(t: TestContext): string | undefined {
  if (!existsSync(templatePath)) {
    t.skip("external pa-platform-config fixture not available");
    return undefined;
  }
  return readFileSync(templatePath, "utf-8");
}

test("orchestration report template records exact registered identity and Git state", (t) => {
  const template = readTemplate(t);
  if (!template) return;

  assert.match(template, /> \*\*Version:\*\* 3\.0/);
  assert.match(template, /Repository Key: <repo_key>/);
  assert.match(template, /Repository Root: <repo_root>/);
  assert.match(template, /Branch: <feature_branch>/);
  assert.match(template, /Current Git State: <branch or detached, full HEAD SHA, staged\/unstaged\/untracked status>/);
  assert.match(template, /Runtime path parity: <repo_root == PA_REPO == CWD == Git top-level == every available memory root == registry start root>/);
});

test("orchestration report template preserves launch-completion bracketing", (t) => {
  const template = readTemplate(t);
  if (!template) return;

  assert.match(template, /Phase <N> \(<scope>\) launched <deploy-id>/);
  assert.match(template, /Phase <N> \(<scope>\) completed <deploy-id> <status>/);
  assert.match(template, /Keep one launch\/completion bracket around every child deployment/);
  assert.match(template, /\| <phase> \| d-abc123 \| builder\/implement \| success \| - \|/);
});

test("orchestration report template carries direct branch-gate resume evidence", (t) => {
  const template = readTemplate(t);
  if (!template) return;

  assert.match(template, /Branch-gate outcome: <proceed \| create \| check out, with observed branch\/status\/develop-origin parity>/);
  assert.match(template, /exact ticket branch proceeds/);
  assert.match(template, /zero-entry, origin-equal `develop` creates an absent exact branch or checks out an existing exact branch/);
  assert.match(template, /dirty or drifted `develop`, release\/unrelated branches, and detached HEAD stop unchanged/);
  assert.match(template, /without stash, reset, repair, or relocation/);
});

test("orchestration report template requires feedback and report-only child evidence", (t) => {
  const template = readTemplate(t);
  if (!template) return;

  assert.match(template, /### Phase 5\.x Feedback Loop Evidence/);
  assert.match(template, /\| Iteration \| Feedback Source \| Objective Artifact \| Pre-Launch Confirmation \| Child Deploy \| Child Status \| Verification \| Confirmation \|/);
  assert.match(template, /Implement children report verification and commit evidence but never update ticket status or requirements checkboxes/);
  assert.match(template, /On terminal exit, write the session log before filling `### Session Log`/);
});
