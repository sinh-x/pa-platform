import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventory } from './inventory_runtime_diagnostics.mjs';

test('candidate inventory covers throws, catches, owners, warnings and excludes upstream/tests without copying text', () => {
  const root = mkdtempSync(join(tmpdir(), 'diagnostic-inventory-'));
  try {
    const src = join(root, 'packages/example/src'); mkdirSync(src, { recursive: true });
    const code = 'class Fault extends Error {}\ntry { throw new Fault("private fixture"); } catch {}\nconsole.warn("private fixture");\nio.stderr("private fixture");\n';
    writeFileSync(join(src, 'owner.ts'), code);
    for (const dir of ['__tests__', 'vendor']) { mkdirSync(join(src, dir)); writeFileSync(join(src, dir, 'ignored.ts'), code); }
    const result = inventory(root);
    assert.equal(result.qualification, 'candidate-sites-only');
    for (const kind of ['error-owner', 'throw', 'catch-propagation', 'diagnostic-call', 'stderr']) assert.ok(result.sites.some(s => s.kind === kind));
    assert.ok(result.sites.every(s => s.file === 'packages/example/src/owner.ts' && s.disposition === 'needs-semantic-review'));
    assert.ok(!JSON.stringify(result).includes('private fixture'));
    assert.deepEqual(inventory(root), result);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
