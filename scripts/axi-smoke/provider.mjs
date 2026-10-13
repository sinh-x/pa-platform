// Constructed schema/redaction fixtures ONLY, not actual pinned-provider
// acceptance. Explicit expiry below is deliberately synthetic. Real provider
// expiry coverage lives in pinned-quota.cjs (transport-only responses).
import fs from 'node:fs';
import http from 'node:http';
const ledger = process.env.AXI_SMOKE_LEDGER;
const event = kind => fs.appendFileSync(ledger, JSON.stringify({ kind }) + '\n', { mode: 0o600 });
if (process.argv[2] === 'server') {
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', chunk => { text += chunk; if (text.length > 4096) req.destroy(); });
    req.on('end', () => {
      event('providerRequest');
      const { provider, status } = JSON.parse(text);
      const state = { status: 'fresh', stale: false, refreshedAt: '2026-10-10T04:00:00Z', error: 'secret-sentinel identity-sentinel /path-sentinel' };
      if (status === 'stale') { state.status = 'stale'; state.stale = true; }
      if (status === 'expired') { state.status = 'auth_required'; state.reason = 'credentials_expired'; }
      if (status === 'unknown' || status === 'not-configured') state.status = 'unavailable';
      res.setHeader('Content-Type', 'application/json');
      res.end(status === 'invalid' ? 'secret-sentinel identity-sentinel /path-sentinel' : JSON.stringify({
        schemaVersion: 6, generatedAt: '2026-10-10T04:00:00Z', help: ['secret-sentinel'],
        providers: [{ provider, state, notSetUp: status === 'not-configured',
          accountKey: 'identity-sentinel', account: { email: 'identity-sentinel' }, token: 'secret-sentinel', source: '/path-sentinel',
          windows: status === 'unknown' || status === 'not-configured' ? [] : [{ kind: 'session', percentUsed: 27, percentRemaining: 73, spentUsd: 2, limitUsd: 10, windowSeconds: 18000, resetsAt: '2026-10-10T09:00:00Z', label: 'identity-sentinel', id: '/path-sentinel', resetText: 'secret-sentinel' }] }],
      }));
    });
  });
  server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.env.AXI_SMOKE_PORT_FILE, String(server.address().port), { mode: 0o600 }));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
} else {
  const provider = process.argv[2];
  const path = (provider === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR) + '/synthetic-credential.json';
  // Instrument the actual filesystem API boundary (not an assumed counter).
  const originalRead = fs.readFileSync;
  fs.readFileSync = (...args) => { event('credentialRead'); return originalRead(...args); };
  const credential = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (credential.token !== 'synthetic-only-never-a-vendor-token') process.exit(1);
  const body = JSON.stringify({ provider, status: process.env.AXI_SMOKE_STATE });
  const req = http.request({ hostname: '127.0.0.1', port: Number(process.env.AXI_SMOKE_PORT), path: '/', method: 'POST', timeout: 3000, headers: { 'Content-Type': 'application/json' } }, res => {
    let text = '';
    res.on('data', chunk => { text += chunk; if (text.length > 65536) req.destroy(); });
    res.on('end', () => { process.stdout.write(text); process.stderr.write('secret-sentinel identity-sentinel /path-sentinel'); });
  });
  req.on('error', () => process.exit(1));
  req.on('timeout', () => req.destroy());
  req.end(body);
}
