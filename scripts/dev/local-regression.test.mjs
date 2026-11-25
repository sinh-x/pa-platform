import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manualIntegration, codeOnlyEntries } from './run_code_tests.mjs';
import { parseOptions, selectTests, selectionDigest } from './local-regression.mjs';
import report, { projectCase } from './local-test-reporter.mjs';

const cli = fileURLToPath(new URL('./local-regression.mjs', import.meta.url));
const files = [...Object.keys(manualIntegration['pi-pa']), ...Object.values(codeOnlyEntries['pi-pa']), 'src/__tests__/pi-todo.test.ts', 'src/new.test.ts'];

test('focused/code/full inventories account for every source entry without weakening native owners', () => {
  const options = parseOptions(['pi-pa', '--file', 'src/__tests__/pi-todo.test.ts']);
  const inventory = selectTests(files, options);
  assert.deepEqual(inventory.selected, ['src/__tests__/pi-todo.test.ts']);
  assert.ok(inventory.notSelected.includes('src/new.test.ts'));
  assert.ok(inventory.notSelected.includes('src/__tests__/pi-workflow-code-cases.ts'));
  assert.deepEqual(inventory.deferred, Object.keys(manualIntegration['pi-pa']).sort());
  assert.equal(new Set(Object.values(inventory).flat()).size, Object.values(inventory).flat().length);
  assert.throws(() => selectTests(files, parseOptions(['pi-pa', '--file', inventory.deferred[0]])), /absent from this lane/);
  const full = selectTests(files, parseOptions(['pi-pa', '--lane', 'full']));
  assert.equal(full.deferred.length, 0);
  assert.ok(full.selected.includes('src/__tests__/pi-workflow-runtime.test.ts'));
  assert.ok(!full.selected.includes('src/__tests__/pi-workflow-code-cases.ts'));
  assert.throws(() => selectTests(files.filter(path => path !== inventory.deferred[0]), options), /no longer exists/);
});

test('strict options reject traversal, controls, duplicates, empty and unbounded budgets', () => {
  for (const args of [[], ['foreign'], ['pi-pa', '--lane', 'unknown'], ['pi-pa', '--file', '../live.ts'], ['pi-pa', '--file', 'src/../live.test.ts'], ['pi-pa', '--file', 'src/live\n.test.ts'], ['pi-pa', '--file'], ['pi-pa', '--timeout-ms', '0'], ['pi-pa', '--budget-ms', 'Infinity'], ['pi-pa', '--budget-ms', '3600001'], ['pi-pa', '--list', '--list'], ['pi-pa', '--unknown'], ['pi-pa', '--file', 'src/a.test.ts', '--file', 'src/a.test.ts']]) assert.throws(() => parseOptions(args));
  assert.equal(parseOptions(['pa-core', '--timeout-ms', '120000', '--budget-ms', '600000']).timeoutMs, 120000);
});

test('selection identity changes with content, not just HEAD', t => {
  const root = mkdtempSync(join(tmpdir(), 'pa-input-digest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.test.ts'), 'first');
  const first = selectionDigest(root, ['src/a.test.ts']);
  writeFileSync(join(root, 'src/a.test.ts'), 'second');
  assert.notEqual(selectionDigest(root, ['src/a.test.ts']), first);
});

test('bounded event projection excludes names, stdout, exception bodies and hostile context', async () => {
  const hostile = 'synthetic-private-value\n\u001b[31m';
  const event = { type: 'test:fail', data: { name: hostile, file: hostile, line: 12, column: 3, details: { duration_ms: 12.3456, error: { message: hostile, stack: hostile } } } };
  assert.deepEqual(projectCase(event, 1), { event: 'case-end', case: 1, outcome: 'failed', line: 12, column: 3, durationMs: 12.346 });
  async function* events() {
    yield { type: 'test:stdout', data: { message: hostile } };
    yield { type: 'test:fail', data: { details: { type: 'suite' } } };
    for (let i = 0; i < 1000; i++) yield event;
    yield { type: 'test:pass', data: { skip: hostile } };
    yield { type: 'test:pass', data: { todo: hostile } };
    yield { type: 'test:fail', data: { details: { error: { failureType: 'cancelledByParent' } } } };
  }
  const lines = [];
  for await (const line of report(events())) lines.push(line);
  assert.equal(lines.length, 21);
  assert.doesNotMatch(lines.join(''), /synthetic-private-value|stdout|stack|message|name/);
  assert.ok(lines.every(line => Buffer.byteLength(line) <= 4096));
  const summary = JSON.parse(lines.at(-1));
  assert.deepEqual(summary.counts, { passed: 0, failed: 1000, skipped: 1, todo: 1, cancelled: 1 });
  assert.equal(summary.failureDetailsOmitted, 980);
  assert.equal(summary.slowest.length, 5);
});

function invoke(args, timeout = 30000) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } });
}
const records = result => result.stdout.trim().split('\n').map(line => JSON.parse(line));

test('actual local CLI lists without execution, rejects unknown files and renders a bounded plain blocker', () => {
  const listed = invoke(['pi-pa', '--file', 'src/__tests__/pi-todo.test.ts', '--list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(records(listed).at(-1).outcome, 'listed-not-run');
  assert.ok(!records(listed).some(record => record.event === 'file-start'));
  const invalid = invoke(['pi-pa', '--file', 'src/absent.test.ts']);
  assert.equal(invalid.status, 1);
  assert.ok(invalid.stderr.length <= 2000);
  for (const label of ['Condition:', 'Source:', 'Reason:', 'Correction:', 'Resume Action:']) assert.equal(invalid.stderr.split(label).length, 2);
  assert.doesNotMatch(invalid.stderr, /\u001b/);
});

test('actual local CLI completes isolated source checks and reports timeout as incomplete, never green', { timeout: 60000 }, () => {
  const completed = invoke(['pi-pa', '--file', 'src/__tests__/pi-todo.test.ts']);
  assert.equal(completed.status, 0, completed.stderr + completed.stdout);
  const data = records(completed);
  assert.equal(data.at(-1).outcome, 'completed');
  assert.equal(data.at(-1).acceptance, false);
  assert.equal(data.find(record => record.event === 'cases-end').counts.passed, 12);
  assert.match(data[0].selectionSha256, /^[0-9a-f]{64}$/);
  const timed = invoke(['pi-pa', '--file', 'src/__tests__/pi-todo.test.ts', '--file', 'src/__tests__/pi-workflow-code-cases.ts', '--budget-ms', '1']);
  assert.equal(timed.status, 1);
  const end = records(timed).at(-1);
  assert.equal(end.outcome, 'incomplete');
  assert.ok(end.unrun >= 1);
  assert.ok(end.timedOut >= 1 || end.executed === 0);
});
