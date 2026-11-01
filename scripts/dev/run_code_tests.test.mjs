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
import { codeOnlyEntries, manualIntegration, partitionTests } from './run_code_tests.mjs';

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
  assert.match(pkg.scripts.test, /src\/\*\*\/\*\.test\.ts/);
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
  assert.equal(calls(code.statements).filter(c => c.expression.getText(code) === 'test').length, 4);
  assert.equal(calls(code.statements).filter(c => c.expression.getText(code) === 'registerWorkflowMatrixCases').length, 0);
  assert.ok(entry.statements.some(s => ts.isImportDeclaration(s) && s.moduleSpecifier.text === './pi-workflow-code-cases.js'));
  assert.doesNotMatch(entry.getText(entry), /test\.(?:skip|todo)/);
  assert.doesNotMatch(code.getText(code), /test\.(?:skip|todo)|registerWorkflowMatrixCases/);
  const pkg = JSON.parse(readFileSync(new URL('../../packages/pi-pa/package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.test, /tsx --test --test-concurrency=1 "src\/\*\*\/\*\.test\.ts"/);
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
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
