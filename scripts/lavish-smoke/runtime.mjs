#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adapters, digest, here, inventoryModule, launch, post, sleep, waitFor } from './common.mjs';
export const runtimeKinds = ['render-deterministic','source-boundaries','source-invalid','paths','grammar-environment',
  'missing-prerequisites','companion-invalid','startup-failure','supervisor-failure','lifecycle','freshness-source','freshness-html','freshness-manifest','freshness-version',
  'feedback-durable','feedback-validation','ownership-pid-reuse','concurrency-port','user-ended','owner-exit','idle-900s'];
export const runtimeCases = [...Object.keys(adapters).flatMap(a=>runtimeKinds.map(k=>`${a}:${k}`)), 'installed-fault-boundaries','installed-clock-boundaries'];
const statusArgs = s => ['review','status','--session',s.id,'--json'];
export async function runRuntime(e) {
  const fixtures = [];
  for(const cli of Object.keys(adapters)) {
    const f = e.context(cli); const done = (k,v)=>e.ledger.pass(`${cli}:${k}`,v);
    const a = await e.render(f,cli+'-deterministic','# Heading 文档\r\n\r\n- list\r\n\r\n|A|B|\r\n|-|-|\r\n|é|x|\r\n\r\n```js\r\nalert(1)\r\n```\r\n\r\n[link](https://forbidden.invalid/)\r\n<script>globalThis.executionSentinel=1</script>\r\n');
    const repeat = join(e.root,cli+'-repeat');
    await e.cli(f,['render','--source',a.source,'--output-dir',repeat,'--json']);
    for(const name of ['index.html','manifest.json']) assert.equal(digest(join(a.companion,name)),digest(join(repeat,name)));
    assert.equal(digest(a.source),a.sourceSha256);
    done('render-deterministic',{...a,repeat,hashesEqual:true});
    const exact = await e.render(f,cli+'-exact',Buffer.alloc(2097152,0x78));
    assert.equal(fs.statSync(exact.source).size,2097152);
    const over = join(e.root,cli+'-over.md'); fs.writeFileSync(over,Buffer.alloc(2097153,0x78));
    const denied = await e.cli(f,['render','--source',over,'--output-dir',join(e.root,cli+'-over'),'--json'],2,'ARTIFACT_SOURCE_INVALID');
    assert.equal(fs.existsSync(join(e.root,cli+'-over')),false);
    done('source-boundaries',{inclusiveBytes:2097152,rejectedBytes:2097153,command:denied.command,exact});
    const invalid = join(e.root,cli+'-invalid.md'); fs.writeFileSync(invalid,Buffer.from([0xc3,0x28]));
    const bad = await e.cli(f,['render','--source',invalid,'--output-dir',join(e.root,cli+'-invalid'),'--json'],2,'ARTIFACT_SOURCE_INVALID');
    const directory = join(e.root,cli+'-directory.md');fs.mkdirSync(directory,{mode:0o700});
    await e.cli(f,['render','--source',directory,'--output-dir',join(e.root,cli+'-directory'),'--json'],2,'ARTIFACT_SOURCE_INVALID');
    done('source-invalid',{invalidUtf8Command:bad.command,nonRegularRejected:true});
    const link = join(e.root,cli+'-link.md');fs.symlinkSync(a.source,link);
    const ancestor = join(e.root,cli+'-ancestor');fs.symlinkSync(a.companion,ancestor);
    const negativePaths = [[link,join(e.root,cli+'-link-output'),2,'ARTIFACT_SOURCE_INVALID'],
      [a.source,a.companion,8,'ARTIFACT_OUTPUT_CONFLICT'],[a.source,a.source,8,'ARTIFACT_OUTPUT_CONFLICT'],
      [a.source,join(ancestor,'child'),8,'ARTIFACT_OUTPUT_CONFLICT']];
    for(const [source,out,code,diagnostic] of negativePaths) await e.cli(f,['render','--source',source,'--output-dir',out,'--json'],code,diagnostic);
    done('paths',{symlinkSource:true,symlinkAncestor:true,existingDestination:true,sourceAlias:true,sourceUnchanged:digest(a.source)});
    const grammar = [[],['render','--source',a.source,'--output-dir',join(e.root,'unused')],
      ['review','start','--manifest',a.manifest,'--json','--host','0.0.0.0'],
      ['review','start','--manifest',a.manifest,'--manifest',a.manifest,'--json'],
      ['review','status','--session','/tmp/guessed','--json'],
      ...['-1','30001','01','1.5','1e3'].map(t=>['review','feedback','--session','a'.repeat(48),'--output',join(e.root,'unused.json'),'--timeout-ms',t,'--json'])];
    for(const args of grammar) await e.cli(f,args,2,'ARTIFACT_USAGE_INVALID');
    for(const key of ['NODE_OPTIONS','NODE_PATH','LAVISH_AXI_HOST','LAVISH_AXI_STATE_DIR','BASH_ENV','LD_PRELOAD'])
      await e.cli(f,['review','start','--manifest',a.manifest,'--json'],5,'ARTIFACT_POLICY_REJECTED','8',{...f.env,[key]:''});
    done('grammar-environment',{grammarCases:grammar.length,environmentCases:6});
    await e.cli(f,['review','start','--manifest',a.manifest,'--json'],3,'ARTIFACT_RUNTIME_REQUIRED','0');
    await e.cli(f,['review','start','--manifest',a.manifest,'--json'],6,'ARTIFACT_OWNER_CONFLICT','8',e.env);
    assert.equal(fs.existsSync(join(f.dir,'artifact-review-v1')),false,'negative prerequisite must not spawn/create session state');
    done('missing-prerequisites',{unselectedExit:3,ownerlessExit:6,noFallback:true});
    const symlinkDir=join(e.root,cli+'-companion-alias');fs.symlinkSync(a.companion,symlinkDir);
    await e.cli(f,['review','start','--manifest',join(symlinkDir,'manifest.json'),'--json'],4,'ARTIFACT_STALE');
    const originalManifest=fs.readFileSync(a.manifest);fs.writeFileSync(a.manifest,'{}\n');
    try {await e.cli(f,['review','start','--manifest',a.manifest,'--json'],4,'ARTIFACT_STALE');}finally{fs.writeFileSync(a.manifest,originalManifest);}
    const originalHtml=fs.readFileSync(join(a.companion,'index.html'));fs.unlinkSync(join(a.companion,'index.html'));fs.symlinkSync(a.source,join(a.companion,'index.html'));
    try {await e.cli(f,['review','start','--manifest',a.manifest,'--json'],4,'ARTIFACT_STALE');}finally{fs.unlinkSync(join(a.companion,'index.html'));fs.writeFileSync(join(a.companion,'index.html'),originalHtml,{mode:0o600});}
    done('companion-invalid',{symlinkAncestor:true,symlinkHtml:true,malformedManifest:true,allExit:4});
    await startupFailure(e,f,a,done);
    const crashArtifact=await e.render(f,cli+'-crash');const crash=await e.start(f,crashArtifact);
    const crashEvent=e.event(crash);assert.equal((await post(crash,'api/feedback',[crashEvent])).status,200);
    const crashExport=await e.export(crash,cli+'-crash-export');const crashOwner=e.owner(crash);
    const runtime=await import(inventoryModule(e.inventory,'runtime'));
    assert.equal(runtime.processBirth(crashOwner.supervisorPid),crashOwner.supervisorBirth);
    process.kill(crashOwner.supervisorPid,'SIGKILL');await waitFor(()=>runtime.processBirth(crashOwner.supervisorPid)===undefined,5000);
    const crashStop=await e.stop(crash);const crashRestart=await e.start(f,crashArtifact);
    assert.deepEqual((await e.export(crashRestart,cli+'-crash-export')).bytes,crashExport.bytes);
    await e.stop(crashRestart);
    done('supervisor-failure',{interruptedOwnedPid:crashOwner.supervisorPid,verifiedBirth:crashOwner.supervisorBirth,cleanupMs:crashStop.durationMs,eventId:crashEvent.eventId,retainedExportSha256:digest(crashExport.path)});
    const s = await e.start(f,a);const owner = e.owner(s);const ownerPath = join(e.state(s),'owner.json');
    const ownerBefore = fs.readFileSync(ownerPath);
    assert.equal((await e.cli(f,statusArgs(s))).status,'running');
    assert.deepEqual(fs.readFileSync(ownerPath),ownerBefore,'status must not mutate idle/state');
    const again = await e.start(f,a);assert.equal(again.id,s.id);assert.equal(e.owner(s).supervisorPid,owner.supervisorPid);
    for(const p of [join(f.dir,'artifact-review-v1'),e.state(s)]) assert.equal(fs.statSync(p).mode&0o777,0o700);
    assert.equal(fs.statSync(ownerPath).mode&0o777,0o600);
    assert.equal(await (await fetch(s.url+'content')).text(),fs.readFileSync(join(a.companion,'index.html'),'utf8'));
    const empty = await e.export(s,cli+'-empty');assert.equal(empty.result.status,'no-feedback');assert.equal(empty.bytes,undefined);
    const defaultOutput=join(e.root,cli+'-default-timeout.json');
    const defaultTimeout=await e.cli(f,['review','feedback','--session',s.id,'--output',defaultOutput,'--json']);
    assert.equal(defaultTimeout.status,'no-feedback');assert.ok(defaultTimeout.durationMs>=1000 && defaultTimeout.durationMs<=5000);assert.equal(fs.existsSync(defaultOutput),false);
    done('lifecycle',{session:s.payload,startupMs:s.startupMs,idempotent:true,statusSideEffectFree:true,privateModes:true,noFeedbackNoOutput:true,defaultTimeoutMs:defaultTimeout.durationMs});
    const event = e.event(s);const ack = await post(s,'api/feedback',[event]);assert.equal(ack.status,200);assert.deepEqual((await ack.json()).eventIds,[event.eventId]);
    assert.equal((await post(s,'api/feedback',[event])).status,200);
    const exported = await e.export(s,cli+'-feedback');assert.equal(exported.result.status,'exported');
    const bytes = exported.bytes;const data = JSON.parse(bytes);assert.equal(data.events.length,1);assert.equal(data.events[0].eventId,event.eventId);assert.equal(data.events[0].sequence,1);
    assert.equal(fs.statSync(exported.path).mode&0o777,0o600);
    const exportLink=join(e.root,cli+'-export-link.json');fs.symlinkSync(exported.path,exportLink);
    await e.export(s,cli+'-export-link',8,'ARTIFACT_OUTPUT_CONFLICT');assert.deepEqual(fs.readFileSync(exported.path),bytes);
    assert.deepEqual((await e.export(s,cli+'-feedback')).bytes,bytes);
    const conflict = join(e.root,cli+'-conflict.json');fs.writeFileSync(conflict,'sentinel',{mode:0o600});
    await e.export(s,cli+'-conflict',8,'ARTIFACT_OUTPUT_CONFLICT');assert.equal(fs.readFileSync(conflict,'utf8'),'sentinel');
    const stop = await e.stop(s);assert.equal(fs.existsSync(join(e.state(s),'snapshot.html')),false);
    assert.deepEqual((await e.export(s,cli+'-feedback')).bytes,bytes);
    const restarted = await e.start(f,a);assert.equal(restarted.id,s.id);
    assert.deepEqual((await e.export(s,cli+'-feedback')).bytes,bytes);
    done('feedback-durable',{eventIds:data.events.map(v=>v.eventId),sourceSha256:a.sourceSha256,exportSha256:digest(exported.path),stopMs:stop.durationMs,retryAndRestart:true});
    const current = restarted;
    const journalPath = join(e.state(current),'journal.json');let journal = fs.readFileSync(journalPath);
    const invalidEvents = [null,{...e.event(current),sourceSha256:'9'.repeat(64)}, {...e.event(current),target:{type:'anchor',anchor:'unknown',startLine:1,endLine:1}},
      {...event,feedbackText:'conflicting retry'}, e.event(current,{feedbackText:'x'.repeat(65537)}),e.event(current,{selectedText:'x'.repeat(16385)}),
      e.event(current,{feedbackText:'\ud800'}),e.event(current,{sequence:9})];
    for(const badEvent of invalidEvents) {
      const r = await post(current,'api/feedback',[e.event(current),badEvent]);assert.equal(r.status,400);assert.equal((await r.json()).diagnostic,'ARTIFACT_POLICY_REJECTED');
      assert.deepEqual(fs.readFileSync(journalPath),journal);
    }
    const boundary = e.event(current,{feedbackText:'é'.repeat(32768),selectedText:'é'.repeat(8192)});
    assert.equal((await post(current,'api/feedback',[boundary])).status,200);
    journal = fs.readFileSync(journalPath);
    done('feedback-validation',{malformedBatches:invalidEvents.length,exactUtf8Limits:[65536,16384],atomicRejection:true,journalSha256:digest(journalPath)});
    const foreign = {...f,env:{...f.env,PA_ARTIFACT_ADAPTER:cli==='ppa'?'opencode':'pi'}};
    await e.cli(foreign,statusArgs(current),6,'ARTIFACT_OWNER_CONFLICT');
    const wrongDeploy = {...f,env:{...f.env,PA_DEPLOYMENT_ID:'d-fedcba'}};
    await e.cli(wrongDeploy,['review','stop','--session',current.id,'--json'],6,'ARTIFACT_OWNER_CONFLICT');
    const original = fs.readFileSync(ownerPath);const altered = JSON.parse(original);
    altered.supervisorPid=process.pid;altered.supervisorBirth='reused-pid-birth';fs.writeFileSync(ownerPath,JSON.stringify(altered,null,2)+'\n');
    try { await e.cli(f,['review','stop','--session',current.id,'--json'],6,'ARTIFACT_OWNER_CONFLICT'); }
    finally {fs.writeFileSync(ownerPath,original);}
    assert.equal((await e.cli(f,statusArgs(current))).status,'running');
    done('ownership-pid-reuse',{foreignAdapterRejected:true,foreignDeploymentRejected:true,reusedPidRejected:true,ownerUntouched:true});
    const occupied = http.createServer((_q,r)=>r.end('unrelated listener sentinel'));
    await new Promise(r=>occupied.listen(0,'127.0.0.1',r));
    try {
      const second = await e.start(e.context(cli),await e.render(f,cli+'-concurrent'));
      assert.notEqual(new URL(second.url).port,new URL(current.url).port);
      assert.notEqual(Number(new URL(second.url).port),occupied.address().port);
      assert.equal(await (await fetch(`http://127.0.0.1:${occupied.address().port}`)).text(),'unrelated listener sentinel');
      await e.stop(second);
      done('concurrency-port',{isolatedSessionIds:[current.id,second.id],ports:[new URL(current.url).port,new URL(second.url).port],foreignListenerPort:occupied.address().port});
    } finally {occupied.closeAllConnections();await new Promise(r=>occupied.close(r));}
    await e.stop(current);
    for(const [kind,filename] of [['source',a.source],['html',join(a.companion,'index.html')],['manifest',a.manifest],['version',a.manifest]]) {
      const originalBytes = fs.readFileSync(filename);const stale = await e.start(f,a);
      try {
        if(kind==='version') {const m=JSON.parse(originalBytes);m.rendererVersion='unsupported';fs.writeFileSync(filename,JSON.stringify(m,null,2)+'\n');}
        else fs.appendFileSync(filename,'\nchanged');
        assert.equal((await e.cli(f,statusArgs(stale))).status,'stale');
        await e.cli(f,['review','start','--manifest',a.manifest,'--json'],4,'ARTIFACT_STALE');
        await e.export(stale,`${cli}-stale-${kind}`,4,'ARTIFACT_STALE');
        const r=await post(stale,'api/feedback',[e.event(stale)]);assert.equal(r.status,409);assert.equal((await r.json()).diagnostic,'ARTIFACT_STALE');
        assert.deepEqual(fs.readFileSync(journalPath),journal);
        done(`freshness-${kind}`,{staleStatus:true,startAndExportExit:4,newFeedbackRefused:true,journalUnchanged:true});
      } finally {await e.stop(stale);fs.writeFileSync(filename,originalBytes);}
    }
    const end = await e.start(f,a);assert.equal((await post(end,'api/end',{})).status,200);
    await waitFor(async()=> (await e.cli(f,statusArgs(end))).status==='ended',5000);
    await e.cli(f,['review','start','--manifest',a.manifest,'--json'],6,'ARTIFACT_OWNER_CONFLICT');
    const endedExport=await e.export(end,cli+'-after-end');
    assert.deepEqual(JSON.parse(endedExport.bytes).events.map(v=>v.eventId),[event.eventId,boundary.eventId]);
    assert.deepEqual(fs.readFileSync(journalPath),journal);
    done('user-ended',{endedTombstone:true,automaticReopenDenied:true,durableFeedbackRetained:true});
    await ownerExit(e,cli,done);
    fixtures.push({ f:e.context(cli),cli,done });
  }
  await faultBoundaries(e);
  const supervisor = await import(inventoryModule(e.inventory,'supervisor'));
  assert.equal(supervisor.idleExpired(0,899999),false);assert.equal(supervisor.idleExpired(0,900000),true);assert.equal(supervisor.idleExpired(100,900099),false);
  e.ledger.pass('installed-clock-boundaries',{beforeMs:899999,atMs:900000,acceleratedAcceptance:false});
  // All three real clocks run concurrently. Polling status must not refresh idle.
  const idle = [];
  for(const x of fixtures) {
    const artifact = await e.render(x.f,x.cli+'-idle');const s=await e.start(x.f,artifact);
    idle.push({...x,s,start:performance.now()});
  }
  await Promise.all(idle.map(async x=>{
    const before = performance.now();
    while(performance.now()-x.start<898000) {assert.equal((await e.cli(x.f,statusArgs(x.s))).status,'running');await sleep(Math.min(30000,Math.max(1,898000-(performance.now()-x.start))));}
    const measured = await waitFor(async()=> (await e.cli(x.f,statusArgs(x.s))).status==='stopped',7000,100);
    const elapsed=performance.now()-x.start;
    assert.ok(elapsed>=899000 && elapsed<=905000);
    assert.equal(fs.existsSync(join(e.state(x.s),'snapshot.html')),false);
    const runtime=await import(inventoryModule(e.inventory,'runtime'));assert.equal(runtime.processBirth(e.owner(x.s).supervisorPid),undefined);
    x.done('idle-900s',{configuredMs:900000,measuredMs:elapsed,observationToleranceMs:5000,statusPollsDoNotExtend:true,observationMs:measured.elapsedMs,totalWaitMs:performance.now()-before});
  }));
}
async function startupFailure(e,f,a,done) {
  const session=await import(inventoryModule(e.inventory,'session'));
  const runtime=await import(inventoryModule(e.inventory,'runtime'));
  const context={adapter:adapters[f.cli],deployment:f.env.PA_DEPLOYMENT_ID,root:join(f.dir,'artifact-review-v1'),ownerPid:process.pid,ownerBirth:runtime.processBirth(process.pid)};
  const start=performance.now();
  await assert.rejects(session.startReview(context,a.manifest,join(e.inventory.tools['lavish-axi'].store,'share/lavish-axi/review'),()=>{}),error=>error.message.startsWith('ARTIFACT_RUNTIME_FAILED:'));
  const elapsed=performance.now()-start;assert.ok(elapsed<=10000);
  const entries=fs.readdirSync(context.root);assert.ok(entries.includes('operation.lock'));
  const lock=fs.lstatSync(join(context.root,'operation.lock'));assert.ok(lock.isFile());assert.equal(lock.size,0);assert.equal(lock.mode&0o777,0o600);
  const dirs=entries.filter(name=>/^[a-f0-9]{48}$/.test(name));assert.equal(dirs.length,1);assert.equal(entries.length,2);const state=join(context.root,dirs[0]);
  assert.equal(JSON.parse(fs.readFileSync(join(state,'owner.json'))).state,'stopped');assert.equal(fs.existsSync(join(state,'snapshot.html')),false);
  done('startup-failure',{failureMs:elapsed,ownedTransientRemoved:true,scope:'installed session implementation with explicit no-launch fault; normal success uses installed CLI'});
}
async function ownerExit(e,cli,done) {
  const f=e.context(cli);const a=await e.render(f,cli+'-owner-exit');
  const config=join(e.root,cli+'-owner-config.json'),response=join(e.root,cli+'-owner-response.json');
  fs.writeFileSync(config,JSON.stringify({executable:join(e.inventory.outputs['8'],'bin',cli),env:f.env,manifest:a.manifest,response}),{mode:0o600});
  const child=cp.spawn(join(e.inventory.outputs['8'],'bin/pa-platform-node'),[join(here,'owner.mjs'),config],{env:e.env,stdio:['pipe','ignore','ignore']});
  try {
    await waitFor(()=>fs.existsSync(response),10000);
    const data=JSON.parse(fs.readFileSync(response));assert.equal(data.status,'running');
    const s={f,artifact:a,id:data.payload.sessionId,url:data.payload.url,payload:data.payload};
    const event=e.event(s);assert.equal((await post(s,'api/feedback',[event])).status,200);
    const journal=join(e.state(s),'journal.json'),journalHash=digest(journal);
    const start=performance.now();child.stdin.end();
    await waitFor(()=>JSON.parse(fs.readFileSync(join(e.state(s),'owner.json'))).state==='stopped',5000);
    const cleanupMs=performance.now()-start;assert.ok(cleanupMs<=5000);assert.equal(digest(journal),journalHash);
    assert.equal(fs.existsSync(join(e.state(s),'snapshot.html')),false);
    done('owner-exit',{ownerPid:child.pid,cleanupMs,acknowledgedEventId:event.eventId,journalSha256:journalHash});
  } finally {if(child.exitCode===null) {child.stdin.end();await waitFor(()=>child.exitCode!==null,5000);}}
}
async function faultBoundaries(e) {
  const runtime=await import(inventoryModule(e.inventory,'runtime'));
  const feedback=await import(inventoryModule(e.inventory,'feedback'));
  const f=e.context('ppa');const a=await e.render(f,'fault-artifact');
  const manifest=await import(inventoryModule(e.inventory,'manifest'));const validated=manifest.validateArtifactManifest(a.manifest);
  const binding={sessionId:'a'.repeat(48),identity:validated.identity,anchors:validated.manifest.anchors};
  const dir=join(e.root,'fault-journal');fs.mkdirSync(dir,{mode:0o700});const fd=runtime.privateDirectory(dir);
  const s={id:binding.sessionId,payload:binding.identity};const event=e.event(s);
  let injections=0;
  function inject(name,fn,check) {
    const real=fs[name];try {fs[name]=fn(real);syncBuiltinESMExports();check();injections++;}
    finally {fs[name]=real;syncBuiltinESMExports();}
  }
  try {
    inject('fsyncSync',()=>()=>{throw new Error('journal fsync injection');},()=>{assert.throws(()=>feedback.appendFeedback(fd,binding,[event]));assert.equal(fs.existsSync(join(dir,'journal.json')),false);});
    inject('renameSync',()=>()=>{throw new Error('journal rename injection');},()=>{assert.throws(()=>feedback.appendFeedback(fd,binding,[event]));assert.equal(fs.existsSync(join(dir,'journal.json')),false);});
    assert.throws(()=>feedback.appendFeedback(fd,binding,[event],()=>{throw new Error('lost acknowledgement injection');}));injections++;
    assert.equal(feedback.appendFeedback(fd,binding,[event])[0].sequence,1);assert.equal(feedback.readJournal(fd,binding).length,1);
    const out=join(e.root,'fault-export.json');
    inject('fsyncSync',()=>()=>{throw new Error('export fsync injection');},()=>{assert.throws(()=>feedback.exportFeedback(fd,binding,out));assert.equal(fs.existsSync(out),false);});
    inject('linkSync',real=>(a,b)=>{real(a,b);throw new Error('post publication injection');},()=>assert.equal(feedback.exportFeedback(fd,binding,out).status,'exported'));
    const bytes=fs.readFileSync(out);assert.equal(feedback.exportFeedback(fd,binding,out).status,'exported');assert.deepEqual(fs.readFileSync(out),bytes);
    const many=Array.from({length:1023},(_,i)=>({...event,eventId:`cap-event-${String(i).padStart(16,'0')}`}));
    feedback.appendFeedback(fd,binding,many);const full=digest(join(dir,'journal.json'));
    assert.throws(()=>feedback.appendFeedback(fd,binding,[{...event,eventId:'event-overflow-00001'}]));assert.equal(digest(join(dir,'journal.json')),full);
    const bigDir=join(e.root,'fault-large');fs.mkdirSync(bigDir,{mode:0o700});const big=runtime.privateDirectory(bigDir);
    try {assert.throws(()=>feedback.appendFeedback(big,binding,Array.from({length:256},(_,i)=>({...event,eventId:`large-event-${String(i).padStart(16,'0')}`,feedbackText:'x'.repeat(65536)}))));assert.equal(fs.existsSync(join(bigDir,'journal.json')),false);}
    finally {fs.closeSync(big);}
    assert.deepEqual(fs.readdirSync(dir),['journal.json']);
    e.ledger.pass('installed-fault-boundaries',{injections,journalEventCap:1024,journalByteCap:16777216,exportSha256:digest(out),scope:'fault injection into actual installed modules with real synthetic artifact; complements installed CLI and browser, not an OS-crash claim'});
  } finally {fs.closeSync(fd);}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await launch('runtime',process.argv.slice(2));
