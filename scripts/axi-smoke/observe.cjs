// Test-only preload for installed managed CLI subprocesses. Not installed by Nix,
// not a production endpoint flag. Provider effects alone are synthetic; policy,
// consent validation, environment scrubbing and result parsing are installed code.
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
const credential = path => typeof path === 'string' && (path.startsWith(root + '/profiles/') || path.startsWith('/path-sentinel') || path.startsWith('/identity-sentinel'));
for (const name of ['readFileSync', 'openSync', 'accessSync', 'statSync', 'lstatSync', 'readdirSync']) {
  const original = fs[name];
  fs[name] = (...args) => { if (credential(args[0])) event('credentialRead'); return original(...args); };
}
for (const name of ['readFile', 'open', 'access', 'stat', 'lstat', 'readdir']) {
  const original = fs[name];
  fs[name] = (...args) => { if (credential(args[0])) event('credentialRead'); return original(...args); };
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
  fs.promises[name] = (...args) => { if (credential(args[0])) event('credentialRead'); return original(...args); };
}
const originalStat = fs.fstatSync;
fs.fstatSync = (...args) => {
  const stat = originalStat(...args);
  // Synthetic wrong-owner metadata is a test-only effect; no chown/sudo or
  // operator credential is needed. Installed consent validation still runs.
  if (process.env.AXI_SMOKE_FOREIGN_OWNER === '1') stat.uid += 1;
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
  // Delegate to a bounded synthetic worker. It really reads the synthetic
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
