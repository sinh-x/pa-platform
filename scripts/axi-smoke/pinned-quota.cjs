// Test-only transport preload. Executes the REAL pinned quota CLI/provider and
// serializer; only HTTP responses are synthetic. Never installed or exposed as
// a production endpoint option. The parent validates fixed argv/env first.
const fs = require('node:fs');
const cp = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { syncBuiltinESMExports } = require('node:module');
const append = fs.appendFileSync.bind(fs);
const event = (kind, detail = {}) => append(process.env.AXI_SMOKE_LEDGER, JSON.stringify({ kind, ...detail }) + '\n', { mode: 0o600 });
const root = process.env.AXI_SMOKE_ROOT;
const profile = process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR;
if (!root || !profile || !profile.startsWith(root + '/profiles/')) throw new Error('AXI_SMOKE_PROFILE_DENIED');
for (const name of ['readFileSync', 'openSync', 'accessSync', 'statSync', 'lstatSync', 'readdirSync']) {
  const original = fs[name];
  fs[name] = (...args) => {
    const path = String(args[0]);
    if (path === process.env.AXI_SMOKE_LEDGER) return original(...args);
    if (path.startsWith(root + '/') && !path.startsWith(profile + '/')) {
      event('unexpectedDiscovery'); throw new Error('AXI_SMOKE_DISCOVERY_DENIED');
    }
    if (path.startsWith(profile + '/')) event('credentialRead');
    return original(...args);
  };
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  cp[name] = () => { event('unexpectedSubprocess'); throw new Error('AXI_SMOKE_CHILD_DENIED'); };
}
for (const module of [http, https]) for (const name of ['request', 'get']) {
  module[name] = () => { event('unexpectedNetwork'); throw new Error('AXI_SMOKE_NETWORK_DENIED'); };
}
net.Socket.prototype.connect = () => { event('unexpectedNetwork'); throw new Error('AXI_SMOKE_NETWORK_DENIED'); };
const endpoints = new Map([
  ['https://chatgpt.com/backend-api/wham/usage', 'codex-usage'],
  ['https://chatgpt.com/backend-api/codex/usage', 'codex-fallback'],
  ['https://api.anthropic.com/api/oauth/usage', 'claude-usage'],
  ['https://api.anthropic.com/api/oauth/profile', 'claude-profile'],
]);
globalThis.fetch = async (input, init) => {
  const endpoint = endpoints.get(String(input));
  const provider = process.env.CODEX_HOME ? 'codex' : 'claude';
  if (!endpoint || !endpoint.startsWith(provider) || (init.method && init.method !== 'GET')) {
    event('unexpectedNetwork'); throw new Error('AXI_SMOKE_ENDPOINT_DENIED');
  }
  // Observe requests without ever writing bearer headers, IDs or raw errors.
  event('providerRequest', { endpoint });
  if (endpoint === 'claude-profile' || process.env.AXI_SMOKE_RESPONSE !== 'fresh') {
    return new Response('secret-sentinel identity-sentinel /path-sentinel', { status: 401 });
  }
  const usage = provider === 'codex'
    ? { email: 'identity-sentinel', rate_limit: { primary_window: { used_percent: 27, limit_window_seconds: 18000, reset_at: 4102444800 } } }
    : { five_hour: { utilization: 27, resets_at: '2100-01-01T00:00:00Z' } };
  return new Response(JSON.stringify(usage), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
syncBuiltinESMExports();
event('pinnedTransportLoaded');
