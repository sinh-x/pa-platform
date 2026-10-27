// Code-only CI selection. This is test orchestration, never runtime authority.
// The full `pnpm test` suite remains the manual integration gate.
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const manualIntegration = Object.freeze({
  'src/__tests__/ordinary-local-development.test.ts': 'real ordinary launcher, sandboxed project checks and commits',
  'src/__tests__/project-command-contract.test.ts': 'trusted immutable executable and namespace capability profile',
  'src/__tests__/prepared-native.test.ts': 'native/packaged SDK integration including isolated project commands',
  'src/__tests__/pi-deploy.test.ts': 'deployment/custody/review integration including a real ordinary command contract',
});
export function partitionTests(files) {
  const all = [...new Set(files)].sort();
  for (const path of Object.keys(manualIntegration)) if (!all.includes(path)) throw new Error(`Manual integration entry no longer exists: ${path}`);
  return { code: all.filter(path => !Object.hasOwn(manualIntegration, path)), manual: all.filter(path => Object.hasOwn(manualIntegration, path)) };
}
function discover(root, folder = join(root, 'src')) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? discover(root, path) : entry.isFile() && entry.name.endsWith('.test.ts') ? [relative(root, path).split('\\').join('/')] : [];
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const selected = partitionTests(discover(root));
  console.log(`Code-only CI: ${selected.code.length} source test files; ${selected.manual.length} explicitly deferred manual integration files.`);
  for (const path of selected.manual) console.log(`MANUAL INTEGRATION (not passed/skipped by this lane): ${path}: ${manualIntegration[path]}`);
  console.log('Manual gate: corepack pnpm test in the supported sandbox/toolchain environment. Code-only success is not integration acceptance.');
  if (!selected.code.length) throw new Error('Empty code-only test inventory');
  const result = spawnSync('corepack', ['pnpm', 'exec', 'tsx', '--test', '--test-concurrency=1', ...selected.code], { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.signal ? 1 : result.status ?? 1);
}
