// PAP-240 real installed outputs. All imports below resolve under /nix/store.
// Generic status fixtures replace providers. Pinned expiry cases execute the real
// quota CLI/providers with transport-only responses; Chrome/MCP/AXI remain real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureInstalledWrapper } from './capture-wrapper.mjs';
import { writeConsentFixture } from './consent-fixture.mjs';
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { root, outputs, tools, chrome } = manifest;
const helperDir = dirname(fileURLToPath(import.meta.url));
const names = ['gh-axi', 'chrome-devtools-axi', 'quota-axi'];
const all = outputs['7'];
const modules = join(all, 'share/pa-platform/packages/pi-pa/dist');
const report = { cases: {}, nativeRuns: {}, effectCounters: {} };
let active = 'initialization';
const done = (name, evidence = {}) => { report.cases[name] = { status: 'passed', ...evidence }; };
const ledger = join(root, 'effects.jsonl');
fs.writeFileSync(ledger, '', { mode: 0o600 });
const rows = () => fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const count = kind => rows().filter(row => row.kind === kind).length;
const auditOutput = text => assert.doesNotMatch(text, /secret-sentinel|identity-sentinel|path-sentinel|synthetic-only-never-a-vendor-token/);
const baseEnv = { PATH: '', HOME: join(root, 'home'), LANG: 'C.UTF-8',
  GH_CONFIG_DIR: join(root, 'home/empty-gh'), CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1', CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' };
const fixtureEnv = { ...baseEnv, AXI_SMOKE_ROOT: root, AXI_SMOKE_LEDGER: ledger,
  AXI_SMOKE_QUOTA_ENTRY: join(tools['quota-axi'].store, 'lib/quota-axi/node_modules/quota-axi/dist/bin/quota-axi.js'),
  AXI_SMOKE_WORKER: join(helperDir, 'provider.mjs'), NODE_OPTIONS: `--require=${join(helperDir, 'observe.cjs')}` };
const shim = (output, name) => join(output, 'share/pa-platform/axi-bin', name);
function command(executable, args, env = fixtureEnv, status = 0, timeout = 15000) {
  const result = cp.spawnSync(executable, args, { env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, status);
  auditOutput(result.stdout + result.stderr);
  return result;
}
function asyncCommand(executable, args, env, status = 0, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('bounded-command')); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill('SIGTERM'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill('SIGTERM'); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      try { assert.equal(signal, null); assert.equal(code, status); auditOutput(stdout + stderr); resolve({ stdout, stderr }); }
      catch (error) {
        const command = ['start', 'stop', 'pages', 'open', 'newpage', 'snapshot', 'click', 'fill', 'press', 'back', 'selectpage', 'closepage'].includes(args[0]) ? args[0] : 'other';
        error.exitEvidence = { command, expectedExit: status, actualExit: code,
          signal: signal === null ? null : ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT'].includes(signal) ? signal : 'other' };
        reject(error);
      }
    });
  });
}
async function wait(check, bound) {
  const start = performance.now();
  while (!check() && performance.now() - start < bound) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(check(), true);
  return Math.round(performance.now() - start);
}
const lifetimeChildren = [];
const browserEnvs = [];
let providerServer;
let browser;
let collisionServer;
try {
  // Install a deterministic reserve-after-allocation seam BEFORE importing the
  // installed browser module. Only this one port-allocation close is affected;
  // the foreign listener is real and survives the failed pinned bridge startup.
  const originalCreate = net.createServer;
  let forceCollision = false;
  net.createServer = (...args) => {
    const server = originalCreate(...args);
    const originalClose = server.close.bind(server);
    server.close = callback => {
      if (!forceCollision) return originalClose(callback);
      forceCollision = false;
      const port = server.address().port;
      return originalClose(error => {
        if (error) return callback(error);
        collisionServer = originalCreate(socket => socket.destroy());
        collisionServer.listen(port, '127.0.0.1', () => callback());
      });
    };
    return server;
  };
  syncBuiltinESMExports();
  browser = await import(join(modules, 'axi-browser.js'));
  report.managedMcpPreload = browser.managedProcessPreload();
  const policy = await import(join(modules, 'axi-policy.js'));
  assert.equal(browser.BROWSER_READINESS_MS, 30000);
  assert.equal(browser.BROWSER_IDLE_MS, 300000);
  assert.equal(browser.BROWSER_CLEANUP_MS, 10000);
  const inherited = '/inherited/gh-axi:/inherited/quota-axi:/inherited/bin::';
  const captureWrapper = (output, name) => captureInstalledWrapper(output, name, { ...baseEnv, PATH: inherited });
  active = 'installed-path';
  const baselinePrefixes = Object.fromEntries(['pa-core', 'opa', 'cpa', 'dpa', 'pa-platform-node'].map(name => [name, captureWrapper(outputs['0'], name)[0]]));
  for (let mask = 0; mask < 8; mask++) {
    const output = outputs[String(mask)];
    assert.match(output, /^\/nix\/store\//);
    const share = join(output, 'share/pa-platform');
    const selected = names.filter((_, index) => mask & (1 << index));
    const actual = JSON.parse(fs.readFileSync(join(share, 'axi-selection.json'), 'utf8'));
    assert.deepEqual(actual, Object.fromEntries(names.map(name => [name, selected.includes(name)])));
    assert.deepEqual(fs.readdirSync(join(share, 'axi-tools')).sort(), [...selected].sort());
    if (mask) assert.deepEqual(fs.readdirSync(join(share, 'axi-bin')).sort(), [...selected].sort());
    else assert.equal(fs.existsSync(join(share, 'axi-bin')), false);
    const evaluation = manifest.evaluations[`x86_64-linux/${mask}`];
    const declaredDependencies = new Set(selected.flatMap(name => [tools[name].node, ...tools[name].dependencies]));
    assert.deepEqual(new Set(evaluation.dependencies), declaredDependencies);
    assert.equal(evaluation.dependencies.length, declaredDependencies.size);
    const expected = mask ? [join(share, 'axi-bin'), ...evaluation.dependencies.map(path => `${path}/bin`)].join(':') : '';
    const [path, added = ''] = captureWrapper(output, 'ppa');
    assert.equal(added, expected);
    assert.equal(path.endsWith(inherited), true);
    assert.equal(path.startsWith(mask ? `${expected}:` : baselinePrefixes['pa-core'].slice(0, -inherited.length)), true);
    for (const name of Object.keys(baselinePrefixes)) assert.equal(captureWrapper(output, name)[0], baselinePrefixes[name]);
    assert.equal(policy.axiRuntimeEnvironment({ PATH: inherited, PA_AXI_PATH: expected }).PATH, `${expected ? expected + ':' : ''}${inherited}`);
    const pluginPackage = JSON.parse(fs.readFileSync(join(share, 'packages/pi-pa/package.json'), 'utf8'));
    const provenance = JSON.parse(fs.readFileSync(join(share, 'packages/pi-pa/dist/pi-extension/vendor/provenance.json'), 'utf8'));
    assert.deepEqual(pluginPackage.imports, {});
    assert.deepEqual(provenance.selectedSources, []);
    for (const artifact of ['native-addons/node-22/better_sqlite3.node', 'native-addons/pi-node-24/better_sqlite3.node', 'packages/pi-pa/dist/pi-extension/index.js']) assert.equal(fs.existsSync(join(share, artifact)), true);
    for (const name of ['pa-core', 'opa', 'cpa', 'dpa', 'ppa']) {
      command(join(output, 'bin', name), ['--help'], fixtureEnv);
      assert.equal(fs.existsSync(join(output, 'share/fish/vendor_completions.d', `${name}.fish`)), true);
    }
    for (const name of selected) {
      command(shim(output, name), ['--help']);
      assert.equal(command(shim(output, name), ['--version']).stdout.trim(), `${name} ${tools[name].version}`);
      assert.equal(fs.realpathSync(join(share, 'axi-tools', name)), tools[name].store);
    }
    report.nativeRuns[String(mask)] = { store: output, managedExecutables: selected, addedPath: expected, inheritedPath: inherited, commands: 5, piPlugins: [], nativeAddonsPresent: true };
  }
  done(active, { selections: 8, otherAdapterPrefixes: baselinePrefixes, inheritedPath: inherited });
  active = 'installed-metadata';
  const metadataEvents = rows().length;
  for (const [name, tool] of Object.entries(tools)) {
    const result = command(join(tool.store, 'bin', name), ['--version']);
    assert.match(result.stdout + result.stderr, new RegExp(tool.version.replaceAll('.', '\\.')));
  }
  const metadataEffects = rows().slice(metadataEvents).filter(row => row.kind !== 'observerLoaded').length;
  assert.equal(metadataEffects, 0);
  done(active, { standaloneVersions: Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, tool.version])), authenticationAndProviderEffects: metadataEffects });
  active = 'installed-prerequisites';
  for (const [name, args, diagnostic] of [
    ['gh-axi', ['pr', 'list'], 'AXI_GH_AUTH_REQUIRED'],
    ['chrome-devtools-axi', ['start'], 'AXI_CHROME_REQUIRED'],
    ['quota-axi', ['quota'], 'AXI_QUOTA_CONSENT_REQUIRED'],
  ]) assert.match(command(shim(all, name), args, fixtureEnv, 1).stderr, new RegExp(`^${diagnostic}:`));
  done(active, { diagnostics: ['AXI_GH_AUTH_REQUIRED', 'AXI_CHROME_REQUIRED', 'AXI_QUOTA_CONSENT_REQUIRED'] });
  active = 'installed-policy-denials';
  const bypasses = [
    ['gh-axi', ['setup', 'hooks']], ['gh-axi', ['self-update']], ['gh-axi', ['--help', 'pr', 'merge']],
    ['chrome-devtools-axi', ['attach']], ['chrome-devtools-axi', ['start', '--userDataDir=/foreign']],
    ['chrome-devtools-axi', ['start', '--browser-url=http://127.0.0.1']], ['chrome-devtools-axi', ['start', '--chrome-arg=--remote-debugging-address=0.0.0.0']],
    ['quota-axi', ['auth']], ['quota-axi', ['refresh']], ['quota-axi', ['route']], ['quota-axi', ['--tui']],
    ['quota-axi', ['quota', '--provider', 'codex']], ['quota-axi', ['--allow-keychain-prompt']],
    ['quota-axi', ['--allow-claude-inference']], ['quota-axi', ['quota', '--endpoint=http://127.0.0.1']],
  ];
  const beforeBypass = rows().length;
  for (const [name, args] of bypasses) assert.match(command(shim(all, name), args, fixtureEnv, 1).stderr, /^AXI_POLICY_REJECTED:/);
  for (const key of ['CHROME_DEVTOOLS_AXI_MCP_PATH', 'CHROME_DEVTOOLS_AXI_USER_DATA_DIR', 'CHROME_DEVTOOLS_MCP_ARGS']) assert.match(command(shim(all, 'chrome-devtools-axi'), ['start'], { ...fixtureEnv, [key]: 'secret-sentinel' }, 1).stderr, /^AXI_POLICY_REJECTED:/);
  for (const key of ['QUOTA_AXI_SNAPSHOT', 'OPENAI_BASE_URL', 'ANTHROPIC_API_URL']) assert.match(command(shim(all, 'quota-axi'), ['quota'], { ...fixtureEnv, [key]: 'secret-sentinel' }, 1).stderr, /^AXI_POLICY_REJECTED:/);
  const bypassEffects = rows().slice(beforeBypass).filter(row => row.kind !== 'observerLoaded').length;
  assert.equal(bypassEffects, 0);
  done(active, { argumentCases: bypasses.length, environmentCases: 6, sideEffectEvents: bypassEffects });
  active = 'startup-authority';
  const startupBefore = rows().length;
  const { PiAdapter } = await import(join(modules, 'adapter.js'));
  for (let mask = 0; mask < 8; mask++) {
    const output = outputs[String(mask)];
    const dir = join(root, `d-launch${mask}`); fs.mkdirSync(dir, { mode: 0o700 });
    const primer = join(dir, 'primer.md'); fs.writeFileSync(primer, 'local capture only');
    const extension = join(output, 'share/pa-platform/packages/pi-pa/dist/pi-extension/index.js');
    const prefix = report.nativeRuns[String(mask)].addedPath;
    const captured = [];
    const adapter = new PiAdapter({ cwd: dir, env: { ...baseEnv, PATH: inherited, PA_AXI_PATH: prefix }, versionProbe: () => '0.84.4', nativeRegistryProbe: () => undefined,
      runCommand: (args, options) => {
        captured.push(args);
        assert.equal(options.env.PATH, `${prefix ? prefix + ':' : ''}${inherited}`);
        assert.equal(args.filter(arg => arg === '--no-skills').length, 1);
        assert.equal(args.filter(arg => arg === '--no-extensions').length, 1);
        assert.equal(args[args.indexOf('--extension') + 1], extension);
        assert.equal(args.filter(arg => arg === '--extension').length, 1);
        assert.equal(args.some(arg => names.includes(arg) || ['setup', 'hooks', 'merge', 'dispatch'].includes(arg)), false);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const plan = { runtime: 'pi', team: 'builder', mode: 'implement', repositoryCwd: dir, skills: [], trustedExtension: extension, environment: {} };
    for (const mode of ['foreground', 'background']) assert.equal((await adapter.spawn({ primerPath: primer, deployId: `d-launch${mask}`, mode, executionPlan: plan })).exitCode, 0);
    assert.equal(captured.length, 2);
  }
  const startupEffects = rows().length - startupBefore;
  assert.equal(startupEffects, 0);
  assert.equal(fs.existsSync(join(root, 'home/.pi')), false);
  assert.equal(fs.existsSync(join(root, 'home/.claude')), false);
  done(active, { installedAdapterLaunchCaptures: 16, toolStartupEvents: startupEffects, noGlobalHooks: true, authority: 'unchanged; no GitHub mutation performed' });
  // Server and synthetic profiles are separate from the consent file. Reads
  // and requests are observed, including on every invalid consent CLI run.
  const portFile = join(root, 'provider-port');
  providerServer = cp.spawn(process.execPath, [join(helperDir, 'provider.mjs'), 'server'], { env: { ...baseEnv, AXI_SMOKE_LEDGER: ledger, AXI_SMOKE_PORT_FILE: portFile }, stdio: 'ignore' });
  await wait(() => fs.existsSync(portFile), 5000);
  for (const name of ['codex', 'claude']) {
    const dir = join(root, 'profiles', name); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(dir, 'synthetic-credential.json'), JSON.stringify({ token: 'synthetic-only-never-a-vendor-token' }), { mode: 0o600 });
  }
  const dir = join(root, 'd-quota'); fs.mkdirSync(dir, { mode: 0o700 });
  const consent = join(root, 'consent.json');
  const value = { version: 1, deploymentId: 'd-quota', providers: ['codex', 'claude'].map(id => ({ id, profilePath: join(root, 'profiles', id) })) };
  const quotaEnv = { ...fixtureEnv, PA_DEPLOYMENT_ID: 'd-quota', PA_DEPLOYMENT_DIR: dir, PA_AXI_QUOTA_CONSENT: consent, AXI_SMOKE_PORT: fs.readFileSync(portFile, 'utf8'), AXI_SMOKE_STATE: 'fresh',
    CODEX_HOME: '/path-sentinel', CLAUDE_CONFIG_DIR: '/identity-sentinel', OPENAI_API_KEY: 'secret-sentinel', ANTHROPIC_API_KEY: 'secret-sentinel', HTTPS_PROXY: 'secret-sentinel' };
  const setConsent = v => writeConsentFixture(consent, v);
  active = 'quota-denials';
  const denialEvidence = [];
  const denyConsent = (name, env = quotaEnv) => {
    const before = { reads: count('credentialRead'), metadata: count('profileMetadata'), evidence: count('profileEvidenceRead'), requests: count('providerRequest'), invocations: count('providerInvocation'), observers: count('observerLoaded') };
    assert.match(command(shim(all, 'quota-axi'), ['quota', '--json'], env, 1).stderr, /^AXI_(POLICY_REJECTED|QUOTA_CONSENT_REQUIRED):/);
    const observed = { credentialReads: count('credentialRead') - before.reads, profileMetadata: count('profileMetadata') - before.metadata, profileEvidenceReads: count('profileEvidenceRead') - before.evidence, providerRequests: count('providerRequest') - before.requests, providerInvocations: count('providerInvocation') - before.invocations };
    assert.equal(count('observerLoaded') - before.observers, 1);
    assert.deepEqual(observed, { credentialReads: 0, profileMetadata: 0, profileEvidenceReads: 0, providerRequests: 0, providerInvocations: 0 });
    denialEvidence.push({ name, ...observed });
  };
  denyConsent('absent', { ...quotaEnv, PA_AXI_QUOTA_CONSENT: undefined });
  for (const [name, change] of [
    ['wrong-deployment', { ...value, deploymentId: 'd-other' }], ['duplicate', { ...value, providers: [value.providers[0], value.providers[0]] }],
    ['unknown-provider', { ...value, providers: [{ id: 'other', profilePath: root }] }], ['unknown-field', { ...value, token: 'secret-sentinel' }],
    ['relative-profile', { ...value, providers: [{ id: 'codex', profilePath: 'relative' }] }], ['wrong-version', { ...value, version: '1' }],
  ]) { setConsent(change); denyConsent(name); }
  for (const mode of [0o644, 0o400, 0o1600]) { setConsent(value); fs.chmodSync(consent, mode); denyConsent(`mode-${mode.toString(8)}`); }
  setConsent(value); denyConsent('wrong-owner', { ...quotaEnv, AXI_SMOKE_FOREIGN_OWNER: '1' });
  setConsent(value); const link = join(root, 'consent-link.json'); fs.symlinkSync(consent, link); denyConsent('symlink', { ...quotaEnv, PA_AXI_QUOTA_CONSENT: link });
  fs.writeFileSync(consent, ' '.repeat(65537)); denyConsent('oversize');
  fs.writeFileSync(consent, 'secret-sentinel'); denyConsent('invalid-json');
  done(active, { cases: denialEvidence });
  active = 'quota-providers';
  setConsent(value);
  const beforeValid = rows().length;
  const result = command(shim(all, 'quota-axi'), ['quota', '--json'], quotaEnv);
  const providers = JSON.parse(result.stdout).providers;
  assert.deepEqual(providers.map(row => [row.provider, row.status]), [['codex', 'fresh'], ['claude', 'fresh']]);
  const effects = rows().slice(beforeValid);
  assert.deepEqual(effects.filter(row => row.kind === 'providerInvocation').map(row => row.provider), ['codex', 'claude']);
  assert.equal(effects.filter(row => row.kind === 'credentialRead').length, 2);
  assert.equal(effects.filter(row => row.kind === 'providerRequest').length, 2);
  assert.equal(effects.some(row => ['badProviderEnvironment', 'forbiddenProviderArguments'].includes(row.kind)), false);
  for (const row of providers) {
    assert.deepEqual(Object.keys(row).sort(), ['generatedAt', 'provider', 'reason', 'refreshedAt', 'status', 'windows']);
    assert.deepEqual(row.windows, [{ kind: 'session', percentUsed: 27, percentRemaining: 73, spentUsd: 2, limitUsd: 10, windowSeconds: 18000, resetsAt: '2026-10-10T09:00:00.000Z' }]);
  }
  done(active, { providers, credentialReads: effects.filter(row => row.kind === 'credentialRead').length, providerRequests: effects.filter(row => row.kind === 'providerRequest').length, separateSubprocesses: effects.filter(row => row.kind === 'providerInvocation').length, environment: 'exact positive allowlist verified before harness injection' });
  active = 'quota-states';
  const states = [];
  for (const status of ['stale', 'unknown', 'expired', 'not-configured', 'invalid']) {
    const out = JSON.parse(command(shim(all, 'quota-axi'), ['quota'], { ...quotaEnv, AXI_SMOKE_STATE: status }).stdout).providers;
    assert.deepEqual(out.map(row => row.status), [status === 'invalid' ? 'unknown' : status, status === 'invalid' ? 'unknown' : status]);
    assert.equal(out.some(row => row.status === 'fresh'), false);
    if (status === 'unknown' || status === 'not-configured' || status === 'invalid') assert.equal(out.every(row => row.windows.length === 0), true);
    auditOutput(JSON.stringify(out));
    states.push({ fixture: status, providers: out });
  }
  done(active, { states, scope: 'constructed schema/redaction only; not pinned-provider acceptance' });

  active = 'quota-pinned-expiry';
  const pinnedStates = [];
  const jwt = payload => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${Buffer.from('synthetic-only-signature').toString('base64url')}`;
  const pinnedEnv = { ...quotaEnv, AXI_SMOKE_PINNED: '1', AXI_SMOKE_PINNED_PRELOAD: join(helperDir, 'pinned-quota.cjs') };
  for (const id of ['codex', 'claude']) {
    const profilePath = join(root, 'profiles', id);
    const file = join(profilePath, id === 'codex' ? 'auth.json' : '.credentials.json');
    const selected = { ...value, providers: [{ id, profilePath }] };
    setConsent(selected);
    for (const expiry of ['expired', 'unexpired', 'absent']) {
      const exp = expiry === 'expired' ? 1 : 4102444800;
      const profile = id === 'codex'
        ? { tokens: { access_token: jwt(expiry === 'absent' ? {} : { exp }), id_token: jwt({ exp: 1 }), refresh_token: 'secret-sentinel' } }
        : { claudeAiOauth: { accessToken: 'synthetic-only-never-a-vendor-token', ...(expiry === 'absent' ? {} : { expiresAt: exp * 1000 }), refreshToken: 'secret-sentinel' } };
      fs.writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
      for (const response of ['denied', 'fresh']) {
        const before = rows().length;
        const out = JSON.parse(command(shim(all, 'quota-axi'), ['quota'], { ...pinnedEnv, AXI_SMOKE_RESPONSE: response }).stdout).providers;
        const observed = rows().slice(before);
        assert.equal(out.length, 1);
        assert.equal(out[0].status, response === 'fresh' ? 'fresh' : expiry === 'expired' ? 'expired' : 'unknown');
        const upstream = observed.filter(row => row.kind === 'pinnedUpstreamState');
        assert.equal(upstream.length, 1);
        assert.equal(upstream[0].status, response === 'fresh' ? 'fresh' : 'auth_required');
        assert.equal(upstream[0].stale, false);
        assert.equal(upstream[0].windows, response === 'fresh' ? 1 : 0);
        assert.equal(observed.filter(row => row.kind === 'providerInvocation').length, 1);
        assert.equal(observed.filter(row => row.kind === 'pinnedTransportLoaded').length, 1);
        assert.equal(observed.filter(row => row.kind === 'providerRequest').length, id === 'codex' && response === 'fresh' ? 1 : id === 'claude' && response === 'denied' ? 1 : 2);
        assert.ok(observed.some(row => row.kind === 'credentialRead'));
        if (response === 'fresh') assert.equal(observed.filter(row => row.kind === 'profileEvidenceRead').length, 0);
        pinnedStates.push({ provider: id, expiry, response, status: out[0].status, requests: observed.filter(row => row.kind === 'providerRequest').length });
      }
    }
    const malformedEvidence = id === 'codex'
      ? JSON.stringify({ tokens: { access_token: jwt({ exp: 'malformed' }) } })
      : JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic', expiresAt: 'malformed' } });
    const duplicateEvidence = id === 'codex'
      ? `{"tokens":{},"tokens":${JSON.stringify({ access_token: jwt({ exp: 1 }) })}}`
      : '{"claudeAiOauth":{},"claudeAiOauth":{"accessToken":"synthetic","expiresAt":1000}}';
    for (const text of [malformedEvidence, duplicateEvidence]) {
      fs.writeFileSync(file, text);
      const before = rows().length;
      const out = JSON.parse(command(shim(all, 'quota-axi'), ['quota'], { ...pinnedEnv, AXI_SMOKE_RESPONSE: 'denied' }).stdout).providers;
      const observed = rows().slice(before);
      assert.equal(out[0].status, 'unknown');
      assert.equal(observed.find(row => row.kind === 'pinnedUpstreamState').status, 'auth_required');
      assert.ok(observed.some(row => row.kind === 'providerRequest'));
      pinnedStates.push({ provider: id, malformedExpiry: true, status: 'unknown' });
    }
    fs.writeFileSync(file, '{');
    const malformedBefore = rows().length;
    const malformedOut = JSON.parse(command(shim(all, 'quota-axi'), ['quota'], { ...pinnedEnv, AXI_SMOKE_RESPONSE: 'denied' }).stdout).providers;
    assert.equal(malformedOut[0].status, 'error');
    assert.equal(rows().slice(malformedBefore).filter(row => row.kind === 'providerRequest').length, 0);
    pinnedStates.push({ provider: id, malformedProfileJson: true, status: 'error', requests: 0 });
    fs.unlinkSync(file);
    const absentBefore = rows().length;
    const absentOut = JSON.parse(command(shim(all, 'quota-axi'), ['quota'], pinnedEnv).stdout).providers;
    assert.equal(absentOut[0].status, 'not-configured');
    assert.equal(rows().slice(absentBefore).filter(row => row.kind === 'providerRequest').length, 0);
    pinnedStates.push({ provider: id, absentProfile: true, status: 'not-configured', requests: 0 });
    fs.writeFileSync(file, JSON.stringify(id === 'codex' ? { tokens: { access_token: jwt({ exp: 1 }) } } : { accessToken: 'synthetic', expiresAt: 1000 }), { mode: 0o600 });
    setConsent({ ...selected, providers: [...selected.providers, { id: 'other', profilePath }] });
    denyConsent(`${id}-pinned-invalid-whole`, pinnedEnv);
    denyConsent(`${id}-pinned-no-consent`, { ...pinnedEnv, PA_AXI_QUOTA_CONSENT: undefined });
    setConsent(selected);
    for (const unsafe of ['foreign', 'oversize', 'symlink']) {
      if (unsafe === 'oversize') fs.writeFileSync(file, ' '.repeat(65537));
      if (unsafe === 'symlink') { fs.unlinkSync(file); fs.symlinkSync(join(root, 'foreign-sentinel'), file); }
      const before = rows().length;
      const out = JSON.parse(command(shim(all, 'quota-axi'), ['quota'], { ...pinnedEnv, ...(unsafe === 'foreign' ? { AXI_SMOKE_FOREIGN_PROFILE: '1' } : {}) }).stdout).providers;
      assert.equal(out[0].status, 'unknown');
      assert.equal(rows().slice(before).filter(row => ['providerInvocation', 'providerRequest', 'profileEvidenceRead'].includes(row.kind)).length, 0);
      pinnedStates.push({ provider: id, unsafe, status: 'unknown', requests: 0 });
      if (unsafe === 'symlink') fs.unlinkSync(file);
      fs.writeFileSync(file, JSON.stringify(id === 'codex' ? { tokens: { access_token: jwt({ exp: 1 }) } } : { accessToken: 'synthetic', expiresAt: 1000 }), { mode: 0o600 });
    }
  }
  done(active, { scope: 'actual pinned quota-axi 0.1.56 CLI/providers/serialization; HTTP responses only synthetic', states: pinnedStates });

  function lifetime(id) {
    const dir = join(root, id); fs.mkdirSync(dir, { mode: 0o700 });
    const child = cp.spawn(process.execPath, ['-e', 'process.stdin.resume()'], { env: baseEnv, stdio: ['pipe', 'ignore', 'ignore'] });
    lifetimeChildren.push(child);
    assert.ok(child.pid);
    const env = { ...baseEnv, PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: dir, PA_AXI_CHROME_EXECUTABLE: chrome,
      PA_AXI_LIFECYCLE_PID: String(child.pid), PA_AXI_LIFECYCLE_START: browser.processIdentity(child.pid) };
    browserEnvs.push(env);
    return { env, child, dir, state: join(dir, 'axi-browser') };
  }
  const owner = f => JSON.parse(fs.readFileSync(join(f.state, 'owner.json'), 'utf8'));
  const alive = row => { const current = browser.inspectProcess(row.pid); return current && current.start === row.start && !current.zombie; };
  async function start(f) {
    const begin = performance.now();
    const out = await asyncCommand(shim(all, 'chrome-devtools-axi'), ['start'], f.env);
    assert.equal(out.stdout, 'browser ready\n');
    const elapsed = Math.round(performance.now() - begin);
    assert.ok(elapsed <= 30000);
    return elapsed;
  }
  async function cleanup(f, action) {
    const recorded = owner(f);
    const members = browser.ownedSessionProcesses(recorded, recorded.descendants || []);
    const begin = performance.now();
    await action();
    await wait(() => !fs.existsSync(f.state), 10000);
    await wait(() => members.every(row => !alive(row)), Math.max(1, 10000 - (performance.now() - begin)));
    const elapsed = Math.round(performance.now() - begin);
    assert.ok(elapsed <= 10000);
    return { cleanupMs: elapsed, observedDescendants: members.length, stateRemoved: true, descendantsGone: true };
  }
  active = 'browser-concurrent';
  const a = lifetime('d-browsera'); const b = lifetime('d-browserb');
  const readiness = await Promise.all([start(a), start(b)]);
  const owners = [owner(a), owner(b)];
  assert.notEqual(owners[0].pid, owners[1].pid); assert.notEqual(owners[0].port, owners[1].port);
  assert.notEqual(a.state, b.state);
  const concurrent = [];
  for (const [index, f] of [a, b].entries()) {
    const row = owner(f);
    assert.equal(browser.ownsListener({ pid: row.bridgePid, port: row.port }), true);
    assert.equal(fs.statSync(f.state).mode & 0o777, 0o700);
    assert.equal(fs.statSync(join(f.state, 'owner.json')).mode & 0o777, 0o600);
    const members = browser.ownedSessionProcesses(row, row.descendants || []);
    const processes = members.map(member => ({ ...member, args: fs.readFileSync(`/proc/${member.pid}/cmdline`, 'utf8').split('\0'), env: fs.readFileSync(`/proc/${member.pid}/environ`, 'utf8').split('\0') }));
    // The actual pinned MCP entry sets process.title, overwriting /proc argv.
    // Bind its live title to the declared Node/session here; the coordinator
    // must separately verify this exact PID's complete startup execve argv.
    const pinnedNode = fs.realpathSync(join(tools['chrome-devtools-mcp'].node, 'bin/node'));
    const mcps = processes.filter(p => p.args[0] === 'chrome-devtools-mcp' && fs.realpathSync(`/proc/${p.pid}/exe`) === pinnedNode);
    assert.equal(mcps.length, 1);
    const mcp = mcps[0];
    const privateTmp = mcp.env.find(value => value.startsWith('TMPDIR='))?.slice(7);
    assert.match(privateTmp, new RegExp(`^/proc/${row.pid}/fd/[0-9]+$`));
    assert.equal(fs.realpathSync(privateTmp), join(f.state, 'tmp'));
    assert.equal(fs.statSync(privateTmp).uid, process.getuid());
    assert.equal(fs.statSync(privateTmp).mode & 0o777, 0o700);
    assert.deepEqual(mcp.env.filter(Boolean).sort(), [
      `HOME=${join(f.state, 'home')}`, `XDG_CONFIG_HOME=${join(f.state, 'home', 'config')}`,
      `XDG_CACHE_HOME=${join(f.state, 'home', 'cache')}`, `TMPDIR=${privateTmp}`,
      `PATH=${dirname(row.node)}`, 'LANG=C.UTF-8',
      'CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1', 'CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1',
    ].sort());
    const bridge = processes.find(p => p.pid === row.bridgePid);
    assert.ok(bridge.env.includes('CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS=300000'));
    const chromeProcess = processes.find(p => p.args.some(arg => arg === `--user-data-dir=${join(f.state, 'profile')}`));
    assert.ok(chromeProcess, 'actual Chrome with exact private profile required');
    const executable = fs.realpathSync(`/proc/${chromeProcess.pid}/exe`);
    assert.match(executable, /chrome/);
    // Assert every owned TCP listening socket is loopback, not just bridge /health.
    const socketIds = new Set(members.flatMap(p => fs.readdirSync(`/proc/${p.pid}/fd`).flatMap(fd => { try { return [fs.readlinkSync(`/proc/${p.pid}/fd/${fd}`)]; } catch { return []; } })));
    const listeners = [];
    for (const table of ['tcp', 'tcp6']) {
      for (const line of fs.readFileSync(`/proc/net/${table}`, 'utf8').split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields[3] !== '0A' || !socketIds.has(`socket:[${fields[9]}]`)) continue;
        const address = fields[1].split(':')[0];
        assert.ok(address === '0100007F' || address === '00000000000000000000000001000000');
        listeners.push({ table, address, port: parseInt(fields[1].split(':')[1], 16) });
      }
    }
    assert.ok(listeners.length >= 1);
    // Real loopback HTML, not a success bridge. MCP must navigate and snapshot.
    const fixture = http.createServer((req, res) => res.end('<html><title>PAP240 fixture</title><body><button>Local fixture</button></body></html>'));
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    try {
      await asyncCommand(shim(all, 'chrome-devtools-axi'), ['open', `http://127.0.0.1:${fixture.address().port}/`], f.env);
      const snapshot = await asyncCommand(shim(all, 'chrome-devtools-axi'), ['snapshot'], f.env);
      assert.match(snapshot.stdout, /Local fixture|PAP240 fixture/);
    } finally { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
    concurrent.push({ deploymentId: row.id, state: f.state, profile: join(f.state, 'profile'), pid: row.pid, start: row.start, bridgePid: row.bridgePid, mcpPid: mcp.pid, mcpStart: mcp.start, port: row.port, readinessMs: readiness[index], chromeExecutable: executable, listeners, pinnedNode: row.node, pinnedMcp: row.mcp, idleMs: 300000, localNavigation: true });
  }
  done(active, { deployments: concurrent });
  active = 'browser-stop';
  done(active, await cleanup(a, () => asyncCommand(shim(all, 'chrome-devtools-axi'), ['stop'], a.env, 0, 15000)));
  active = 'browser-cancel';
  done(active, await cleanup(b, async () => { b.child.kill('SIGTERM'); }));
  active = 'browser-exit';
  const exiting = lifetime('d-browserexit'); await start(exiting);
  done(active, await cleanup(exiting, async () => { exiting.child.stdin.end(); }));
  active = 'browser-failure';
  const failing = lifetime('d-browserfailure'); await start(failing);
  const failedOwner = owner(failing);
  done(active, await cleanup(failing, async () => { assert.equal(browser.processIdentity(failedOwner.bridgePid), failedOwner.bridgeStart); process.kill(failedOwner.bridgePid, 'SIGKILL'); }));
  active = 'browser-foreign';
  const foreign = lifetime('d-browserforeign');
  fs.mkdirSync(foreign.state, { mode: 0o700 });
  const sentinel = join(foreign.state, 'profile-marker'); fs.writeFileSync(sentinel, 'foreign profile unchanged');
  const foreignStat = fs.statSync(foreign.state);
  // Structurally valid ownership, but a real foreign process that is not this
  // deployment's supervisor. Rejection must be process-ownership based, not
  // merely rejection of a malformed/incomplete JSON record.
  const foreignRecord = JSON.stringify({ id: foreign.env.PA_DEPLOYMENT_ID, dir: foreign.dir,
    lifecyclePid: foreign.child.pid, lifecycleStart: foreign.env.PA_AXI_LIFECYCLE_START,
    token: randomUUID(), pid: foreign.child.pid, start: browser.processIdentity(foreign.child.pid), port: 19001,
    inode: foreignStat.ino, device: foreignStat.dev,
    node: join(tools['chrome-devtools-axi'].node, 'bin/node'),
    entrypoint: join(tools['chrome-devtools-axi'].store, 'lib/chrome-devtools-axi/node_modules/chrome-devtools-axi/dist/bin/chrome-devtools-axi.js'),
    mcp: join(tools['chrome-devtools-mcp'].store, 'lib/chrome-devtools-mcp/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'), chrome });
  fs.writeFileSync(join(foreign.state, 'owner.json'), foreignRecord, { mode: 0o600 });
  assert.match((await asyncCommand(shim(all, 'chrome-devtools-axi'), ['start'], foreign.env, 1)).stderr, /^AXI_POLICY_REJECTED:/);
  await assert.rejects(browser.cleanupManagedBrowser(foreign.env));
  assert.equal(browser.processIdentity(foreign.child.pid), foreign.env.PA_AXI_LIFECYCLE_START);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'foreign profile unchanged');
  assert.equal(fs.readFileSync(join(foreign.state, 'owner.json'), 'utf8'), foreignRecord);
  done(active, { processUntouched: true, profileUntouched: true, ownerUntouched: true });
  // Do not ask teardown to remove foreign state; preserve it until the isolated
  // fixture root itself is disposed by the coordinator after process exit.
  browserEnvs.splice(browserEnvs.indexOf(foreign.env), 1);
  active = 'browser-collision';
  const colliding = lifetime('d-browsercollision');
  forceCollision = true;
  const collisionStart = performance.now();
  await assert.rejects(browser.runBrowserCommand({ node: join(tools['chrome-devtools-axi'].node, 'bin/node'), entrypoint: join(tools['chrome-devtools-axi'].store, 'lib/chrome-devtools-axi/node_modules/chrome-devtools-axi/dist/bin/chrome-devtools-axi.js'), mcp: join(tools['chrome-devtools-mcp'].store, 'lib/chrome-devtools-mcp/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'), chrome, args: ['start'], env: colliding.env }));
  assert.ok(collisionServer && collisionServer.listening);
  assert.equal(browser.ownsListener({ pid: process.pid, port: collisionServer.address().port }), true);
  assert.equal(fs.existsSync(colliding.state), false);
  assert.ok(performance.now() - collisionStart <= 40000);
  done(active, { rejectionMs: Math.round(performance.now() - collisionStart), foreignListenerUntouched: true, ownedStateRemoved: true });
  await new Promise(resolve => collisionServer.close(resolve)); collisionServer = undefined;
  active = 'browser-idle';
  const idle = lifetime('d-browseridle'); await start(idle);
  const idleOwner = owner(idle); const idleMembers = browser.ownedSessionProcesses(idleOwner, idleOwner.descendants || []);
  const idleStart = performance.now();
  await wait(() => !fs.existsSync(idle.state), 310000);
  const idleMs = Math.round(performance.now() - idleStart);
  assert.ok(idleMs >= 299000 && idleMs <= 310000);
  await wait(() => idleMembers.every(row => !alive(row)), 10000);
  done(active, { configuredIdleMs: 300000, measuredIdleMs: idleMs, stateRemoved: true, descendantsGone: true });

  const events = rows();
  const subprocesses = events.filter(row => row.kind === 'subprocess');
  assert.ok(count('observerLoaded') > 0);
  report.effectCounters = {
    credentialReads: count('credentialRead'), profileMetadata: count('profileMetadata'), profileEvidenceReads: count('profileEvidenceRead'), providerRequests: count('providerRequest'), providerInvocations: count('providerInvocation'),
    delegatedRefresh: subprocesses.filter(row => row.args.includes('--refresh') || (row.args.includes('--provider') && !row.args.includes('--no-credential-refresh'))).length,
    inference: subprocesses.filter(row => row.args.some(arg => /^(infer|inference|--allow-claude-inference)$/.test(arg))).length,
    routing: subprocesses.filter(row => row.args.some(arg => /^(route|routing)$/.test(arg))).length,
    mcpTelemetry: count('unexpectedNetwork'),
    observerLoads: count('observerLoaded'),
  };
  assert.equal(count('badProviderEnvironment') + count('forbiddenProviderArguments') + count('unexpectedSubprocess') + count('unexpectedDiscovery'), 0);
  auditOutput(JSON.stringify(report));
} catch (error) {
  // Only a stable case ID is published. Node assertion messages can include
  // synthetic upstream output, so never log stack/message/raw stderr.
  // Record only our source location, never raw assertion values/errors that
  // may contain credential, identity or path sentinels from negative fixtures.
  const location = /runtime\.mjs:(\d+):(\d+)/.exec(error.stack ?? '');
  report.cases[active] = { status: 'failed', failureKind: error.constructor.name,
    ...(location ? { failureLine: Number(location[1]), failureColumn: Number(location[2]) } : {}),
    ...(error.exitEvidence ? { exitEvidence: error.exitEvidence } : {}) };
  process.exitCode = 1;
} finally {
  for (const env of browserEnvs) { try { await browser?.cleanupManagedBrowser(env); } catch { report.cleanupFailure = true; process.exitCode = 1; } }
  for (const child of lifetimeChildren) { if (child.exitCode === null) { child.stdin?.end(); child.kill('SIGTERM'); } }
  if (providerServer) { providerServer.kill('SIGTERM'); await new Promise(resolve => { if (providerServer.exitCode !== null) resolve(); else { providerServer.once('exit', resolve); setTimeout(() => { providerServer.kill('SIGKILL'); resolve(); }, 3000).unref(); } }); }
  if (collisionServer?.listening) await new Promise(resolve => collisionServer.close(resolve));
  process.stdout.write(JSON.stringify(report) + '\n');
}
