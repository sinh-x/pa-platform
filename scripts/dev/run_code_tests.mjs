// Explicit code-only CI inventory; never runtime authority or integration proof.
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const manualIntegration = Object.freeze({
  'pi-pa': Object.freeze({
    'src/__tests__/ordinary-local-development.test.ts': 'real ordinary launcher, sandboxed checks and commits',
    'src/__tests__/project-command-contract.test.ts': 'trusted immutable executable and namespace profile',
    'src/__tests__/prepared-native.test.ts': 'native/packaged SDK and isolated project-command integration',
    'src/__tests__/pi-deploy.test.ts': 'deployment/custody/review including a real ordinary command contract',
  }),
  'pa-core': Object.freeze({
    'src/artifacts/__tests__/manifest.test.ts': 'managed immutable renderer integration',
    'src/artifacts/__tests__/render.test.ts': 'managed immutable renderer integration',
    'src/artifacts/__tests__/session.test.ts': 'managed review runtime and private artifact sessions',
  }),
});
export function partitionTests(files, manual) {
  const all = [...new Set(files)].sort();
  for (const path of Object.keys(manual)) if (!all.includes(path)) throw new Error(`Manual integration entry no longer exists: ${path}`);
  return { code: all.filter(path => !Object.hasOwn(manual, path)), manual: all.filter(path => Object.hasOwn(manual, path)) };
}
function discover(root, folder = join(root, 'src')) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? discover(root, path) : entry.isFile() && entry.name.endsWith('.test.ts') ? [relative(root, path).split('\\').join('/')] : [];
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  if (process.argv.length !== 3 || !Object.hasOwn(manualIntegration, name)) throw new Error('Select pa-core or pi-pa code tests');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages', name);
  const manual = manualIntegration[name], selected = partitionTests(discover(root), manual);
  console.log(`Code-only CI ${name}: ${selected.code.length} source test files; ${selected.manual.length} explicitly deferred manual integration files.`);
  for (const path of selected.manual) console.log(`MANUAL INTEGRATION (not passed/skipped by this lane): ${path}: ${manual[path]}`);
  console.log('Manual gate: corepack pnpm test in the supported immutable sandbox toolchain. Code-only success is not integration acceptance.');
  if (!selected.code.length) throw new Error('Empty code-only test inventory');
  const result = spawnSync('corepack', ['pnpm', 'exec', 'tsx', '--test', '--test-concurrency=1', ...selected.code], { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.signal ? 1 : result.status ?? 1);
}
