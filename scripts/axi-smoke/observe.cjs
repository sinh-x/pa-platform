// Test-only preload for installed managed CLI subprocesses. Not installed by Nix,
// not a production endpoint flag. Generic status fixtures replace providers;
// pinned cases retain the real CLI/providers and replace only HTTP transport.
// Policy, consent, environment scrubbing and parsing are always installed code.
const fs = require('node:fs');
const cp = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const root = process.env.AXI_SMOKE_ROOT;
const append = fs.appendFileSync.bind(fs);
const ledger = process.env.AXI_SMOKE_LEDGER;
const event = (kind, detail = {}) => append(ledger, JSON.stringify({ kind, ...detail }) + '\n', { mode: 0o600 });
const profileFds = new Set();
const credential = path => {
  if (typeof path !== 'string') return false;
  const fd = /^\/proc\/self\/fd\/(\d+)(?:\/|$)/.exec(path)?.[1];
  let anchored = '';
  if (fd) { try { anchored = fs.readlinkSync(`/proc/self/fd/${fd}`) + path.slice(path.indexOf(fd) + fd.length); } catch {} }
  return path.startsWith(root + '/profiles/') || anchored.startsWith(root + '/profiles/') || path.startsWith('/path-sentinel') || path.startsWith('/identity-sentinel') || (fd && profileFds.has(Number(fd)));
};
for (const name of ['readFileSync', 'openSync', 'accessSync', 'statSync', 'lstatSync', 'readdirSync']) {
  const original = fs[name];
  fs[name] = (...args) => {
    const observed = credential(args[0]);
    if (observed) event(name === 'readFileSync' ? 'credentialRead' : 'profileMetadata');
    let result;
    try { result = original(...args); }
    catch (error) {
      // Safe fixture diagnostics: never retain pathname, bytes or raw errors.
      event('fixtureFsFailure', { operation: name, code: typeof error.code === 'string' ? error.code : 'unknown' });
      throw error;
    }
    if (name === 'openSync' && observed) profileFds.add(result);
    return result;
  };
}
for (const name of ['readFile', 'open', 'access', 'stat', 'lstat', 'readdir']) {
  const original = fs[name];
  fs[name] = (...args) => { if (credential(args[0])) event(name === 'readFile' ? 'credentialRead' : 'profileMetadata'); return original(...args); };
}
for (const module of [http, https]) {
  for (const name of ['request', 'get']) {
    module[name] = (...args) => {
      event('unexpectedNetwork');
      throw new Error('AXI_SMOKE_NETWORK_DENIED');
    };
  }
}
net.Socket.prototype.connect = (...args) => { event('unexpectedNetwork'); throw new Error('AXI_SMOKE_NETWORK_DENIED'); };
// Promise APIs and non-sync child creation must not escape denial counters.
for (const name of ['readFile', 'open', 'access', 'stat', 'lstat', 'readdir']) {
  const original = fs.promises[name].bind(fs.promises);
  fs.promises[name] = (...args) => { if (credential(args[0])) event(name === 'readFile' ? 'credentialRead' : 'profileMetadata'); return original(...args); };
}
const originalReadSync = fs.readSync;
fs.readSync = (...args) => { if (profileFds.has(args[0])) event('profileEvidenceRead'); return originalReadSync(...args); };
const originalClose = fs.closeSync;
fs.closeSync = fd => { profileFds.delete(fd); return originalClose(fd); };
const originalStat = fs.fstatSync;
fs.fstatSync = (...args) => {
  const stat = originalStat(...args);
  if (stat.isDirectory()) event('profileDirectoryCheck', {
    owner: stat.uid === (typeof stat.uid === 'bigint' ? BigInt(process.getuid()) : process.getuid()),
    rootOwned: stat.uid === (typeof stat.uid === 'bigint' ? 0n : 0),
    mode: Number(stat.mode) & 0o7777,
  });
  // Synthetic wrong-owner metadata is a test-only effect; no chown/sudo or
  // operator credential is needed. Installed consent validation still runs.
  if (process.env.AXI_SMOKE_FOREIGN_OWNER === '1' || (process.env.AXI_SMOKE_FOREIGN_PROFILE === '1' && stat.isFile() && profileFds.has(args[0]))) stat.uid += typeof stat.uid === 'bigint' ? 1n : 1;
  return stat;
};
for (const name of ['spawn', 'exec', 'execFile', 'fork']) {
  cp[name] = (...args) => { event('unexpectedSubprocess'); throw new Error('AXI_SMOKE_CHILD_DENIED'); };
}
const originalSpawnSync = cp.spawnSync;
cp.spawnSync = (node, args, options) => {
  event('subprocess', { executable: node, args });
  if (args[0] !== process.env.AXI_SMOKE_QUOTA_ENTRY) return originalSpawnSync(node, args, options);
  const provider = args[3];
  const wanted = [process.env.AXI_SMOKE_QUOTA_ENTRY, 'quota', '--provider', provider, '--profile-only', '--no-credential-refresh', '--json'];
  if (!['codex', 'claude'].includes(provider) || JSON.stringify(args) !== JSON.stringify(wanted)) {
    event('forbiddenProviderArguments');
    throw new Error('AXI_SMOKE_BAD_PROVIDER_ARGUMENTS');
  }
  const env = options.env;
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'PATH', 'LANG', 'NO_COLOR', 'TERM', provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'];
  if (Object.keys(env).sort().join('|') !== keys.sort().join('|') || env.PATH !== '' || env[provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] !== root + '/profiles/' + provider) {
    event('badProviderEnvironment');
    throw new Error('AXI_SMOKE_BAD_PROVIDER_ENVIRONMENT');
  }
  event('providerInvocation', { provider, profileOnly: true, noRefresh: true, json: true });
  if (process.env.AXI_SMOKE_PINNED === '1') {
    // Preserve the actual entrypoint, command, provider and serializer. Only
    // install a test-only in-process transport at the HTTP boundary.
    const result = originalSpawnSync(node, ['--require', process.env.AXI_SMOKE_PINNED_PRELOAD, ...args], {
      ...options, env: { ...env, AXI_SMOKE_LEDGER: ledger, AXI_SMOKE_ROOT: root,
        AXI_SMOKE_RESPONSE: process.env.AXI_SMOKE_RESPONSE },
    });
    try {
      const row = JSON.parse(result.stdout).providers[0];
      const status = ['fresh', 'auth_required', 'error', 'unavailable', 'stale', 'rate_limited'].includes(row.state?.status) ? row.state.status : 'unknown';
      event('pinnedUpstreamState', { provider, status, stale: row.state?.stale === true,
        windows: Array.isArray(row.windows) ? row.windows.length : 0 });
    } catch { event('pinnedInvalidSerialization'); }
    event('pinnedChildExit', { status: result.status, signal: result.signal,
      diagnosticClass: /loading shared libraries/.test(result.stderr || '') ? 'native-loader' : /MODULE_NOT_FOUND/.test(result.stderr || '') ? 'missing-module' : /TypeError/.test(result.stderr || '') ? 'type-error' : /ReferenceError/.test(result.stderr || '') ? 'reference-error' : /AXI_SMOKE_[A-Z_]+/.exec(result.stderr || '')?.[0] || /ERR_[A-Z_]+/.exec(result.stderr || '')?.[0] || 'other' });
    return result;
  }
  // Generic fixtures ONLY: delegate to a bounded synthetic worker. It reads the synthetic
  // profile and makes one loopback HTTP request; the server observes requests.
  // Environment assertions occur BEFORE adding harness-only worker parameters.
  return originalSpawnSync(node, [process.env.AXI_SMOKE_WORKER, provider], {
    ...options, env: { ...env, AXI_SMOKE_LEDGER: ledger, AXI_SMOKE_ROOT: root,
      AXI_SMOKE_PORT: process.env.AXI_SMOKE_PORT, AXI_SMOKE_STATE: process.env.AXI_SMOKE_STATE },
  });
};
syncBuiltinESMExports();
// Ensure an observer was actually loaded in every tested CLI, including denials.
event('observerLoaded');
