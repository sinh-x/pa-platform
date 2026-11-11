import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:https";
import { gzipSync } from "node:zlib";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { extractPublicText } from "../public-web/extract.js";
import { fetchCurlPublicHop, publicCurlArguments, parseCurlHeaders } from "../public-web/curl.js";
import { publicWebRuntime } from "../public-web/runtime.js";
import { runWebProcess } from "../public-web/process.js";
import { readPublicWeb } from "../public-web/reader.js";
import { PublicWebError, WEB_LIMITS } from "../public-web/types.js";

const signal = () => AbortSignal.timeout(10000);
const code = (expected: string) => (error: unknown) => error instanceof PublicWebError && error.code === expected;

test("fixed Python article extraction parses attributes, joins articles without nested duplication, preserves code/table/Unicode", async () => {
  const source = '<html><head><title>README &amp; source</title></head><body><nav>Navigation</nav>' +
    '<article data-note="hidden aria-hidden=true is only an example"><h1>Install</h1><p>Visible README 😀</p>' +
    '<ul><li>First</li><li>Second</li></ul><table><tr><th>RAM</th><td>16 GiB fixture</td></tr></table>' +
    '<pre><code>pip install fixture\n    print("hello")</code></pre><article><p>Nested once</p></article>' +
    '<div hidden>Hidden text</div><p aria-hidden="true">Hidden ARIA</p><p style="display: none">Hidden CSS</p>' +
    '<script>execute_never()</script><style>not text</style></article><article><h2>Second article</h2></article><footer>Footer</footer></body></html>';
  const result = await extractPublicText(source, "text/html", signal());
  assert.equal(result.title, "README & source");
  for (const text of ["Install", "Visible README 😀", "- First", "- Second", " | RAM | 16 GiB fixture", 'pip install fixture\n    print("hello")', "Second article"]) assert.ok(result.text.includes(text), text);
  assert.equal(result.text.split("Nested once").length, 2);
  assert.doesNotMatch(result.text, /Navigation|Footer|Hidden|execute_never|not text/);
  for (const html of ['<article hidden>not visible</article><p>Fallback</p>', '<article></article><p>Fallback</p>', '<p>Fallback</p>']) {
    assert.equal((await extractPublicText(html, "text/html", signal())).text, "Fallback");
  }
  assert.equal((await extractPublicText('plain 😀\n    code', 'text/plain', signal())).text, 'plain 😀\n    code');
  await assert.rejects(() => extractPublicText('<div>'.repeat(513) + 'text', 'text/html', signal()), code('WEB_LIMIT'));
  for (const html of ['<article>unfinished', '<div hidden>unfinished', '<script/>unfinished', 'text<!--unfinished', 'text<tag attr="unfinished']) await assert.rejects(() => extractPublicText(html, "text/html", signal()), code("WEB_UNSUPPORTED"));
});

test("Python extraction participates in original result bounds, exact digests and public-response allowance", async () => {
  const body = Buffer.from('<article><h1>README</h1><p>api_key=EXAMPLE</p><p>' + '😀'.repeat(20000) + '</p></article>');
  const result = await readPublicWeb('https://www.public-site.com/page', 'pi-tool-result:fixture/workers|1', signal(), {
    patterns: () => ({ configPath: 'synthetic', patterns: [] }), resolve: async () => ['93.184.216.34'],
    fetch: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body, compressedBytes: body.length }),
  });
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.match(result.text, /README.*\n.*api_key=EXAMPLE/s);
  assert.equal(result.coverage.clipped, true); assert.ok(result.coverage.extractedCodePoints > result.coverage.returnedCodePoints);
  assert.equal(result.bodySha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(result.textSha256, createHash('sha256').update(result.text).digest('hex'));
  assert.ok(Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }], details: {} })) <= WEB_LIMITS.replyBytes);
});

test("worker owner bounds stdout/stderr, reaps cancelled workers, and reports unavailable executables without raw diagnostics", async () => {
  const runtime = publicWebRuntime();
  await assert.rejects(() => runWebProcess('/no/such/public-reader', [], signal(), { outputBytes: 64 }), code('WEB_POLICY'));
  for (const stream of ['stdout', 'stderr']) await assert.rejects(() => runWebProcess(runtime.python,
    ['-I', '-c', `import sys; sys.${stream}.write('x'*100000)`], signal(), { outputBytes: 64 }), code('WEB_LIMIT'));
  const abort = new AbortController();
  const pending = runWebProcess(runtime.python, ['-I', '-c', 'import time; time.sleep(60)'], abort.signal, { outputBytes: 64 });
  setTimeout(() => abort.abort(), 50);
  await assert.rejects(() => pending, code('WEB_CANCELLED'));
  const stubborn = new AbortController();
  const ignoringTerm = runWebProcess(runtime.python, ['-I', '-c', 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'], stubborn.signal, { outputBytes: 64 });
  setTimeout(() => stubborn.abort(), 100);
  await assert.rejects(() => ignoringTerm, code('WEB_CANCELLED'));
  const exited = await runWebProcess(runtime.python, ['-I', '-c', 'raise SystemExit(7)'], signal(), { outputBytes: 64 });
  assert.equal(exited.status, 7);
  await assert.rejects(() => extractPublicText('safe', 'text/plain', signal(), { ...runtime, python: '/no/such/python' }), code('WEB_POLICY'));
});

test("worker cleanup uncertainty is not silently cleared when a pipe owner outlives its parent", { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-web-unsettled-')), pidFile = join(dir, 'pid');
  const runtime = publicWebRuntime(), abort = new AbortController();
  const pending = runWebProcess(runtime.python, ['-I', '-c',
    'import subprocess,sys; p=subprocess.Popen([sys.executable,"-I","-c","import time; time.sleep(60)"],stdin=subprocess.DEVNULL); open(sys.argv[1],"w").write(str(p.pid))', pidFile], abort.signal, { outputBytes: 64 });
  const timer = setTimeout(() => abort.abort(), 250);
  try { await assert.rejects(() => pending, code('WEB_CLEANUP')); }
  finally {
    clearTimeout(timer);
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("actual locked curl uses pinned public connection, TLS hostname checks, controlled environment and bounded response before fixed Python", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-web-workers-'));
  const runtime = publicWebRuntime();
  const cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem'), library = join(dir, 'connect.so'), log = join(dir, 'connect.log');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=www.public-site.com', '-addext', 'subjectAltName=DNS:www.public-site.com'], { stdio: 'ignore' });
  execFileSync('cc', ['-shared', '-fPIC', '-o', library, fileURLToPath(new URL('./fixtures/public-web-connect.c', import.meta.url)), '-ldl']);
  let requests = 0;
  const html = '<article><h1>README fixture</h1><p>Meaningful article.</p></article>';
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
    requests++;
    assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.referer, undefined);
    assert.equal(request.headers['x-poison'], undefined); assert.equal(request.headers['accept-encoding'], 'identity');
    if (request.url === '/redirect') { response.writeHead(302, { location: 'https://127.0.0.1/' }); response.end('not evidence'); }
    else if (request.url === '/large') { response.writeHead(200, { 'content-type': 'text/plain', 'content-length': WEB_LIMITS.bodyBytes + 1 }); response.end(); }
    else if (request.url === '/bomb') { response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); response.end(gzipSync(Buffer.alloc(WEB_LIMITS.bodyBytes + 1, 97))); }
    else if (request.url === '/stall') { response.writeHead(200, { 'content-type': 'text/plain' }); response.write('partial'); }
    else { response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); response.end(gzipSync(Buffer.from(html))); }
  });
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const wrapper = join(dir, 'curl-fixture');
  // Test-only launcher: inject a connect syscall shim into the REAL pinned curl.
  // Production runWebProcess still supplies its exact clean environment and argv.
  writeFileSync(wrapper, `#!/bin/sh\nexport LD_PRELOAD='${library}' PA_TEST_CONNECT_PORT='${port}' PA_TEST_CONNECT_LOG='${log}'\nexec '${runtime.curl}' "$@"\n`, { mode: 0o700 });
  const fixtureRuntime = { ...runtime, curl: wrapper, ca: cert };
  const poisoned = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'CURL_HOME', 'HOME', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'PYTHONPATH'];
  const before = Object.fromEntries(poisoned.map(name => [name, process.env[name]]));
  writeFileSync(join(dir, '.curlrc'), 'header = "X-Poison: inherited"\ninsecure\nproxy = "http://127.0.0.1:9"\n');
  writeFileSync(join(dir, '.netrc'), 'machine www.public-site.com login inherited password synthetic\n');
  for (const name of poisoned) process.env[name] = name.includes('PROXY') ? 'http://127.0.0.1:9' : dir;
  try {
    const response = await fetchCurlPublicHop(new URL('https://www.public-site.com/'), '93.184.216.34', signal(), fixtureRuntime);
    assert.equal(response.status, 200); assert.equal(response.body.toString(), html);
    assert.equal((await extractPublicText(response.body.toString(), 'text/html', signal())).text, 'README fixture\n\nMeaningful article.');
    const beforeMismatch = requests;
    await assert.rejects(() => fetchCurlPublicHop(new URL('https://wrong.public-site.com/'), '93.184.216.34', signal(), fixtureRuntime), code('WEB_NETWORK'));
    assert.equal(requests, beforeMismatch, 'hostname mismatch sends no HTTP request');
    await assert.rejects(() => fetchCurlPublicHop(new URL('https://www.public-site.com/'), '93.184.216.34', signal(), { ...fixtureRuntime, ca: runtime.ca }), code('WEB_NETWORK'));
    assert.equal(requests, beforeMismatch, 'untrusted certificate sends no HTTP request');
    for (const path of ['/large', '/bomb']) await assert.rejects(() => fetchCurlPublicHop(new URL('https://www.public-site.com' + path), '93.184.216.34', signal(), fixtureRuntime), code('WEB_LIMIT'));
    const result = await readPublicWeb('https://www.public-site.com/redirect', 'pi-tool-result:fixture/redirect', signal(), {
      patterns: () => ({ configPath: 'synthetic', patterns: [] }), resolve: async () => ['93.184.216.34'],
      fetch: (url, address, signal) => fetchCurlPublicHop(url, address, signal, fixtureRuntime),
    });
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, 'WEB_TARGET');
    const abort = new AbortController();
    const stalled = fetchCurlPublicHop(new URL('https://www.public-site.com/stall'), '93.184.216.34', abort.signal, fixtureRuntime);
    setTimeout(() => abort.abort(), 100); await assert.rejects(() => stalled, code('WEB_CANCELLED'));
    const beforeUnsafe = requests;
    for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1']) await assert.rejects(() => fetchCurlPublicHop(new URL('https://www.public-site.com/'), address, signal(), fixtureRuntime), code('WEB_TARGET'));
    assert.equal(requests, beforeUnsafe);
    assert.ok(existsSync(log)); assert.ok(readFileSync(log, 'utf8').trim().split('\n').every(value => value === '93.184.216.34:443'));
    const args = publicCurlArguments(new URL('https://www.public-site.com/$(never);--config=x'), '93.184.216.34', runtime.ca);
    assert.equal(args[0], '-q'); assert.ok(!args.includes('-L')); assert.ok(args.includes('--resolve'));
    assert.equal(args.at(-1), 'https://www.public-site.com/$(never);--config=x');
    assert.equal(parseCurlHeaders(Buffer.from('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n')).status, 200);
    assert.throws(() => parseCurlHeaders(Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Type: text/html\r\n\r\n')), code('WEB_UNSUPPORTED'));
  } finally {
    for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
