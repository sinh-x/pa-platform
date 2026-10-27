import assert from 'node:assert/strict';
import test from 'node:test';
import { manualIntegration, partitionTests } from './run-code-tests.mjs';

test('code-only inventory explicitly accounts for manual integration and includes new code tests', () => {
  const manual = Object.keys(manualIntegration);
  const selected = partitionTests([...manual, 'src/a.test.ts', 'src/new.test.ts', 'src/a.test.ts']);
  assert.deepEqual(selected.code, ['src/a.test.ts', 'src/new.test.ts']);
  assert.deepEqual(selected.manual, [...manual].sort());
  assert.equal(selected.code.length + selected.manual.length, manual.length + 2);
});
test('stale manual inventory fails instead of silently omitting coverage', () => {
  assert.throws(() => partitionTests(['src/a.test.ts']), /Manual integration entry no longer exists/);
});
