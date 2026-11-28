import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { load } from 'js-yaml';
import { codeOnlyEntries, discoverTests, manualIntegration, partitionTests } from './run_code_tests.mjs';
import { fastEntries, runDevelopFast, selectDevelopFast } from './run_develop_fast.mjs';

test('code-only inventory explicitly accounts for manual integration and includes new code tests', () => {
  const profile = manualIntegration['pi-pa'];
  const manual = Object.keys(profile);
  const selected = partitionTests([...manual, 'src/a.test.ts', 'src/new.test.ts', 'src/a.test.ts'], profile);
  assert.deepEqual(selected.code, ['src/a.test.ts', 'src/new.test.ts']);
  assert.deepEqual(selected.manual, [...manual].sort());
  assert.equal(selected.code.length + selected.manual.length, manual.length + 2);
});
test('ordinary CI has no Nix step and package builds are manual/release-only', () => {
  const root = new URL('../../', import.meta.url);
  const code = load(readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8'));
  const packaging = load(readFileSync(new URL('.github/workflows/nix-build.yml', root), 'utf8'));
  assert.doesNotMatch(JSON.stringify(code), /nix develop|nix build|nix-installer/);
  assert.equal(packaging.on.pull_request, undefined);
  assert.deepEqual(packaging.on.push.branches, ['main']);
  assert.ok(Object.hasOwn(packaging.on, 'workflow_dispatch'));
  const pkg = JSON.parse(readFileSync(new URL('packages/pi-pa/package.json', root), 'utf8'));
  assert.match(pkg.scripts.test, /isolated-test-env\.mjs -- corepack pnpm run test:run/);
  assert.match(pkg.scripts['test:source:run'], /src\/\*\*\/\*\.test\.ts/);
});

test('hosted CI checks only this repository and its owned fixtures without external configuration access', () => {
  const root = new URL('../../', import.meta.url);
  const workflow = load(readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8'));
  const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
  const checkouts = steps.filter(step => /^actions\/checkout@/.test(step.uses ?? ''));
  assert.equal(checkouts.length, 1, 'CI must check out only the current PAP repository');
  assert.equal(checkouts[0].with?.repository, undefined, 'the checkout must use the current repository');
  assert.doesNotMatch(JSON.stringify(workflow), /pa-platform-config|PA_PLATFORM_CONFIG_TOKEN|PA_PHASE5_CONFIG_ROOT|paired-config|verify:paired-config|--require-origin-develop/);
  const commands = steps.map(step => step.run ?? '').join('\n');
  for (const command of ['pnpm install --frozen-lockfile', 'pnpm run typecheck', 'pnpm run build', 'pnpm run test:code', 'pnpm run test:paired-gate', 'pnpm run completions']) {
    assert.ok(commands.includes(command), `repository-owned check removed: ${command}`);
  }
  assert.match(commands, /repository-owned fixtures/i);
  assert.match(commands, /operator-local configuration pairing.*separate/i);
});

test('workspace test gates build core once per invocation without omitting source or native setup', () => {
  const root = new URL('../../', import.meta.url);
  const pkg = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
  const scripts = pkg('package.json').scripts;
  const build = 'corepack pnpm --filter @pa-platform/pa-core build';
  for (const name of ['test:run', 'test:code:run']) {
    assert.ok(scripts[name].startsWith(`${build} && corepack pnpm run test:drivers:run && `));
    assert.equal(scripts[name].split(build).length, 2);
  }
  assert.match(scripts['test:drivers:run'], /^node --test (?:scripts\/dev\/[\w-]+\.test\.mjs ?)+$/);
  assert.match(scripts['test:run'], /-r --workspace-concurrency=1 test:source$/);
  for (const [name, lane] of [['pa-core', 'test:code'], ['opencode-pa', 'test:source'], ['pi-pa', 'test:code:source'], ['runtime-host', 'test:source']]) {
    assert.ok(scripts['test:code:run'].includes(`--filter @pa-platform/${name} ${lane}`));
    const child = pkg(`packages/${name}/package.json`).scripts;
    assert.match(child['test:source'], /isolated-test-env\.mjs -- /);
    if (name !== 'pa-core') assert.ok(child['test:run'].startsWith(`${build} && `), 'standalone test still builds its dependency');
    assert.ok(!child['test:source'].includes(build));
    if (name === 'pi-pa') {
      assert.ok(child['test:code:run'].startsWith(`${build} && `));
      for (const source of ['test:source:run', 'test:code:source:run']) {
        assert.ok(!child[source].includes(build));
        for (const required of ['validate-extension-sources.mjs', 'bundle-extension-sources.mjs', 'scripts/**/*.test.mjs', 'PI_PA_PLUGIN_SELECTION=']) assert.ok(child[source].includes(required));
      }
      assert.match(child['test:code:source:run'], /run_code_tests\.mjs pi-pa/);
    }
  }
});

test('develop-fast is an exact subset and leaves other code files in the full inventory', () => {
  for (const [name, entries] of Object.entries(fastEntries)) {
    const workspace = fileURLToPath(new URL(`../../packages/${name}`, import.meta.url));
    const files = [...discoverTests(workspace), 'src/new-test.test.ts'];
    const full = partitionTests(files, manualIntegration[name], codeOnlyEntries[name]);
    const fast = selectDevelopFast(name, files);
    assert.deepEqual(fast.selected, [...entries].sort());
    assert.deepEqual([...fast.selected, ...fast.deferred].sort(), full.code);
    assert.deepEqual(fast.manual, full.manual);
    assert.ok(fast.deferred.includes('src/new-test.test.ts'));
    assert.throws(() => selectDevelopFast(name, files, []), /Empty or duplicate/);
    assert.throws(() => selectDevelopFast(name, files, [entries[0], entries[0]]), /Empty or duplicate/);
    assert.throws(() => selectDevelopFast(name, files, [fast.manual[0]]), /not in the full code inventory/);
    assert.throws(() => selectDevelopFast(name, files.filter(path => path !== entries[0])), /not in the full code inventory/);
  }
  assert.throws(() => selectDevelopFast('unknown', []), /Unknown develop-fast workspace/);
  assert.ok(fastEntries['pi-pa'].includes(codeOnlyEntries['pi-pa']['src/__tests__/pi-workflow-runtime.test.ts']));
});

test('develop-fast inventory inspection runs nothing and rejects extra arguments', async () => {
  const lines = [];
  const run = () => assert.fail('inventory inspection must not invoke a command');
  const log = line => lines.push(line);
  assert.equal(await runDevelopFast(['--list'], { run, log }), 0);
  assert.match(lines.join('\n'), /pa-core: 7 selected; \d+ deferred to full code tests; 3 manual integration \(not run\)/);
  assert.match(lines.join('\n'), /pi-pa: 4 selected; \d+ deferred to full code tests; 7 manual integration \(not run\)/);
  assert.match(lines.at(-1), /no build or tests ran/);
  assert.equal(await runDevelopFast(['--list', 'unexpected'], { run, error: log }), 1);
  assert.match(lines.at(-1), /with no arguments to run/);
});

test('develop-fast builds first, uses shared drivers and runs the exact selected source tests serially', async () => {
  const calls = [];
  const log = () => {};
  assert.equal(await runDevelopFast([], { log, run: async (command, argv, { cwd }) => {
    assert.equal(command, 'corepack');
    calls.push({ argv, cwd });
    return { code: 0 };
  } }), 0);
  assert.deepEqual(calls.map(({ argv }) => argv.slice(0, 3)), [
    ['pnpm', 'run', 'build'], ['pnpm', 'run', 'test:drivers:run'], ['pnpm', 'exec', 'tsx'],
    ['pnpm', 'run', 'test:source:run'], ['pnpm', 'exec', 'tsx'], ['pnpm', 'exec', 'tsx'], ['pnpm', 'run', 'test:source:run'],
  ]);
  assert.deepEqual(calls[4].argv, ['pnpm', 'exec', 'tsx', '--test', 'scripts/**/*.test.mjs']);
  for (const [i, name] of [[2, 'pa-core'], [5, 'pi-pa']]) {
    assert.deepEqual(calls[i].argv.slice(3), ['--test', '--test-concurrency=1', ...[...fastEntries[name]].sort()]);
    assert.equal(calls[i].cwd, fileURLToPath(new URL(`../../packages/${name}`, import.meta.url)));
  }
  assert.equal(calls[3].cwd, fileURLToPath(new URL('../../packages/opencode-pa', import.meta.url)));
  assert.equal(calls[6].cwd, fileURLToPath(new URL('../../packages/runtime-host', import.meta.url)));
});

test('develop-fast stops on unavailable, failed or interrupted stages without claiming success', async () => {
  for (const [failAt, result, exit] of [
    [1, { code: 2 }, 2], [3, { interrupted: 'SIGINT', code: 0 }, 130],
    [4, { signal: 'SIGTERM', timedOut: true }, 1], [5, new Error('spawn failed'), 1],
  ]) {
    let calls = 0;
    const lines = [];
    const log = line => lines.push(line);
    assert.equal(await runDevelopFast([], { log, error: log, run: async () => {
      if (++calls !== failAt) return { code: 0 };
      if (result instanceof Error) throw result;
      return result;
    } }), exit);
    assert.equal(calls, failAt);
    assert.match(lines.at(-1), /later stages did not run/);
    assert.ok(!lines.some(line => line.startsWith('Selected stages completed')));
  }
});

test('stale manual inventory fails instead of silently omitting coverage', () => {
  assert.throws(() => partitionTests(['src/a.test.ts'], manualIntegration['pa-core']), /Manual integration entry no longer exists/);
});

test('mixed workflow suite keeps portable coverage without discovering it twice locally', () => {
  const manual = manualIntegration['pi-pa'], entries = codeOnlyEntries['pi-pa'];
  const full = 'src/__tests__/pi-workflow-runtime.test.ts', portable = entries[full];
  const selected = partitionTests([...Object.keys(manual), portable, 'src/new.test.ts', 'src/other-helper.ts'], manual, entries);
  assert.deepEqual(selected.code, [portable, 'src/new.test.ts']);
  assert.ok(selected.manual.includes(full));
  assert.ok(!portable.endsWith('.test.ts'));
  assert.throws(() => partitionTests(Object.keys(manual), manual, entries), /Code-only entry no longer exists/);
  assert.throws(() => partitionTests([full, portable], {}, entries), /no manual integration owner/);
  assert.throws(() => partitionTests([full, portable], { [full]: 'native' }, { [full]: full }), /non-discovered helper/);
  assert.throws(() => partitionTests([full, portable, 'src/another.test.ts'], { [full]: 'native', 'src/another.test.ts': 'native' }, { [full]: portable, 'src/another.test.ts': portable }), /Duplicate code-only entry/);
});

test('full local and installed workflow entry still registers all native groups unconditionally', () => {
  const root = new URL('../../packages/pi-pa/src/__tests__/', import.meta.url);
  const parse = path => ts.createSourceFile(path, readFileSync(new URL(path, root), 'utf8'), ts.ScriptTarget.Latest, true);
  const entry = parse('pi-workflow-runtime.test.ts'), code = parse('pi-workflow-code-cases.ts');
  const calls = statements => statements.filter(ts.isExpressionStatement).map(s => s.expression).filter(ts.isCallExpression);
  const nativeCalls = calls(entry.statements);
  assert.deepEqual(nativeCalls.map(c => c.expression.getText(entry)), ['registerWorkflowMatrixCases', ...Array(7).fill('test')]);
  assert.equal(calls(code.statements).filter(c => c.expression.getText(code) === 'test').length, 5);
  assert.equal(calls(code.statements).filter(c => c.expression.getText(code) === 'registerWorkflowMatrixCases').length, 0);
  assert.ok(entry.statements.some(s => ts.isImportDeclaration(s) && s.moduleSpecifier.text === './pi-workflow-code-cases.js'));
  assert.doesNotMatch(entry.getText(entry), /test\.(?:skip|todo)/);
  assert.doesNotMatch(code.getText(code), /test\.(?:skip|todo)|registerWorkflowMatrixCases/);
  const pkg = JSON.parse(readFileSync(new URL('../../packages/pi-pa/package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['test:source:run'], /tsx --test --test-concurrency=1 "src\/\*\*\/\*\.test\.ts"/);
  const config = JSON.parse(readFileSync(new URL('../../packages/pi-pa/tsconfig.json', import.meta.url), 'utf8'));
  assert.ok(config.exclude.includes('src/__tests__/pi-workflow-code-cases.ts'));
});

test('portable workflow entry runs with an untrusted Node path while native executable guard still rejects it', { timeout: 120000 }, () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), 'pap-ci-split-'));
  try {
    const node = join(scratch, 'node'), repo = join(scratch, 'repo'), config = join(scratch, 'config');
    copyFileSync(process.execPath, node); mkdirSync(repo); mkdirSync(config);
    const script = 'process.exit(0)\n', digest = raw => createHash('sha256').update(raw).digest('hex');
    writeFileSync(join(repo, 'check.cjs'), script);
    const manifest = JSON.stringify({ schemaVersion: 'project-command-contract/v1', effects: ['project-read', 'isolated-temp-write'], checks: [{ id: 'check', executable: node, argv: ['check.cjs'], environment: {}, readPaths: [], prerequisites: [{ path: 'check.cjs', sha256: digest(script) }], timeoutSeconds: 10, maximumOutputBytes: 1024 }] });
    writeFileSync(join(repo, 'checks.json'), manifest);
    writeFileSync(join(config, 'config.yaml'), JSON.stringify({ repos: { example: { path: repo, prefix: 'EX', projectCommands: { manifest: 'checks.json', sha256: digest(manifest) } } } }));
    const probe = `import assert from 'node:assert/strict'; import {ProjectCommandContract} from ${JSON.stringify(new URL('../../packages/pi-pa/src/project-command-contract.ts', import.meta.url).href)}; assert.throws(()=>ProjectCommandContract.inspect('example',${JSON.stringify(repo)}),/EXECUTION_PROJECT_PREREQUISITE/);`;
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const guard = spawnSync(node, ['--import=tsx', '--input-type=module', '--eval', probe], { cwd: root, env: { ...env, PA_PLATFORM_CONFIG: config }, encoding: 'utf8', timeout: 30000 });
    assert.equal(guard.status, 0, guard.stderr);
    const result = spawnSync(node, ['--import=tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', 'packages/pi-pa/src/__tests__/pi-workflow-code-cases.ts'], { cwd: root, env, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /# fail 0\b/); assert.match(result.stdout, /# skipped 0\b/);
    assert.doesNotMatch(result.stdout, /# Subtest: (?:check\.matrix|structured baseline drives actual materialization|foreground default launcher retains failed-check)/);
    const catalogue = spawnSync(node, ['--import=tsx', '--test', '--test-reporter=tap', 'packages/pi-pa/src/__tests__/project-command-source.test.ts'], { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(catalogue.status, 0, catalogue.stderr + catalogue.stdout);
    assert.match(catalogue.stdout, /# tests 7\b/); assert.match(catalogue.stdout, /# fail 0\b/); assert.match(catalogue.stdout, /# skipped 0\b/);
    assert.doesNotMatch(catalogue.stdout, /# Subtest: (?:a running legacy contract|legacy v1 remains exact)/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
