import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestEnvironment, runIsolated } from './isolated-test-env.mjs';

const repo = new URL('../../', import.meta.url);

test('test environments remove ambient identity without mutating their source or toolchain', () => {
  const source = { HOME: '/original', PATH: '/tools', PA_DEPLOYMENT_ID: 'd-live', PA_ACTIVITY_LOG: '/live/log', PA_UNKNOWN_FUTURE_KEY: 'live', PI_SESSION_ID: 'live', GIT_DIR: '/live/git', TREEHOUSE_PANE_ID: 'live', NODE_OPTIONS: '--no-warnings', NODE_TEST_CONTEXT: 'child-v8', TZ: 'Asia/Saigon', LANG: 'en_US.UTF-8' };
  const env = createTestEnvironment('/fixture', source);
  for (const key of ['PA_DEPLOYMENT_ID', 'PA_ACTIVITY_LOG', 'PA_UNKNOWN_FUTURE_KEY', 'PI_SESSION_ID', 'GIT_DIR', 'TREEHOUSE_PANE_ID', 'NODE_TEST_CONTEXT']) assert.equal(env[key], undefined);
  assert.equal(source.PA_DEPLOYMENT_ID, 'd-live');
  for (const key of ['PATH', 'NODE_OPTIONS', 'TZ', 'LANG']) assert.equal(env[key], source[key]);
  assert.equal(env.COREPACK_HOME, '/original/.cache/node/corepack');
  assert.equal(env.PA_REGISTRY_DB, '/fixture/registry.db');
  // HOME/config already isolate the default home; an extra override would mask
  // suite-owned config_dir and change the repository configuration contract.
  assert.equal(env.PA_PLATFORM_HOME, undefined);
});

test('ambient native sentinels survive default todo registration and descendants; fixture persistence works', { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pa-ambient-sentinel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const names = ['deployment-tasks.json', 'activity.jsonl', 'registry.db', 'config.yaml'];
  for (const name of names) writeFileSync(join(root, name), `sentinel:${name}\n`, { mode: 0o600 });
  const before = names.map(name => readFileSync(join(root, name)));
  const footprint = join(root, 'footprint.json');
  const script = `
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    import { writeFileSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { registerTodoModule, createTodoModule } from ${JSON.stringify(new URL('packages/pi-pa/src/pi-extension/todo.ts', repo).href)};
    assert.equal(process.env.PA_DEPLOYMENT_ID, undefined);
    assert.equal(process.env.PA_ACTIVITY_LOG, undefined);
    assert.equal(process.env.PI_SESSION_ID, undefined);
    const handlers = new Map(); let tool;
    const runtime = { registerTool: value => { tool = value; }, on: (event, handler) => handlers.set(event, handler) };
    registerTodoModule(runtime);
    const added = await tool.execute('fixture', { action: 'add', text: 'active branch task' });
    handlers.get('session_tree')({}, { sessionManager: { getBranch: () => [{type:'message', message:{role:'toolResult',toolName:'todo',details:added.details}}] } });
    process.env.PA_DEPLOYMENT_ID = 'd-fixture';
    process.env.PA_DEPLOYMENT_DIR = process.env.PA_AI_USAGE_HOME;
    createTodoModule()(runtime);
    await tool.execute('fixture-persist', {action:'add',text:'fixture persistence'});
    assert.equal(JSON.parse(readFileSync(join(process.env.PA_DEPLOYMENT_DIR, 'deployment-tasks.json'))).tasks[0].text, 'fixture persistence');
    const descendant = spawnSync(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; assert.equal(process.env.PA_DEPLOYMENT_ID,'d-fixture'); assert.ok(process.env.PA_REGISTRY_DB.startsWith(process.env.HOME.replace(/home$/, '')));"], {stdio:'inherit'});
    assert.equal(descendant.status, 0);
    writeFileSync(${JSON.stringify(footprint)}, JSON.stringify({home:process.env.HOME}));
  `;
  const result = await runIsolated(process.execPath, ['--import=tsx', '--input-type=module', '-e', script], { env: { ...process.env, PA_DEPLOYMENT_ID: 'd-sentinel', PA_DEPLOYMENT_DIR: root, PA_ACTIVITY_LOG: join(root, 'activity.jsonl'), PA_REGISTRY_DB: join(root, 'registry.db'), PA_PLATFORM_CONFIG: root, PI_SESSION_ID: 'sentinel' }, timeoutMs: 55000 });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  names.forEach((name, i) => assert.deepEqual(readFileSync(join(root, name)), before[i]));
  assert.equal(existsSync(JSON.parse(readFileSync(footprint)).home), false);
});

test('unavailable fixture allocation never falls back to the ambient environment', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./isolated-test-env.mjs', import.meta.url)), '--', process.execPath, '-e', 'process.exit(0)'], { encoding: 'utf8', env: { ...process.env, TMPDIR: '/does-not-exist/pa-fixture-parent' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no ambient-environment fallback/);
});

test('failure, unavailable executable, timeout and cancellation remain non-successful', async () => {
  assert.equal((await runIsolated(process.execPath, ['-e', 'process.exit(7)'])).code, 7);
  await assert.rejects(runIsolated('/does-not-exist/pa-test-command', []), { code: 'ENOENT' });
  const timed = await runIsolated(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.signal, 'SIGTERM');
  assert.equal(timed.interrupted, null);
  const interrupted = await runIsolated(process.execPath, ['-e', "process.kill(process.pid, 'SIGINT')"]);
  assert.equal(interrupted.signal, 'SIGINT');
  assert.notEqual(interrupted.code, 0);
});
