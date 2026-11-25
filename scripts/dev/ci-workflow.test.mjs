import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { renderSummary, stages } from './summarize-ci.mjs';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const workflow = load(read('.github/workflows/ci.yml'));
const job = workflow.jobs.test;
const steps = Object.fromEntries(job.steps.filter(s => s.id).map(s => [s.id, s]));
// Evaluate the actual small concurrency expressions in YAML, not a second policy.
const evaluate = (value, github) => value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => String(Function('github', `return (${expression});`)(github)));
const context = (event, pr, run) => ({ workflow: 'CI', event_name: event, event: { pull_request: pr ? { number: pr } : {} }, run_id: run });
const admitted = (event, branch, type) => workflow.on[event]?.branches.includes(branch) && (!workflow.on[event].types || workflow.on[event].types.includes(type));

test('event admission removes duplicate feature pushes, never omits a PR check by draft, fork or paths', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push']);
  for (const branch of ['main', 'develop']) {
    assert.equal(admitted('push', branch), true);
    for (const type of ['opened', 'synchronize', 'reopened', 'ready_for_review']) assert.equal(admitted('pull_request', branch, type), true);
  }
  assert.equal(admitted('push', 'feature/PAP-293-ci-reliability'), false);
  assert.equal(admitted('push', 'unrelated'), false);
  assert.equal(admitted('pull_request', 'unrelated', 'opened'), false);
  for (const config of Object.values(workflow.on)) {
    assert.equal(config.paths, undefined); assert.equal(config['paths-ignore'], undefined);
  }
  assert.equal(job.if, undefined);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(steps.checkout.with.ref, undefined, 'retain GitHub merge-ref checkout');
  assert.equal(steps.checkout.with['persist-credentials'], false);
});

test('only newer runs of the same PR share a cancellation key; push, PR and other workflows are isolated', () => {
  const key = ctx => evaluate(workflow.concurrency.group, ctx);
  const cancels = ctx => evaluate(workflow.concurrency['cancel-in-progress'], ctx) === 'true';
  const first = context('pull_request', 170, 100), update = context('pull_request', 170, 101);
  assert.equal(key(first), key(update)); assert.equal(cancels(update), true);
  assert.notEqual(key(first), key(context('pull_request', 171, 101)));
  assert.notEqual(key(first), key(context('push', undefined, 100)));
  assert.notEqual(key(context('push', undefined, 100)), key(context('push', undefined, 101)));
  assert.notEqual(key(first), key({ ...first, workflow: 'Version Bump' }));
  assert.equal(cancels(context('push', undefined, 100)), false);
});

test('all required checks have finite budgets, stable identity and no success-forcing skips', () => {
  assert.deepEqual(Object.keys(workflow.jobs), ['test']);
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job['timeout-minutes'], 45);
  for (const step of job.steps) {
    assert.ok(step['timeout-minutes'] > 0 && step['timeout-minutes'] <= 30);
    assert.equal(step['continue-on-error'], undefined);
    if (step.id !== 'manual-boundary' && step.name !== 'Summarize exact check delivery') assert.equal(step.if, undefined);
  }
  assert.equal(steps['manual-boundary'].if, 'always()');
  assert.equal(job.steps.at(-1).if, 'always()');
  assert.equal(job.steps.at(-1).env.CI_STEPS, '${{ toJSON(steps) }}');
  assert.equal(job.steps.at(-1).env.CI_HEAD_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.equal(job.steps.at(-1).env.CI_BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  assert.deepEqual(stages.map(([id]) => id), job.steps.filter(step => step.id).map(step => step.id));
  assert.equal(steps['fish-provision'].run, 'bash scripts/dev/provision-ci-fish.sh');
  assert.equal(steps['fish-provision']['timeout-minutes'], 8);
  assert.ok(job.steps.indexOf(steps['fish-provision']) < job.steps.indexOf(steps['code-tests']));
  for (const [id, command] of Object.entries({
    dependencies: 'pnpm install --frozen-lockfile', typecheck: 'pnpm run typecheck', build: 'pnpm run build',
    'code-tests': 'pnpm run test:code', 'pairing-fixtures': 'pnpm run test:paired-gate', 'fish-timing': 'pnpm run completions:timing',
  })) assert.equal(steps[id].run, command);
  assert.match(steps['generated-completions'].run, /pnpm run completions\ngit diff --exit-code -- completions\/pa-core.fish completions\/opa.fish completions\/ppa.fish/);
  assert.match(steps['fish-syntax'].run, /completions\/\{pa-core,opa,ppa\}.fish/);
  assert.match(steps['fish-syntax'].run, /fish --no-execute/);
  assert.equal(steps.node.with.cache, 'pnpm'); assert.equal(steps.node.with['node-version'], '22');
});

test('report preserves failure, skipped and cancelled outcomes and cannot certify missing checks', () => {
  const summary = renderSummary({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', CI_HEAD_SHA: 'head', CI_BASE_SHA: 'base', GITHUB_SHA: 'merge', CI_JOB_STATUS: 'failure' }, {
    checkout: { outcome: 'success' }, 'fish-provision': { outcome: 'failure', conclusion: 'success' },
    'fish-syntax': { outcome: 'skipped' }, 'fish-timing': { outcome: 'cancelled' },
  }, 'checkout');
  assert.match(summary, /Head SHA: head; base SHA: base/);
  assert.match(summary, /merge; checked-out SHA: checkout/);
  assert.match(summary, /attempt: 2/);
  assert.match(summary, /Pinned fish provisioning \| Infrastructure \| failure/);
  assert.match(summary, /Actual fish syntax \| Source\/completions \| skipped/);
  assert.match(summary, /Actual fish timing \| Source\/completions \| cancelled/);
  assert.match(summary, /Code-only tests \| Source \| unverified/);
  assert.match(summary, /not full local.*human-UAT qualification/);
  const hostile = renderSummary({ CI_HEAD_SHA: 'head\n| injected | `code`' }, {}, 'sha');
  assert.doesNotMatch(hostile, /\n\| injected|`code`/);
});

test('version bump keeps merged-develop admission, serialization and exact rerun guards', () => {
  const bump = load(read('.github/workflows/version-bump.yml'));
  assert.deepEqual(bump.on, { pull_request: { types: ['closed'], branches: ['develop'] } });
  assert.equal(bump.jobs['bump-patch'].if, 'github.event.pull_request.merged == true');
  assert.deepEqual(bump.jobs['bump-patch'].concurrency, { group: 'version-bump-develop', 'cancel-in-progress': false });
  const bumpSteps = bump.jobs['bump-patch'].steps;
  const guard = bumpSteps.find(step => step.id === 'rerun-guard');
  assert.equal(guard.env.PR_NUMBER, '${{ github.event.pull_request.number }}');
  assert.equal(guard.env.MERGE_SHA, '${{ github.event.pull_request.merge_commit_sha }}');
  assert.match(guard.run, /Version-Bump-Source: PR #\$\{PR_NUMBER\} \$\{MERGE_SHA\}/);
  assert.match(guard.run, /git log --fixed-strings/);
  for (const step of bumpSteps.filter(step => /Bump patch version|Commit and push/.test(step.name))) assert.equal(step.if, "steps.rerun-guard.outputs.should-bump == 'true'");
  const push = bumpSteps.find(step => step.name === 'Commit and push version bump');
  assert.match(push.run, /git add package.json packages\/pa-core\/package.json packages\/opencode-pa\/package.json packages\/pi-pa\/package.json\n/);
  assert.doesNotMatch(push.run, /git tag|--tags|flake.nix|pnpm-lock.yaml/);
});
