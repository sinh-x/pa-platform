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

  assert.match(template, /> \*\*Version:\*\* 5\.0/);
  assert.match(template, /Repository Key: <repo_key>/);
  assert.match(template, /Repository Root: <canonical_repo_root>/);
  assert.match(template, /Worktree Root: <authenticated_worktree_root>/);
  assert.match(template, /Branch: <feature_branch>/);
  assert.match(template, /Current Git State: <branch or detached, full HEAD SHA, staged\/unstaged\/untracked status>/);
  assert.match(template, /Runtime path parity: <PA_REPO == CWD == Git top-level == memory execution root == registry start worktree_root>/);
});

test("orchestration report template preserves launch-completion bracketing", (t) => {
  const template = readTemplate(t);
  if (!template) return;

  assert.match(template, /Phase <N> \(<scope>\) launched <deploy-id>/);
  assert.match(template, /Phase <N> \(<scope>\) completed <deploy-id> <status>/);
  assert.match(template, /Keep one durable launch\/completion bracket around every child deployment/);
  assert.match(template, /\| <phase> \| d-abc123 \| builder\/implement \| <full SHA or not-applicable> \| not-applicable \| success \| - \|/);
});

test("orchestration report template carries plan-first PPA branch resume evidence", (t) => {
  const template = readTemplate(t);
  if (!template) return;

  assert.match(template, /Branch-gate outcome: <PPA planned\/create or materialized\/select persisted result; or supported non-Treehouse outcome>/);
  assert.match(template, /persisted planned\/create or materialized\/select result and an already-current exact linked branch/);
  assert.match(template, /only the orchestrator may have performed that ordinary-Git action after authenticated evidence agreement/);
  assert.match(template, /OPA\/OpenCode and CPA\/Claude Code retain supported non-Treehouse exact-branch handling/);
  assert.match(template, /No path may stash, reset, repair, relocate, or substitute a checkout/);
});

test("orchestration report template requires feedback and report-only child evidence", (t) => {
  const template = readTemplate(t);
  if (!template) return;

  assert.match(template, /### Phase 5\.x Feedback Loop Evidence/);
  assert.match(template, /\| Iteration \| Feedback Source \| Objective Artifact \| Pre-Launch Confirmation \| Child Deploy \| Child Status \| Verification \| Confirmation \|/);
  assert.match(template, /Implement children report verification and commit evidence but never update ticket status or requirements checkboxes/);
  assert.match(template, /On terminal exit, write the session log before filling `### Session Log`/);
});
