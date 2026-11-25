import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// No real package install, DNS request, endpoint or privileged command is used.
const transport = `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';
const name = basename(process.argv[1]), args = process.argv.slice(2), scenario = process.env.FISH_TEST_SCENARIO;
appendFileSync(process.env.FISH_TEST_LOG, JSON.stringify({name,args}) + '\\n');
const calls = readFileSync(process.env.FISH_TEST_LOG,'utf8').trim().split('\\n').map(JSON.parse);
const forward = argv => { const r = spawnSync(argv[0],argv.slice(1),{stdio:'inherit',env:process.env}); if(r.error) throw r.error; process.exit(r.status ?? 1); };
if (name === 'timeout') {
  if (scenario === 'deadline' && args.includes('90s')) process.exit(124);
  forward(args.slice(3));
} else if (name === 'sudo') {
  if (args[0] !== '-n') process.exit(99);
  forward(args.slice(1));
} else if (name === 'apt-get') {
  const update = args.at(-1) === 'update';
  const updates = calls.filter(c => c.name === name && c.args.at(-1) === 'update').length;
  if (scenario === 'dns' || (scenario === 'recover-update' && update && updates === 1)) {
    console.error('Temporary failure resolving the isolated package-source fixture'); process.exit(100);
  }
  if (!update && (scenario === 'unavailable-package' || (scenario === 'recover-install' && updates === 1))) process.exit(100);
} else if (name === 'dpkg-query') {
  if (scenario === 'query-failure') process.exit(2);
  console.log(scenario === 'wrong-package' ? '9.9.9\\n9.9.9' : '3.7.0-1\\n3.7.0-1');
} else if (name === 'fish') {
  if (scenario === 'runtime-failure') process.exit(2);
  console.log(scenario === 'wrong-runtime' ? 'fish, version 9.9.9' : 'fish, version 3.7.0');
} else if (name !== 'sleep') process.exit(99);
`;

function provision(scenario, withSummary = true) {
  const root = mkdtempSync(join(tmpdir(), 'pap-ci-fish-'));
  try {
    const executable = join(root, 'transport.mjs'), log = join(root, 'calls.jsonl'), summary = join(root, 'summary');
    writeFileSync(executable, transport); chmodSync(executable, 0o755); writeFileSync(log, '');
    for (const command of ['sudo', 'apt-get', 'timeout', 'sleep', 'dpkg-query', 'fish']) symlinkSync(executable, join(root, command));
    const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, FISH_TEST_LOG: log, FISH_TEST_SCENARIO: scenario };
    delete env.GITHUB_STEP_SUMMARY;
    if (withSummary) env.GITHUB_STEP_SUMMARY = summary;
    const result = spawnSync('bash', [fileURLToPath(new URL('./provision-ci-fish.sh', import.meta.url))], { env, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const output = result.stdout + result.stderr;
    return { status: result.status, calls, output, summary: withSummary ? readFileSync(summary, 'utf8') : '' };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const aptCalls = result => result.calls.filter(c => c.name === 'apt-get');

test('fish provisioning pins both packages, uses strict bounded authenticated apt and verifies actual fish', () => {
  const result = provision('success');
  assert.equal(result.status, 0, result.output);
  assert.equal(aptCalls(result).length, 2);
  for (const { args } of aptCalls(result)) {
    for (const option of ['APT::Update::Error-Mode=any', 'Acquire::Retries=0', 'Acquire::http::Timeout=15', 'Acquire::https::Timeout=15', 'DPkg::Lock::Timeout=15']) assert.ok(args.includes(option));
    assert.ok(!args.some(arg => /allow-unauthenticated|allow-insecure|fix-missing/.test(arg)));
  }
  const install = aptCalls(result)[1].args;
  for (const arg of ['install', '-y', '--no-install-recommends', 'fish=3.7.0-1', 'fish-common=3.7.0-1']) assert.ok(install.includes(arg));
  assert.equal(result.calls.some(c => c.name === 'sleep'), false);
  assert.deepEqual(result.calls.find(c => c.name === 'fish').args, ['--version']);
  assert.deepEqual(result.calls.find(c => c.name === 'dpkg-query').args, ['-W', '-f=${Version}\\n', 'fish', 'fish-common']);
  for (const call of result.calls.filter(c => c.name === 'timeout')) {
    assert.deepEqual(call.args.slice(0, 2), ['--signal=TERM', '--kill-after=5s']);
    assert.equal(call.args[2], call.args[3] === 'sudo' ? '90s' : '10s');
  }
  assert.match(result.summary, /succeeded on attempt 1\/2/);
  assert.match(result.summary, /Syntax and timing checks are still required/);
});

for (const scenario of ['recover-update', 'recover-install']) test(`fish provisioning permits exactly one unchanged-source recovery: ${scenario}`, () => {
  const result = provision(scenario);
  assert.equal(result.status, 0, result.output);
  assert.equal(aptCalls(result).length, scenario === 'recover-update' ? 3 : 4);
  assert.deepEqual(result.calls.filter(c => c.name === 'sleep').map(c => c.args), [['5']]);
  assert.match(result.summary, /succeeded on attempt 2\/2/);
  assert.match(result.output, /failed \(attempt 1\/2, exit 100\)/);
});

test('persistent isolated DNS failure fails after two updates without installing from stale indexes', () => {
  const result = provision('dns');
  assert.equal(result.status, 1);
  assert.equal(aptCalls(result).length, 2);
  assert.ok(aptCalls(result).every(c => c.args.at(-1) === 'update'));
  assert.match(result.output, /installation was not attempted/);
  assert.match(result.summary, /infrastructure provisioning failed.*both bounded apt attempts failed/);
  assert.doesNotMatch(result.summary, /succeeded/);
});

test('unavailable pinned package fails without fallback or an unbounded retry', () => {
  const result = provision('unavailable-package');
  assert.equal(result.status, 1);
  assert.equal(aptCalls(result).length, 4);
  assert.equal(result.calls.filter(c => c.name === 'sleep').length, 1);
  assert.equal(result.calls.filter(c => c.name === 'fish' || c.name === 'dpkg-query').length, 0);
});

test('deadline exhaustion is a failure, not a recovered or skipped completion pass', () => {
  const result = provision('deadline');
  assert.equal(result.status, 1);
  assert.equal(aptCalls(result).length, 0);
  assert.equal(result.calls.filter(c => c.name === 'timeout').length, 2);
  assert.match(result.output, /exit 124/);
  assert.match(result.summary, /Completion checks are not verified/);
});

for (const scenario of ['wrong-package', 'wrong-runtime', 'query-failure', 'runtime-failure']) test(`verification fails closed without retrying or trusting preinstalled tools: ${scenario}`, () => {
  const result = provision(scenario);
  assert.equal(result.status, 1);
  assert.equal(aptCalls(result).length, 2);
  assert.match(result.summary, /infrastructure provisioning failed/);
  assert.doesNotMatch(result.summary, /succeeded/);
});

test('helper works without a GitHub summary sink', () => {
  assert.equal(provision('success', false).status, 0);
});
