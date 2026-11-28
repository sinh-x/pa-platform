// Opt-in prototype. The full code runner and hosted workflow remain authoritative.
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { runIsolated } from './isolated-test-env.mjs';
import { codeOnlyEntries, discoverTests, manualIntegration, partitionTests } from './run_code_tests.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workspace = name => resolve(root, 'packages', name);
const sourceEntries = names => Object.freeze(names.map(name => `src/__tests__/${name}`));
export const fastEntries = Object.freeze({
  'pa-core': sourceEntries([
    'security-policy.test.ts', 'source-content-security.test.ts', 'ticket-admin-service.test.ts',
    'ticket-comment-admission.test.ts', 'ticket-status.test.ts', 'workflow-contract.test.ts',
    'document-handoff-contract.test.ts',
  ]),
  'pi-pa': sourceEntries([
    'pi-cli-startup.test.ts', 'pi-execution-custody.test.ts', 'ticket-status-native.test.ts',
    'pi-workflow-code-cases.ts',
  ]),
});

export function selectDevelopFast(name, files, entries = fastEntries[name]) {
  if (!Object.hasOwn(fastEntries, name)) throw new Error('Unknown develop-fast workspace');
  const { code, manual } = partitionTests(files, manualIntegration[name], codeOnlyEntries[name]);
  if (!entries.length || new Set(entries).size !== entries.length) throw new Error(`Empty or duplicate develop-fast selection: ${name}`);
  for (const path of entries) if (!code.includes(path)) throw new Error(`Develop-fast entry is not in the full code inventory: ${name}/${path}`);
  const selected = new Set(entries);
  return { selected: code.filter(path => selected.has(path)), deferred: code.filter(path => !selected.has(path)), manual };
}

function createPlan() {
  const core = selectDevelopFast('pa-core', discoverTests(workspace('pa-core')));
  const pi = selectDevelopFast('pi-pa', discoverTests(workspace('pi-pa')));
  const serial = files => ['exec', 'tsx', '--test', '--test-concurrency=1', ...files];
  const stage = (label, args, cwd = root) => ({ label, argv: ['pnpm', ...args], cwd });
  return {
    inventories: { 'pa-core': core, 'pi-pa': pi },
    stages: [
      stage('Workspace build', ['run', 'build']),
      stage('Root test drivers', ['run', 'test:drivers:run']),
      stage('Core source tests', serial(core.selected), workspace('pa-core')),
      stage('OpenCode source tests', ['run', 'test:source:run'], workspace('opencode-pa')),
      stage('Pi script tests', ['exec', 'tsx', '--test', 'scripts/**/*.test.mjs'], workspace('pi-pa')),
      stage('Pi source tests', serial(pi.selected), workspace('pi-pa')),
      stage('Runtime-host source tests', ['run', 'test:source:run'], workspace('runtime-host')),
    ],
  };
}

export async function runDevelopFast(args, { run = runIsolated, log = console.log, error = console.error } = {}) {
  if (args.length && (args.length !== 1 || args[0] !== '--list')) {
    error('Use corepack pnpm test:develop-fast with no arguments to run, or --list to inspect the inventory.');
    return 1;
  }
  const { inventories, stages } = createPlan();
  log('Develop-fast prototype: selected source checks only; not full CI or release qualification.');
  for (const [name, { selected, deferred, manual }] of Object.entries(inventories)) {
    log(`${name}: ${selected.length} selected; ${deferred.length} deferred to full code tests; ${manual.length} manual integration (not run).`);
    for (const path of selected) log(`  ${path}`);
  }
  log(`Stages: ${stages.map(({ label }) => label).join('; ')}.`);
  if (args[0] === '--list') {
    log('Inventory only; no build or tests ran.');
    return 0;
  }
  for (const { label, argv, cwd } of stages) {
    log(`Running ${label}...`);
    const start = performance.now();
    let result;
    try { result = await run('corepack', argv, { cwd }); }
    catch {
      error(`${label} could not run. Check the local toolchain and test fixture setup; later stages did not run.`);
      return 1;
    }
    const signal = result.interrupted ?? result.signal;
    if (result.timedOut || signal || result.code !== 0) {
      const status = result.timedOut ? 'timed out' : signal ? `interrupted by ${signal}` : `failed (exit ${result.code ?? 'unknown'})`;
      error(`${label} ${status}; later stages did not run.`);
      return result.timedOut ? 1 : signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : signal ? 1 : result.code ?? 1;
    }
    log(`${label} completed in ${((performance.now() - start) / 1000).toFixed(1)}s.`);
  }
  log('Selected stages completed. See test output for skips; deferred checks remain unverified.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runDevelopFast(process.argv.slice(2)); }
  catch (error) {
    console.error(`Develop-fast inventory could not be loaded: ${error.message}`);
    process.exitCode = 1;
  }
}
