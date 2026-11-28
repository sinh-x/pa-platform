// Reading summary only: GitHub step outcomes remain the check authority.
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const stages = Object.freeze([
  ['checkout', 'Repository checkout', 'Infrastructure'],
  ['fish-provision', 'Pinned fish provisioning', 'Infrastructure'],
  ['pnpm', 'pnpm setup', 'Infrastructure'],
  ['node', 'Node/cache setup', 'Infrastructure'],
  ['versions', 'Tool version recording', 'Infrastructure'],
  ['extension-sources', 'Pinned extension sources', 'Source/config'],
  ['dependencies', 'Frozen dependency installation', 'Dependency setup'],
  ['typecheck', 'Typecheck', 'Source'],
  ['build', 'Build', 'Source'],
  ['pairing-fixtures', 'Repository pairing/config-first fixtures', 'Source/config'],
  ['generated-completions', 'Generated completion diff', 'Source/completions'],
  ['fish-syntax', 'Actual fish syntax', 'Source/completions'],
  ['fish-timing', 'Actual fish timing', 'Source/completions'],
  ['code-tests', 'Code-only tests', 'Source'],
  ['manual-boundary', 'Manual boundary notice (not qualification)', 'Information'],
]);
const safe = value => String(value || 'unavailable').replace(/[^a-zA-Z0-9_./:@+ -]/g, '?').slice(0, 300);
const outcome = value => ['success', 'failure', 'skipped', 'cancelled'].includes(value) ? value : 'unverified';

export function renderSummary(env, steps, checkoutSha) {
  const lines = [
    '## Exact hosted check delivery',
    '',
    `Event: ${safe(env.GITHUB_EVENT_NAME)}; run: ${safe(env.GITHUB_RUN_ID)}; attempt: ${safe(env.GITHUB_RUN_ATTEMPT)}.`,
    `Head SHA: ${safe(env.CI_HEAD_SHA)}; base SHA: ${safe(env.CI_BASE_SHA)}.`,
    `Event SHA (PR merge ref for pull_request): ${safe(env.GITHUB_SHA)}; checked-out SHA: ${safe(checkoutSha)}.`,
    `Job state before summary: ${safe(env.CI_JOB_STATUS)}.`,
    '',
    '| Stage | Category | Actual step outcome |',
    '| --- | --- | --- |',
    ...stages.map(([id, label, category]) => `| ${label} | ${category} | ${outcome(steps[id]?.outcome)} |`),
    '',
    'Failure is not success. Skipped, cancelled, missing and timed-out checks are not verified. A setup failure does not prove a source defect, and a later source pass does not erase a provisioning failure.',
    'Named step logs and GitHub job timings retain stage durations, provisioning attempt exits and exact tool versions. See docs/ci-reliability.md for diagnosis and merge policy.',
    'Hosted code-only success is not full local, selected-config, Nix packaging, installed-runtime or human-UAT qualification.',
  ];
  return lines.join('\n') + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const steps = JSON.parse(process.env.CI_STEPS || '{}');
  const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const summary = renderSummary(process.env, steps, checkoutSha);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);
}
