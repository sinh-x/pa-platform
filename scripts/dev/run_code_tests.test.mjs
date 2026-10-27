import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { manualIntegration, partitionTests } from './run_code_tests.mjs';

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
