import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const here = dirname(fileURLToPath(import.meta.url));
export const CHROME = '/home/sinh/.nix-profile/bin/google-chrome-stable';
export const adapters = { ppa: 'pi', opa: 'opencode', cpa: 'claudecode' };
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const digest = path => hash(fs.readFileSync(path));
export const storePattern = /^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/\s]+$/;
export function parseArgs(argv, browser = false) {
  const flags = browser ? ['--inventory', '--chrome', '--output'] : ['--inventory', '--output'];
  assert.equal(argv.length, flags.length * 2, 'exact harness arguments required');
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(flags.includes(argv[i]) && !Object.hasOwn(values, argv[i]), 'unknown/duplicate argument');
    assert.ok(isAbsolute(argv[i+1]) && resolve(argv[i+1]) === argv[i+1], 'canonical absolute path required');
    values[argv[i]] = argv[i+1];
  }
  if (browser && values['--chrome']!==CHROME) throw Object.assign(new Error('Exact operator executable required.'),{diagnostic:'ARTIFACT_BROWSER_REQUIRED'});
  return values;
}
export function matrixCases() {
  const names = ['gh-axi', 'chrome-devtools-axi', 'quota-axi', 'lavish-axi', 'chrome-devtools-mcp'];
  const cases = ['prerequisites', 'defaults:x86_64-linux', 'defaults:aarch64-linux', 'inspection-tools', ...names.map(n => `pin:${n}`)];
  for (const s of ['x86_64-linux', 'aarch64-linux']) {
    for (let m = 0; m < 16; m++) cases.push(`eval:${s}:${m}`);
    for (const o of ['enableGhAxi', 'enableChromeDevtoolsAxi', 'enableQuotaAxi', 'enableLavishAxi'])
      for (const k of ['string', 'integer', 'null', 'list', 'set']) cases.push(`invalid:${s}:${o}:${k}`);
  }
  for (let m = 0; m < 16; m++) cases.push(`build:${m}`, `installed:${m}`);
  return cases.sort();
}
export class Ledger {
  constructor(required) {
    assert.equal(new Set(required).size, required.length);
    this.required = [...required].sort(); this.cases = {};
  }
  pass(id, evidence) {
    assert.ok(this.required.includes(id) && !Object.hasOwn(this.cases, id), 'unknown/duplicate case');
    assert.ok(evidence && typeof evidence === 'object' && Object.keys(evidence).length, 'empty evidence');
    this.cases[id] = { status: 'passed', evidence };
  }
  finish() {
    assert.deepEqual(Object.keys(this.cases).sort(), this.required, 'missing mandatory cases');
    assert.ok(Object.values(this.cases).every(c => c.status === 'passed' && !c.skip));
    return { required: this.required.length, passed: this.required.length, skipped: 0 };
  }
}
export function validateInventory(data) {
  assert.equal(data.schema, 'pa-lavish-inventory/v1'); assert.equal(data.status, 'passed');
  assert.match(data.featureSha, /^[a-f0-9]{40}$/);
  assert.deepEqual(data.requiredCases, matrixCases());
  assert.deepEqual(Object.keys(data.cases).sort(), matrixCases());
  assert.ok(Object.values(data.cases).every(c => c.status === 'passed' && c.evidence && !c.skip));
  assert.deepEqual(data.missingCases, []);
  assert.deepEqual(data.counts, { required: 113, passed: 113, skipped: 0 });
  assert.deepEqual(Object.keys(data.outputs).sort(), Array.from({ length: 16 }, (_, i) => String(i)).sort());
  assert.equal(new Set(Object.values(data.outputs)).size, 16);
  for (const p of Object.values(data.outputs)) assert.match(p, storePattern);
  for (const [n, v] of Object.entries({ 'gh-axi':'0.1.35', 'chrome-devtools-axi':'0.1.38', 'quota-axi':'0.1.56', 'lavish-axi':'0.1.67', 'chrome-devtools-mcp':'1.10.1' })) {
    assert.equal(data.tools[n].version, v); assert.match(data.tools[n].store, storePattern);
  }
  for (const n of ['bwrap', 'strace']) assert.match(data.inspection[n], /^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/]+\/bin\/[^/]+$/);
  return data;
}
export function traceLines(text) {
  const pending=new Map(),lines=[];
  for(const line of text.split('\n')) {
    const start=/^\s*(\d+)\s+(.*) <unfinished \.\.\.>$/.exec(line);
    const end=/^\s*(\d+)\s+<\.\.\. (\w+) resumed>(.*)$/.exec(line);
    if(start) {assert.ok(!pending.has(start[1]),'overlapping unfinished syscall');pending.set(start[1],start[2]);}
    else if(end) {assert.ok(pending.has(end[1]),'unpaired resumed syscall');lines.push(`${end[1]} ${pending.get(end[1])}${end[3]}`);pending.delete(end[1]);}
    else lines.push(line);
  }
  // A process may be killed while blocked. Its attempted syscall still counts;
  // no successful return is invented for that observation.
  for(const [pid,line] of pending)lines.push(`${pid} ${line} [no return observed]`);
  return lines;
}
export function auditTrace(text, root, observerPid, artifacts = [], helperRoot = here, chrome) {
  assert.ok(text.includes('execve(') && text.includes('socket('), 'missing actual effect observations');
  const counts = { forbiddenOutboundAttempts: 0, forbiddenOutboundSuccesses: 0, nonLoopbackListeners: 0,
    credentialAccesses: 0, forbiddenExecutions: 0, sentinelAccesses: 0,
    unauthorizedFileAttempts: 0, unauthorizedFileSuccesses: 0, unauthorizedSignals: 0 };
  const violations = [];
  const ownedPids = new Set([...text.matchAll(/^\s*(\d+)\s/gm)].map(m=>Number(m[1])));
  if(observerPid) ownedPids.add(observerPid);
  const protectedFiles = new Set(artifacts.flatMap(a=>[a.source,a.manifest,join(a.companion,'index.html')]));
  const within = (p, parent) => p === parent || p.startsWith(parent+'/');
  for (const line of traceLines(text)) {
    let bad = false;
    if (/\b(connect|sendto|sendmsg)\(/.test(line) && /AF_INET6?\b/.test(line) &&
      !/inet_addr\("127\.0\.0\.1"\)|inet_pton\(AF_INET6, "::1"/.test(line)) {
      counts.forbiddenOutboundAttempts++; if (/\)\s*=\s*(0|[1-9]\d*)\b/.test(line)) counts.forbiddenOutboundSuccesses++; bad = true;
    }
    if (/bind\(/.test(line) && /AF_INET6?\b/.test(line) && !/inet_addr\("127\.0\.0\.1"\)|inet_pton\(AF_INET6, "::1"/.test(line)) { counts.nonLoopbackListeners++; bad = true; }
    if (/\b(open|openat|openat2|readlink|statx|newfstatat)\(/.test(line) && /\/(?:\.netrc|\.npmrc|\.ssh\/|\.config\/gh\/hosts\.yml|\.codex\/auth\.json|\.claude\/\.credentials\.json)/.test(line)) { counts.credentialAccesses++; bad = true; }
    if (/execve\(/.test(line) && /\/(npm|npx|pnpm|curl|wget|tailscale|gh-axi|quota-axi|chrome-devtools-axi)(?:"|\/)/.test(line)) { counts.forbiddenExecutions++; bad = true; }
    if (/\b(open|openat|openat2)\(/.test(line) && line.includes(`${root}/forbidden-read-sentinel`) && Number(/^\s*(\d+)/.exec(line)?.[1]) !== observerPid) { counts.sentinelAccesses++; bad = true; }
    const caller = Number(/^\s*(\d+)/.exec(line)?.[1]);
    const pathMatch = /\b(?:open|openat|openat2|access|newfstatat|statx|readlink|unlink|unlinkat|rename|renameat|renameat2|mkdir|mkdirat|chmod|chown|link|linkat)\([^\n]*?"((?:[^"\\]|\\.)*)"/.exec(line);
    if (pathMatch) {
      let path; try { path=JSON.parse('"'+pathMatch[1]+'"'); } catch { path=undefined; }
      if(path?.startsWith('/')) {
        const write = /O_WRONLY|O_RDWR|O_CREAT|\b(?:unlink|unlinkat|rename|renameat|renameat2|mkdir|mkdirat|chmod|chown|link|linkat)\(/.test(line);
        const publicMetadata = /^\/etc\/(?:ld\.so\.cache|localtime|os-release|passwd|group|nsswitch\.conf|fonts(?:\/.*)?)$/.test(path);
        const evidenceAccess = caller===observerPid && within(path,dirname(root));
        const allowedRead = [root,helperRoot,'/nix','/proc','/dev','/tmp','/sys'].some(p=>within(path,p)) || publicMetadata || path===chrome || evidenceAccess;
        const allowedWrite = evidenceAccess || [root,'/tmp','/dev/shm'].some(p=>within(path,p)) || /^\/proc\/(?:self|\d+)\/fd\/\d+(?:\/.*)?$/.test(path) || ['/dev/null','/dev/tty'].includes(path);
        const unsafe = !allowedRead || write && (!allowedWrite || caller!==observerPid && protectedFiles.has(path))
          || /\/proc\/(?:self|\d+)\/(?:environ|mem)$/.test(path)
          || caller!==observerPid && path===`${root}/source-authority-sentinel`;
        if(unsafe) { counts.unauthorizedFileAttempts++;if(/\)\s*=\s*(?:0|[1-9]\d*)\b/.test(line))counts.unauthorizedFileSuccesses++;bad=true; }
      }
    }
    const signal = /\b(?:kill|tkill|tgkill)\((-?\d+)/.exec(line);
    if(signal && (Number(signal[1])<=1 || !ownedPids.has(Number(signal[1])))) {counts.unauthorizedSignals++;bad=true;}
    if (bad) violations.push(line);
  }
  return { counts, violations, traceSha256: hash(text), observation: 'kernel syscall attempts and returns, including blocked failures; not request interception' };
}
export function jsonFile(path, value) { fs.writeFileSync(path, JSON.stringify(value, null, 2)+'\n', { mode: 0o600 }); }
export function inventoryModule(inv, path) { return join(inv.outputs['8'], 'share/pa-platform/packages/pa-core/dist/artifacts', path + '.js'); }
export class Evidence {
  constructor(config, required) {
    this.config = config; this.output = config.output; this.inventory = config.inventory;
    this.ledger = new Ledger(required); this.commands = []; this.sessions = []; this.artifacts = [];
    this.root = join(this.output, 'synthetic'); fs.mkdirSync(this.root, { mode: 0o700 });
    for (const n of ['home', 'config', 'cache', 'data', 'tmp']) fs.mkdirSync(join(this.root, n), { mode: 0o700 });
    this.env = { PATH: '', HOME: join(this.root, 'home'), XDG_CONFIG_HOME: join(this.root, 'config'),
      XDG_CACHE_HOME: join(this.root, 'cache'), XDG_DATA_HOME: join(this.root, 'data'), TMPDIR: this.root,
      PA_AI_USAGE_HOME: join(this.root, 'home'), TZ: 'UTC', LC_ALL: 'C.UTF-8' };
    fs.writeFileSync(join(this.root, 'forbidden-read-sentinel'), 'synthetic forbidden read', { mode: 0o600 });
    fs.writeFileSync(join(this.root, 'source-authority-sentinel'), 'No approval/ticket authority.', { mode: 0o600 });
    this.sentinels = Object.fromEntries(['forbidden-read-sentinel', 'source-authority-sentinel'].map(n => [n, digest(join(this.root,n))]));
    this.before = this.snapshot();
  }
  async command(argv, env = this.env, expected = 0, diagnostic, timeout = 15000) {
    const n = this.commands.length + 1;
    const stdout = join(this.output, `command-${n}.stdout`), stderr = join(this.output, `command-${n}.stderr`);
    const fds = [stdout, stderr].map(p => fs.openSync(p, 'wx', 0o600));
    const row = { argv, startedAt: new Date().toISOString(), stdout, stderr }; this.commands.push(row);
    const start = performance.now();
    let child;
    try {
      const status = await new Promise((resolve, reject) => {
        child = cp.spawn(argv[0], argv.slice(1), { env, stdio: ['ignore', ...fds] });
        const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1000).unref(); }, timeout);
        child.once('error', e => { clearTimeout(timer); reject(e); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({code, signal}); });
      });
      Object.assign(row, status, { durationMs: performance.now()-start, endedAt: new Date().toISOString() });
      assert.equal(status.signal, null); assert.equal(status.code, expected);
    } catch(error) {
      if(!row.endedAt) Object.assign(row,{endedAt:new Date().toISOString(),durationMs:performance.now()-start,code:127,signal:null,launchFailure:error.constructor.name});
      throw error;
    } finally { fds.forEach(fd => fs.closeSync(fd)); }
    const out = fs.readFileSync(stdout, 'utf8'), err = fs.readFileSync(stderr, 'utf8');
    if (diagnostic) { assert.match(err, new RegExp(`^${diagnostic}:`)); assert.equal(out.trim(), ''); }
    if (expected === 0) assert.equal(err, '');
    return { out, err, durationMs: row.durationMs, command: n };
  }
  context(cli, ownerPid = process.pid) {
    const dir = join(this.root, `d-${randomBytes(6).toString('hex')}`); fs.mkdirSync(dir, { mode: 0o700 });
    return { cli, dir, env: { ...this.env, PA_DEPLOYMENT_ID: dir.split('/').at(-1), PA_DEPLOYMENT_DIR: dir,
      PA_ARTIFACT_ADAPTER: adapters[cli], PA_ARTIFACT_OWNER_PID: String(ownerPid) } };
  }
  async cli(f, args, code = 0, diagnostic, mask = '8', env = f.env) {
    const result = await this.command([join(this.inventory.outputs[mask], 'bin', f.cli), 'artifact', ...args], env, code, diagnostic);
    if (code !== 0) return result;
    const envelope = JSON.parse(result.out); assert.equal(envelope.schema, 'pa-artifact/v1');
    assert.deepEqual(Object.keys(envelope).sort(),['operation','payload','schema','status']);
    assert.equal(envelope.operation,args[0]==='render'?'render':`review-${args[1]}`);
    assert.ok(envelope.payload && typeof envelope.payload==='object');
    assert.ok(['rendered','running','stale','ended','stopped','exported','no-feedback'].includes(envelope.status));
    return { ...envelope, durationMs: result.durationMs, command: result.command };
  }
  async render(f, name, bytes = '# Synthetic heading\n\nSynthetic selected paragraph.\n') {
    const source = join(this.root, name + '.md'); fs.writeFileSync(source, bytes, { mode: 0o600 });
    const companion = join(this.root, name); const manifest = join(companion, 'manifest.json');
    const response = await this.cli(f, ['render','--source',source,'--output-dir',companion,'--json']);
    assert.equal(response.status,'rendered');
    assert.deepEqual(fs.readdirSync(companion).sort(), ['index.html', 'manifest.json']);
    const artifact = { source, companion, manifest, sourceSha256: digest(source), htmlSha256: digest(join(companion,'index.html')), manifestSha256: digest(manifest) };
    const m = JSON.parse(fs.readFileSync(manifest));
    assert.deepEqual(Object.keys(m).sort(),['anchors','htmlSha256','policyVersion','rendererVersion','schema','sourceRef','sourceSha256']);
    assert.equal(m.schema,'pa-artifact-manifest/v1'); assert.equal(m.sourceRef,source);
    assert.equal(m.sourceSha256,artifact.sourceSha256); assert.equal(m.htmlSha256,artifact.htmlSha256);
    assert.equal(m.rendererVersion,'pa-artifact-renderer/v1');assert.equal(m.policyVersion,'pa-artifact-policy/v1');
    for(const anchor of m.anchors) assert.equal(anchor.id,`source-L${anchor.startLine}-L${anchor.endLine}`);
    this.artifacts.push(artifact); return artifact;
  }
  async start(f, artifact) {
    const response = await this.cli(f, ['review','start','--manifest',artifact.manifest,'--json']);
    assert.equal(response.status, 'running'); assert.ok(response.durationMs <= 10000);
    assert.match(response.payload.sessionId, /^[a-f0-9]{48}$/);
    assert.equal(new URL(response.payload.url).hostname,'127.0.0.1');
    const session = { f, artifact, id: response.payload.sessionId, url: response.payload.url, payload: response.payload, startupMs: response.durationMs };
    this.sessions.push(session); return session;
  }
  async stop(s) {
    const r = await this.cli(s.f,['review','stop','--session',s.id,'--json']);
    assert.ok(r.durationMs <= 5000); assert.ok(['stopped','ended'].includes(r.status)); return r;
  }
  state(s) { return join(s.f.dir, 'artifact-review-v1', s.id); }
  owner(s) { return JSON.parse(fs.readFileSync(join(this.state(s),'owner.json'))); }
  async export(s, name, expected = 0, diagnostic) {
    const path = join(this.root, name+'.json');
    const result = await this.cli(s.f,['review','feedback','--session',s.id,'--output',path,'--timeout-ms','0','--json'],expected,diagnostic);
    return { path, result, ...(fs.existsSync(path) ? { bytes: fs.readFileSync(path) } : {}) };
  }
  event(s, extra = {}) { return { schema:'pa-artifact-feedback/v1',eventId:randomBytes(12).toString('hex'),sessionId:s.id,
    sourceRef:s.payload.sourceRef,sourceSha256:s.payload.sourceSha256,htmlSha256:s.payload.htmlSha256,
    target:{type:'document'},selectedText:'Synthetic',feedbackText:'Untrusted feedback, not authority.',...extra }; }
  snapshot() {
    const processes = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).flatMap(pid => {
      try { return [{ pid:Number(pid), stat:fs.readFileSync(`/proc/${pid}/stat`,'utf8'), argv:fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0') }]; } catch { return []; }
    });
    const files = [];
    const walk = p => { for (const n of fs.readdirSync(p)) { const q = join(p,n), st = fs.lstatSync(q); files.push({ path:q,mode:st.mode & 0o777, size:st.size, ...(st.isFile()?{sha256:digest(q)}:{}) }); if(st.isDirectory()) walk(q); } };
    walk(this.root);
    return { processes, files, tcp:fs.readFileSync('/proc/net/tcp','utf8'), tcp6:fs.readFileSync('/proc/net/tcp6','utf8') };
  }
  async cleanup() {
    const errors = [];
    for (const s of this.sessions) {
      try { await this.stop(s); } catch (e) { errors.push({ sessionId:s.id,kind:e.constructor.name }); }
    }
    for (const [n,h] of Object.entries(this.sentinels)) assert.equal(digest(join(this.root,n)),h);
    for (const a of this.artifacts) {
      assert.equal(digest(a.source),a.sourceSha256,'automatic source mutation');
      assert.equal(digest(join(a.companion,'index.html')),a.htmlSha256,'automatic companion mutation');
      assert.equal(digest(a.manifest),a.manifestSha256,'automatic manifest mutation');
    }
    this.after=this.snapshot();
    assert.deepEqual(errors, [], 'owned cleanup failure');
  }
  async assertQuiescentNamespace() {
    const prior=new Set(this.before.processes.map(p=>p.pid));
    const extraLive=()=>fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)&&!prior.has(Number(n))).filter(pid=>{
      try {const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');return !['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]);}catch{return false;}
    });
    const cleanup=await waitFor(()=>extraLive().length===0,5000);
    this.after = this.snapshot();this.after.ownedProcessCleanupMs=cleanup.elapsedMs;
    assert.ok(this.after.tcp.split('\n').slice(1).every(line=>line.trim().split(/\s+/)[3]!=='0A'),'remaining TCP listener');
    assert.ok(this.after.tcp6.split('\n').slice(1).every(line=>line.trim().split(/\s+/)[3]!=='0A'),'remaining IPv6 listener');
  }
}
export async function waitFor(fn, ms, interval = 25) {
  const start = performance.now();
  while (performance.now()-start <= ms) { const value = await fn(); if(value) return { value, elapsedMs:performance.now()-start }; await sleep(interval); }
  throw new Error('bounded observation timeout');
}
export async function post(s, route, body, headers = {}) {
  const origin = new URL(s.url).origin;
  return fetch(s.url+route, { method:'POST', headers:{origin,'content-type':'application/json',...headers}, body:JSON.stringify(body),signal:AbortSignal.timeout(3000) });
}
export function assertObserverStoreOwnership(stats) {
  assert.ok(stats.length>0 && stats.every(s=>s.uid===0 && (s.mode&0o222)===0),
    'observer namespace must preserve immutable host-root ownership; no UID-map policy relaxation or privilege bootstrap');
}
export function validateResults(report, required) {
  assert.equal(report.schema,'pa-lavish-results/v1');assert.equal(report.status,'passed');
  assert.deepEqual(report.requiredCases,[...required].sort());
  assert.deepEqual(Object.keys(report.cases).sort(),[...required].sort());
  assert.deepEqual(report.missingCases,[]);assert.equal(report.cleanupFailure,undefined);
  assert.deepEqual(report.counts,{required:required.length,passed:required.length,skipped:0});
  assert.ok(Object.values(report.cases).every(v=>v.status==='passed'&&v.evidence&&!v.skip));
  assert.ok(report.before && report.after && Array.isArray(report.commands));return report;
}
export async function launch(role, argv) {
  let output, report, ownsOutput=false;
  try {
    const args = parseArgs(argv, role === 'browser'); output = args['--output'];
    assert.ok(!fs.existsSync(output), 'output must be absent');
    assert.equal(fs.realpathSync(dirname(output)),dirname(output));
    const repo = resolve(here,'../..'); assert.ok(!output.startsWith(repo+'/'));
    fs.mkdirSync(output,{mode:0o700});ownsOutput=true;
    const inventory = validateInventory(JSON.parse(fs.readFileSync(args['--inventory'])));
    assert.equal(process.env.FEATURE_SHA,inventory.featureSha);
    const git = cp.spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}); assert.equal(git.status,0); assert.equal(git.stdout.trim(),inventory.featureSha);
    assert.equal(digest(join(repo,'flake.lock')),inventory.flakeLockSha256);
    assert.equal(process.env.PA_LAVISH_TEST_NETWORK,'loopback-only');
    assert.ok(!Object.hasOwn(process.env,'NODE_OPTIONS') && !Object.hasOwn(process.env,'NODE_PATH') && !Object.keys(process.env).some(k=>k.startsWith('LAVISH_AXI_')));
    const config = { role, output, inventory, inventorySha256:digest(args['--inventory']), chrome:args['--chrome'] };
    const bindChrome = [];
    if(role === 'browser') {
      try {assert.ok(fs.statSync(CHROME).isFile()); fs.accessSync(CHROME,fs.constants.X_OK);}
      catch {throw Object.assign(new Error('Operator-owned browser unavailable.'),{diagnostic:'ARTIFACT_BROWSER_REQUIRED'});}
      config.chromeIdentity = { executable:CHROME,realpath:fs.realpathSync(CHROME),sha256:digest(CHROME) };
      bindChrome.push('--ro-bind',config.chromeIdentity.realpath,CHROME);
    }
    jsonFile(join(output,'configuration.json'),config);
    const trace = join(output,'effects.strace');
    const command = [inventory.inspection.bwrap,'--unshare-net','--unshare-pid','--new-session','--die-with-parent',
      '--ro-bind','/nix','/nix','--proc','/proc','--dev','/dev','--perms','0700','--tmpfs','/tmp',
      '--ro-bind',here,here,'--bind',output,output,'--chdir',output,...bindChrome,
      inventory.inspection.strace,'-f','-qq','-v','-s','65536','-e','trace=process,network,file,signal','-o',trace,
      join(inventory.outputs['8'],'bin/pa-platform-node'),join(here,'worker.mjs'),join(output,'configuration.json')];
    const start = new Date().toISOString();
    const logs = ['observer.stdout','observer.stderr'].map(n=>fs.openSync(join(output,n),'wx',0o600));
    const child = cp.spawn(command[0],command.slice(1),{ env:{PATH:'',TZ:'UTC',LC_ALL:'C.UTF-8',TMPDIR:join(output,'synthetic')},stdio:['ignore',...logs] });
    const timer = setTimeout(()=>child.kill('SIGTERM'),role === 'runtime'? 1200000:300000);
    const exit = await new Promise((r,j)=>{child.once('error',j);child.once('exit',(code,signal)=>r({code,signal}));}).catch(error=>({code:127,signal:null,launchFailure:error.constructor.name})).finally(()=>{clearTimeout(timer);logs.forEach(fd=>fs.closeSync(fd));});
    jsonFile(join(output,'observer-command.json'),{argv:command,startedAt:start,endedAt:new Date().toISOString(),...exit});
    report = JSON.parse(fs.readFileSync(join(output,'worker-results.json')));
    const audit = auditTrace(fs.readFileSync(trace,'utf8'),join(output,'synthetic'),report.observerPid,report.artifacts,here,config.chrome);
    jsonFile(join(output,'network.json'),{...audit,cdp:report.network ?? [],listenersBefore:report.before?.tcp,listenersAfter:report.after?.tcp});
    report.observedEffects = audit; report.inventorySha256 = config.inventorySha256;
    assert.equal(exit.signal,null); assert.equal(exit.code,0);
    const api = await import(`./${role}.mjs`);
    validateResults(report,role==='runtime'?api.runtimeCases:api.browserCases);
    assert.ok(Object.values(audit.counts).every(v=>v===0),'forbidden actual effect, including attempts');
    report.status = 'passed'; jsonFile(join(output,'results.json'),report);
  } catch (e) {
    if(ownsOutput) jsonFile(join(output,'results.json'),{...report,schema:'pa-lavish-results/v1',status:'failed',harnessFailure:{kind:e.constructor.name,message:e.message},readiness:false});
    const browserPrerequisite=e.diagnostic==='ARTIFACT_BROWSER_REQUIRED'||report?.failure?.diagnostic==='ARTIFACT_BROWSER_REQUIRED';
    console.error(browserPrerequisite ? 'ARTIFACT_BROWSER_REQUIRED: browser prerequisite failed' : 'ARTIFACT_RUNTIME_FAILED: mandatory harness case/evidence failed');
    process.exitCode=browserPrerequisite?3:7;
  }
}
