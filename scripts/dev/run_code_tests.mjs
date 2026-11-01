// Explicit code-only CI inventory; never runtime authority or integration proof.
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const manualIntegration = Object.freeze({
  'pi-pa': Object.freeze({
    'src/__tests__/ordinary-local-development.test.ts': 'real ordinary launcher, sandboxed checks and commits',
    'src/__tests__/project-command-contract.test.ts': 'trusted immutable executable and namespace profile',
    'src/__tests__/project-command-catalogue-execution.test.ts': 'native operator evidence plus selected-task immutable executable and namespace confinement',
    'src/__tests__/prepared-native.test.ts': 'native/packaged SDK and isolated project-command integration',
    'src/__tests__/pi-deploy.test.ts': 'deployment/custody/review including a real ordinary command contract',
    'src/__tests__/pi-workflow-runtime.test.ts': 'mandatory native workflow/materialization/matrix/restart; portable cases use an explicit code-only entry',
  }),
  'pa-core': Object.freeze({
    'src/artifacts/__tests__/manifest.test.ts': 'managed immutable renderer integration',
    'src/artifacts/__tests__/render.test.ts': 'managed immutable renderer integration',
    'src/artifacts/__tests__/session.test.ts': 'managed review runtime and private artifact sessions',
  }),
});
// Mixed suites retain their original full local entry. Their portable entry is
// deliberately not *.test.ts, so the full suite never discovers it a second time.
export const codeOnlyEntries = Object.freeze({
  'pi-pa': Object.freeze({
    'src/__tests__/pi-workflow-runtime.test.ts': 'src/__tests__/pi-workflow-code-cases.ts',
  }),
  'pa-core': Object.freeze({}),
});
export function partitionTests(files, manual, entries = {}) {
  const all = [...new Set(files)].sort();
  for (const path of Object.keys(manual)) if (!all.includes(path)) throw new Error(`Manual integration entry no longer exists: ${path}`);
  const replacements = Object.values(entries);
  if (new Set(replacements).size !== replacements.length) throw new Error('Duplicate code-only entry');
  for (const [full, code] of Object.entries(entries)) {
    if (!Object.hasOwn(manual, full)) throw new Error(`Code-only entry has no manual integration owner: ${full}`);
    if (!all.includes(code)) throw new Error(`Code-only entry no longer exists: ${code}`);
    if (Object.hasOwn(manual, code) || code.endsWith('.test.ts')) throw new Error(`Code-only entry must be a non-discovered helper: ${code}`);
  }
  return { code: [...all.filter(path => path.endsWith('.test.ts') && !Object.hasOwn(manual, path)), ...replacements].sort(), manual: all.filter(path => Object.hasOwn(manual, path)) };
}
function discover(root, folder = join(root, 'src')) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? discover(root, path) : entry.isFile() && entry.name.endsWith('.ts') ? [relative(root, path).split('\\').join('/')] : [];
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  if (process.argv.length !== 3 || !Object.hasOwn(manualIntegration, name)) throw new Error('Select pa-core or pi-pa code tests');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages', name);
  const manual = manualIntegration[name], entries = codeOnlyEntries[name], selected = partitionTests(discover(root), manual, entries);
  console.log(`Code-only CI ${name}: ${selected.code.length} source test files; ${selected.manual.length} explicitly deferred manual integration files.`);
  for (const path of selected.manual) console.log(`MANUAL INTEGRATION (not passed/skipped by this lane): ${path}: ${manual[path]}`);
  for (const [full, code] of Object.entries(entries)) console.log(`CODE-ONLY ENTRY: ${code}; full local/installed entry remains ${full}`);
  console.log('Manual gate: corepack pnpm test in the supported immutable sandbox toolchain. Code-only success is not integration acceptance.');
  if (!selected.code.length) throw new Error('Empty code-only test inventory');
  const result = spawnSync('corepack', ['pnpm', 'exec', 'tsx', '--test', '--test-concurrency=1', ...selected.code], { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.signal ? 1 : result.status ?? 1);
}
