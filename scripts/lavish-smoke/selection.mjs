// Installed wrapper + adapter environment regression; no provider execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { captureInstalledWrapper } from '../axi-smoke/capture-wrapper.mjs';
const { output, mask, evaluation, tools } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const share = join(output, 'share/pa-platform');
const names = ['gh-axi', 'chrome-devtools-axi', 'quota-axi', 'lavish-axi'];
const selection = Object.fromEntries(names.map((name, i) => [name, Boolean(mask & (1 << i))]));
assert.deepEqual(JSON.parse(fs.readFileSync(join(share, 'axi-selection.json'))), selection);
const selected = names.filter(n => selection[n]);
assert.deepEqual(fs.readdirSync(join(share, 'axi-tools')).sort(), selected.sort());
for (const n of selected) assert.equal(fs.realpathSync(join(share, 'axi-tools', n)), tools[n].store);
assert.deepEqual(fs.existsSync(join(share, 'axi-bin')) ? fs.readdirSync(join(share, 'axi-bin')).sort() : [], selected.sort());
const expectedDeps = new Set(selected.flatMap(n => [tools[n].node, ...tools[n].dependencies]));
assert.deepEqual(new Set(evaluation.dependencies), expectedDeps);
assert.equal(evaluation.dependencies.length, expectedDeps.size);
const root = fs.mkdtempSync('/tmp/pa-lavish-selection-');
const inherited = '/inherited/synthetic/bin';
const base = { PATH: inherited, HOME: root, PA_AI_USAGE_HOME: root, TZ: 'UTC', LC_ALL: 'C.UTF-8' };
const wrappers = Object.fromEntries(['ppa', 'opa', 'pa-core', 'pa-platform-node'].map(n => [n, captureInstalledWrapper(output, n, base)]));
const prefix = selected.length ? [join(share, 'axi-bin'), ...evaluation.dependencies.map(p => `${p}/bin`)].join(':') : '';
assert.equal(wrappers.ppa[1] ?? '', prefix);
for (const n of ['opa', 'pa-core', 'pa-platform-node']) {
  assert.equal(wrappers[n][1] ?? '', '');
  assert.equal(wrappers[n][0].includes('/axi-bin'), false);
}
assert.equal(wrappers.ppa[0].endsWith(inherited), true);
if (prefix) assert.equal(wrappers.ppa[0].startsWith(prefix + ':'), true);
const realSpawn = cp.spawnSync;
let captures = [];
cp.spawnSync = (executable, args, opts) => {
  assert.equal(executable, 'opencode', 'only installed adapter foreground seam');
  captures.push({ args, env: opts.env });
  return { status: 0, stdout: '', stderr: '' };
};
syncBuiltinESMExports();
let total = 0;const launches = [];
const corePackage = JSON.parse(fs.readFileSync(join(share,'packages/pa-core/package.json')));
for(const field of ['dependencies','devDependencies','optionalDependencies']) assert.ok(!Object.keys(corePackage[field]??{}).some(name=>name.includes('axi')));
try {
  const { PiAdapter } = await import(join(share, 'packages/pi-pa/dist/adapter.js'));
  const { OpencodeAdapter } = await import(join(share, 'packages/opencode-pa/dist/adapter.js'));
  for (const [adapter, Class] of [['pi', PiAdapter], ['opencode', OpencodeAdapter]]) {
    const dir = join(root, adapter); fs.mkdirSync(dir, { mode: 0o700 });
    const primer = join(dir, 'primer.md'); fs.writeFileSync(primer, 'Synthetic environment capture only.');
    const capture = (args, options) => { captures.push({ args, env: options.env }); return { status: 0, stdout: '', stderr: '' }; };
    const instance = new Class({ cwd: dir, env: { ...base, PA_AXI_PATH: prefix }, versionProbe: () => '0.84.4', nativeRegistryProbe: () => undefined,
      runCommand: capture, runBackgroundCommand: (args, opts) => { capture(args, opts); return { pid: process.pid }; } });
    for (const mode of ['foreground', 'background']) for (const operation of ['spawn', 'resume']) {
      captures = [];
      const result = await instance[operation]({ deployId: 'd-abcdef', primerPath: primer, mode, sessionId: 'synthetic-resume-token',
        executionPlan: { repositoryCwd: dir, skills: [], environment: {} } });
      assert.equal(result.exitCode, 0);
      assert.equal(captures.length, 1);
      const env = captures[0].env;
      assert.equal(env.PA_ARTIFACT_ADAPTER, adapter);
      assert.equal(env.PA_ARTIFACT_OWNER_PID, mode === 'background' ? 'background' : String(process.pid));
      assert.equal(env.PATH, adapter === 'pi' && prefix ? `${prefix}:${inherited}` : inherited);
      launches.push({adapter,mode,operation,args:captures[0].args,environment:{PATH:env.PATH,PA_AXI_PATH:env.PA_AXI_PATH,PA_ARTIFACT_ADAPTER:env.PA_ARTIFACT_ADAPTER,PA_ARTIFACT_OWNER_PID:env.PA_ARTIFACT_OWNER_PID}});
      total++;
    }
  }
} finally {
  cp.spawnSync = realSpawn; syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ status: 'passed', mask, selection, wrappers, launches, adapterLaunchCaptures: total,
  scope: 'real installed wrappers and installed adapter environment capture seams, not provider/inference execution' }) + '\n');
