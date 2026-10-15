// Source/self-test evidence only. No installed/browser acceptance is inferred.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import cp from 'node:child_process';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { CDP } from './cdp.mjs';
import { assertObserverStoreOwnership, auditTrace, CHROME, Evidence, Ledger, matrixCases, parseArgs, traceLines, validateInventory, validateResults, here } from './common.mjs';
import { runtimeCases, runtimeKinds } from './runtime.mjs';
import { browserCases, browserKinds, forbiddenRoutes, raw } from './browser.mjs';
import http from 'node:http';
function inventory() {
  const cases=matrixCases();const store=n=>'/nix/store/'+'a'.repeat(32)+'-'+n;
  return {schema:'pa-lavish-inventory/v1',status:'passed',featureSha:'a'.repeat(40),requiredCases:cases,
    cases:Object.fromEntries(cases.map(n=>[n,{status:'passed',evidence:{selfTestOnly:true}}])),missingCases:[],counts:{required:113,passed:113,skipped:0},
    outputs:Object.fromEntries(Array.from({length:16},(_,i)=>[String(i),store('selection-'+i)])),
    tools:Object.fromEntries(Object.entries({'gh-axi':'0.1.35','chrome-devtools-axi':'0.1.38','quota-axi':'0.1.56','lavish-axi':'0.1.67','chrome-devtools-mcp':'1.10.1'}).map(([name,version])=>[name,{store:store(name),version}])),
    inspection:{bwrap:store('bubblewrap')+'/bin/bwrap',strace:store('strace')+'/bin/strace'}};
}
test('exact nine-command harness APIs parse without legacy AXI flags, aliases or browser substitutes',()=>{
  assert.deepEqual(parseArgs(['--inventory','/evidence/inventory.json','--output','/evidence/runtime']),{'--inventory':'/evidence/inventory.json','--output':'/evidence/runtime'});
  assert.equal(parseArgs(['--inventory','/evidence/inventory.json','--chrome',CHROME,'--output','/evidence/browser'],true)['--chrome'],CHROME);
  for(const args of [[],['--inventory','relative','--output','/x'],['--inventory','/i','--output','/a/../b'],['--output','/o','--output','/o'],['--inventory','/i','--output','/o','--skip','x']])assert.throws(()=>parseArgs(args));
  assert.throws(()=>parseArgs(['--inventory','/i','--output','/o','--chrome','/usr/bin/chromium'],true));
});
test('cross-language case accounting includes all sixteen builds and forty strict boolean negatives',()=>{
  assert.equal(matrixCases().length,113);
  assert.equal(matrixCases().filter(n=>n.startsWith('build:')).length,16);
  assert.equal(matrixCases().filter(n=>n.startsWith('installed:')).length,16);
  assert.equal(matrixCases().filter(n=>n.startsWith('invalid:')).length,40);
  const py=cp.spawnSync('python3',['-c',`import importlib.util,json,sys; sys.dont_write_bytecode=True; s=importlib.util.spec_from_file_location('matrix',${JSON.stringify(join(here,'matrix.py'))});m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(sorted(m.required_cases())))`],{encoding:'utf8'});
  assert.equal(py.status,0);assert.deepEqual(JSON.parse(py.stdout),matrixCases());
});
test('inventory rejects omitted, skipped, duplicate outputs, wrong pin and writable-path fixture claims',()=>{
  assert.equal(validateInventory(inventory()).status,'passed');
  const mutations=[v=>delete v.cases['build:15'],v=>v.requiredCases.pop(),v=>v.cases['build:0'].skip=true,v=>v.cases['build:0'].status='skipped',
    v=>v.outputs['15']=v.outputs['0'],v=>v.outputs['8']='/tmp/lavish',v=>v.tools['lavish-axi'].version='latest',v=>v.status='failed',v=>v.missingCases.push('installed:0'),v=>v.counts.passed=112];
  for(const mutate of mutations){const value=inventory();mutate(value);assert.throws(()=>validateInventory(value));}
});
test('runtime/browser ledgers fail on omitted and repeated cases; no empty or invented case success',()=>{
  assert.equal(runtimeCases.length,65);assert.equal(browserCases.length,47);
  for(const required of [runtimeCases,browserCases]){
    const ledger=new Ledger(required);assert.throws(()=>ledger.finish());assert.throws(()=>ledger.pass('invented',{n:1}));assert.throws(()=>ledger.pass(required[0],{}));
    for(const name of required.slice(1))ledger.pass(name,{selfTestOnly:true});assert.throws(()=>ledger.finish());
    ledger.pass(required[0],{selfTestOnly:true});assert.equal(ledger.finish().passed,required.length);assert.throws(()=>ledger.pass(required[0],{n:1}));
  }
  assert.ok(runtimeKinds.includes('idle-900s')&&runtimeKinds.includes('owner-exit')&&runtimeKinds.includes('ownership-pid-reuse'));
  for(const kind of ['text-feedback','element-feedback','limits-retain-unsent','stale-freeze','forbidden-websocket','file-confinement'])assert.ok(browserKinds.includes(kind));
  for(const route of ['share','upload','update','setup','server','api/attachments'])assert.ok(forbiddenRoutes.includes(route));
});
const traceBase='12 execve("/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-node/bin/node", ["node"], []) = 0\n12 socket(AF_INET, SOCK_STREAM, IPPROTO_IP) = 4\n';
test('kernel observer distinguishes blocked forbidden attempts from successes and allows only owned loopback destinations',()=>{
  const clean=auditTrace(traceBase+'12 connect(4, {sa_family=AF_INET, sin_addr=inet_addr("127.0.0.1")}, 16) = 0\n','/synthetic',12);
  assert.ok(Object.values(clean.counts).every(n=>n===0));
  const blocked=auditTrace(traceBase+'13 connect(4, {sa_family=AF_INET, sin_addr=inet_addr("192.0.2.1")}, 16) = -1 ENETUNREACH\n','/synthetic',12);
  assert.equal(blocked.counts.forbiddenOutboundAttempts,1);assert.equal(blocked.counts.forbiddenOutboundSuccesses,0);
  const successful=auditTrace(traceBase+'13 connect(4, {sa_family=AF_INET6, sin6_addr=inet_pton(AF_INET6, "2001:db8::1", &addr)}, 28) = 0\n','/synthetic',12);
  assert.equal(successful.counts.forbiddenOutboundAttempts,1);assert.equal(successful.counts.forbiddenOutboundSuccesses,1);
  assert.throws(()=>auditTrace('','/synthetic',12));
});
test('observer catches forbidden listeners, credential discovery and sentinel reads, even unsuccessful ones',()=>{
  const observed=auditTrace(traceBase+'13 bind(4, {sa_family=AF_INET, sin_addr=inet_addr("0.0.0.0")}, 16) = -1 EACCES\n'+
    '13 openat(AT_FDCWD, "/synthetic/home/.netrc", O_RDONLY) = -1 ENOENT\n'+
    '13 openat(AT_FDCWD, "/synthetic/forbidden-read-sentinel", O_RDONLY) = -1 EACCES\n'+
    '12 openat(AT_FDCWD, "/synthetic/forbidden-read-sentinel", O_RDONLY) = 4\n','/synthetic',12);
  assert.equal(observed.counts.nonLoopbackListeners,1);assert.equal(observed.counts.credentialAccesses,1);assert.equal(observed.counts.sentinelAccesses,1);assert.equal(observed.violations.length,3);
});
test('real CDP transport handles fragmented frames, events and errors, without a browser fixture pass',async()=>{
  const input=new PassThrough(),output=new PassThrough(),events=[];let sent='';input.on('data',b=>sent+=b);
  const cdp=new CDP(input,output,events);const promise=cdp.call('Browser.getVersion');
  assert.equal(JSON.parse(sent.slice(0,-1)).method,'Browser.getVersion');
  output.write('{"id":1,"res');output.write('ult":{"product":"self-test-only"}}\0{"method":"Network.test","params":{}}\0');
  assert.deepEqual(await promise,{product:'self-test-only'});assert.equal(events[0].method,'Network.test');
  const error=cdp.call('Unknown.method');output.write('{"id":2,"error":{"message":"unsupported"}}\0');await assert.rejects(error,/unsupported/);
  const pending=cdp.call('Pending.method');output.emit('close');await assert.rejects(pending,/closed/);
  input.destroy();output.destroy();
});
test('HTTP adversarial probe preserves raw path/Host/Origin rather than fetch normalization',async()=>{
  let received;const server=http.createServer((q,r)=>{received={url:q.url,host:q.headers.host,origin:q.headers.origin};r.writeHead(400);r.end('{"diagnostic":"ARTIFACT_POLICY_REJECTED"}');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const result=await raw({url:`http://127.0.0.1:${server.address().port}/token/`},'../escape','GET',{host:'foreign.invalid',origin:'https://foreign.invalid'});
    assert.equal(result.status,400);assert.deepEqual(received,{url:'/token/../escape',host:'foreign.invalid',origin:'https://foreign.invalid'});
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('missing harness arguments exit nonzero and cannot publish help-only readiness',()=>{
  for(const name of ['runtime.mjs','browser.mjs']){
    const result=cp.spawnSync(process.execPath,[join(here,name)],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,7);assert.match(result.stderr,/ARTIFACT_RUNTIME_FAILED|ARTIFACT_BROWSER_REQUIRED/);
  }
});
test('unfinished/resumed syscalls retain both destination and successful return',()=>{
  const trace=traceBase+'13 connect(4, {sa_family=AF_INET, sin_addr=inet_addr("192.0.2.1")}, 16 <unfinished ...>\n12 wait4(13,  <unfinished ...>\n13 <... connect resumed>) = 0\n12 <... wait4 resumed>NULL, 0, NULL) = 13\n';
  const result=auditTrace(trace,'/synthetic',12);assert.equal(result.counts.forbiddenOutboundAttempts,1);assert.equal(result.counts.forbiddenOutboundSuccesses,1);
  assert.equal(traceLines(trace).length,5);assert.throws(()=>traceLines('13 <... connect resumed>) = 0'));
});
test('effect audit catches attempted automatic source writes, out-of-bundle reads and foreign signals',()=>{
  const artifact={source:'/owned/source.md',manifest:'/owned/companion/manifest.json',companion:'/owned/companion'};
  const result=auditTrace(traceBase+'13 openat(AT_FDCWD, "/owned/source.md", O_WRONLY) = -1 EACCES\n'+
    '13 openat(AT_FDCWD, "/foreign/document.md", O_RDONLY) = 5\n13 kill(9999, SIGTERM) = -1 ESRCH\n','/owned',12,[artifact]);
  assert.equal(result.counts.unauthorizedFileAttempts,2);assert.equal(result.counts.unauthorizedFileSuccesses,1);assert.equal(result.counts.unauthorizedSignals,1);
});
test('real command receipts survive expected rejection and unexpected exit, without invented case completion',async t=>{
  const output=fs.mkdtempSync('/tmp/pa-lavish-harness-test-');t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const e=new Evidence({output,inventory:inventory()},['not-executed']);
  const rejected=await e.command([process.execPath,'-e','console.error("ARTIFACT_POLICY_REJECTED: synthetic rejection");process.exitCode=5'],e.env,5,'ARTIFACT_POLICY_REJECTED');
  assert.equal(rejected.command,1);assert.equal(e.commands[0].code,5);assert.ok(e.commands[0].endedAt);assert.ok(fs.existsSync(e.commands[0].stderr));
  await assert.rejects(e.command([process.execPath,'-e','process.exitCode=8'],e.env,0));
  assert.equal(e.commands[1].code,8);assert.throws(()=>e.ledger.finish());
  await assert.rejects(e.command(['/missing-synthetic-executable'],e.env));assert.equal(e.commands[2].code,127);assert.ok(e.commands[2].endedAt);
  assert.equal(fs.statSync(output).mode&0o777,0o700);await e.cleanup();
});
test('observer cannot weaken immutable ownership for namespace overflow or writable stores',()=>{
  assertObserverStoreOwnership([{uid:0,mode:0o40555}]);
  for(const stats of [[],[{uid:65534,mode:0o40555}],[{uid:1000,mode:0o40555}],[{uid:0,mode:0o40755}]])assert.throws(()=>assertObserverStoreOwnership(stats));
});
test('partial worker JSON and prerequisite failure cannot become successful results',t=>{
  const ledger=new Ledger(['one']);ledger.pass('one',{selfTestOnly:true});
  const report={schema:'pa-lavish-results/v1',status:'passed',requiredCases:['one'],cases:ledger.cases,missingCases:[],counts:ledger.finish(),before:{},after:{},commands:[]};
  assert.equal(validateResults(report,['one']),report);assert.throws(()=>validateResults(report,['one','omitted']));
  assert.throws(()=>validateResults({...report,cleanupFailure:{kind:'synthetic'}},['one']));
  const root=fs.mkdtempSync('/tmp/pa-lavish-prereq-test-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const inv=inventory();inv.status='failed';const input=join(root,'inventory.json'),output=join(root,'output');fs.writeFileSync(input,JSON.stringify(inv));
  const child=cp.spawnSync(process.execPath,[join(here,'runtime.mjs'),'--inventory',input,'--output',output],{encoding:'utf8',timeout:10000});
  assert.equal(child.status,7);assert.equal(JSON.parse(fs.readFileSync(join(output,'results.json'))).status,'failed');
  assert.equal(fs.existsSync(join(output,'effects.strace')),false,'no operational launch after missing prerequisite');
  const sentinel=Buffer.from('prior evidence must survive');fs.writeFileSync(join(output,'results.json'),sentinel);
  const retry=cp.spawnSync(process.execPath,[join(here,'runtime.mjs'),'--inventory',input,'--output',output],{encoding:'utf8',timeout:10000});
  assert.equal(retry.status,7);assert.deepEqual(fs.readFileSync(join(output,'results.json')),sentinel);
});
test('generated Fish completions preserve nested artifact grammar without protected-review/status collisions',t=>{
  const home=fs.mkdtempSync('/tmp/pa-lavish-completion-test-');t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  for(const cli of ['ppa','opa','cpa','pa-core','dpa']){
    const file=join(here,'../../completions',cli+'.fish'),content=fs.readFileSync(file,'utf8');
    for(const word of ['artifact','render','review','start','status','stop','feedback','source','output-dir','manifest','session','timeout-ms','json'])assert.ok(content.includes(word),`${cli}: ${word}`);
    assert.doesNotMatch(content,/review lifecycle unavailable|Review operation \(not yet available\)/);
    const complete=words=>{
      const result=cp.spawnSync('fish',['--no-config','-c','source $argv[1]; complete -C $argv[2]','--',file,words],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:home,XDG_CONFIG_HOME:home},timeout:10000});
      assert.equal(result.status,0);assert.equal(result.stderr,'');return result.stdout.trim().split('\n').filter(Boolean).map(line=>line.split('\t')[0]);
    };
    assert.deepEqual(complete(`${cli} artifact review `).filter(v=>!v.startsWith('-')).sort(),['feedback','start','status','stop']);
    const render=complete(`${cli} artifact render --`);for(const flag of ['--source','--output-dir','--json','--help'])assert.ok(render.includes(flag));
    const status=complete(`${cli} artifact review status --`);assert.ok(status.includes('--session'));assert.ok(!status.includes('--running')&&!status.includes('--ticket'));
  }
});
