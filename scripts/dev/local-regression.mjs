// Serial, opt-in source feedback. Never full/installed acceptance or a build cache.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { codeOnlyEntries, discoverTests, manualIntegration, partitionTests } from './run_code_tests.mjs';
import { runIsolated } from './isolated-test-env.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const reporter = fileURLToPath(new URL('./local-test-reporter.mjs', import.meta.url));
const pathPattern = /^src\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.ts$/;
export function parseOptions(argv) {
  const name = argv[0];
  if (!Object.hasOwn(manualIntegration, name)) throw new Error('Select pa-core or pi-pa');
  const options = { name, lane: 'code', files: [], timeoutMs: 300000, budgetMs: 900000, list: false };
  const seen = new Set();
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (!['--lane', '--file', '--timeout-ms', '--budget-ms', '--list'].includes(key) || (key !== '--file' && seen.has(key))) throw new Error('Invalid option');
    seen.add(key);
    if (key === '--list') { options.list = true; continue; }
    const value = argv[++i];
    if (key === '--file') {
      if (!pathPattern.test(value ?? '') || value.split('/').some(part => part === '.' || part === '..') || options.files.includes(value)) throw new Error('Invalid test path');
      options.files.push(value);
    } else if (key === '--lane') {
      if (!['code', 'full'].includes(value)) throw new Error('Invalid lane');
      options.lane = value;
    } else {
      if (!/^[1-9][0-9]{0,7}$/.test(value ?? '') || Number(value) > 3600000) throw new Error('Invalid budget');
      options[key === '--timeout-ms' ? 'timeoutMs' : 'budgetMs'] = Number(value);
    }
  }
  return options;
}
export function selectTests(files, options) {
  const partition = partitionTests(files, manualIntegration[options.name], codeOnlyEntries[options.name]);
  const available = options.lane === 'full' ? files.filter(path => path.endsWith('.test.ts')).sort() : partition.code;
  for (const path of [...available, ...partition.manual]) if (!pathPattern.test(path) || path.split('/').some(part => part === '.' || part === '..')) throw new Error('Unsafe inventory path');
  if (!available.length) throw new Error('Empty test inventory');
  for (const path of options.files) if (!available.includes(path)) throw new Error('Selected file is absent from this lane');
  return { selected: options.files.length ? [...options.files].sort() : available,
    notSelected: options.files.length ? available.filter(path => !options.files.includes(path)) : [],
    deferred: options.lane === 'full' ? [] : partition.manual };
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function selectionDigest(root, files) {
  const hash = createHash('sha256');
  for (const path of files) hash.update(path).update('\0').update(digest(readFileSync(join(root, path)))).update('\0');
  return hash.digest('hex');
}
function emit(record) {
  const line = JSON.stringify(record);
  if (Buffer.byteLength(line) > 4096) throw new Error('Local regression event exceeded bound');
  console.log(line);
}
function identity(root, selected) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), encoding: 'utf8', maxBuffer: 4096 });
  return { head: head.status === 0 && /^[0-9a-f]{40}\n?$/.test(head.stdout) ? head.stdout.trim() : null,
    node: process.version, packageManager: JSON.parse(readFileSync(join(repository, 'package.json'))).packageManager,
    lockfileSha256: digest(readFileSync(join(repository, 'pnpm-lock.yaml'))), selectionSha256: selectionDigest(root, selected) };
}
export async function runLocal(options) {
  const root = join(repository, 'packages', options.name);
  const inventory = selectTests(discoverTests(root), options);
  const inputs = identity(root, inventory.selected);
  emit({ event: 'run-start', package: options.name, lane: options.lane, focused: options.files.length > 0, ...inputs,
    selected: inventory.selected.length, notSelected: inventory.notSelected.length, deferred: inventory.deferred.length,
    timeoutMs: options.timeoutMs, budgetMs: options.budgetMs, acceptance: false });
  for (const [state, files] of Object.entries(inventory)) for (const file of files) emit({ event: 'inventory', state, file });
  if (options.list) { emit({ event: 'run-end', outcome: 'listed-not-run', executed: 0, unrun: inventory.selected.length }); return 0; }
  const started = performance.now();
  let executed = 0, failed = 0, timedOut = 0, interrupted = false, unavailable = false;
  for (const file of inventory.selected) {
    const remaining = Math.floor(options.budgetMs - (performance.now() - started));
    if (remaining <= 0 || interrupted || unavailable) break;
    const start = performance.now();
    const timeoutMs = Math.min(options.timeoutMs, remaining);
    emit({ event: 'file-start', file, timeoutMs });
    const heartbeat = setInterval(() => emit({ event: 'file-running', file, durationMs: Math.round(performance.now() - start) }), 30000);
    try {
      const result = await runIsolated(process.execPath, ['--import=tsx', '--test', '--test-concurrency=1', `--test-reporter=${reporter}`, file], { cwd: root, timeoutMs, stdio: ['ignore', 'inherit', 'ignore'] });
      executed++;
      if (result.timedOut) timedOut++;
      interrupted = Boolean(result.interrupted) || (!result.timedOut && Boolean(result.signal));
      if (result.code !== 0 || result.timedOut || result.signal) failed++;
      emit({ event: 'file-end', file, outcome: result.timedOut ? 'timed-out' : interrupted ? 'interrupted' : result.code === 0 ? 'completed' : 'failed',
        exitCode: result.code, signal: result.signal, durationMs: Math.round(performance.now() - start),
        ...(result.timedOut ? { limit: remaining < options.timeoutMs ? 'run-budget' : 'file-budget' } : {}) });
    } catch {
      // Do not copy arbitrary spawn/allocation exceptions into the public projection.
      unavailable = true;
      emit({ event: 'file-end', file, outcome: 'unavailable', durationMs: Math.round(performance.now() - start) });
    } finally { clearInterval(heartbeat); }
  }
  let stale = true;
  try { stale = inputs.selectionSha256 !== selectionDigest(root, inventory.selected) || inputs.lockfileSha256 !== digest(readFileSync(join(repository, 'pnpm-lock.yaml'))); } catch { /* unavailable input is not fresh evidence */ }
  const unrun = inventory.selected.length - executed;
  const outcome = stale ? 'stale-inputs' : interrupted ? 'interrupted' : unavailable ? 'unavailable' : timedOut || unrun ? 'incomplete' : failed ? 'failed' : 'completed';
  emit({ event: 'run-end', outcome, executed, failed, timedOut, unrun, durationMs: Math.round(performance.now() - started), acceptance: false });
  return outcome === 'completed' ? 0 : interrupted ? 130 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runLocal(parseOptions(process.argv.slice(2))); }
  catch {
    console.error('Local source checks did not complete.\nCondition: The requested local lane has no complete result.\nSource: Local regression inventory, inputs or fixture launcher.\nReason: Options, required inputs or execution resources are unavailable; the exact cause is not projected.\nCorrection: Inspect the documented options and source/toolchain prerequisites. Impact: read-only. Actor: agent or operator. New approval: not required for inspection. Prerequisite: this checkout and its local regression documentation.\nResume Action: Retry only after correcting the inputs or fixture/toolchain problem. Existing native checks still apply; this command grants no acceptance.');
    process.exitCode = 1;
  }
}
