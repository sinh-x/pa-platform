#!/usr/bin/env node
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CDP } from './cdp.mjs';
import { adapters, CHROME, digest, launch, post, waitFor } from './common.mjs';
export const browserKinds=['walkthrough','text-feedback','element-feedback','retry-restart','limits-retain-unsent','stale-freeze','user-ended',
  'forbidden-cli','forbidden-ui','forbidden-http','forbidden-websocket','host-origin','file-confinement','content-inert','listeners-process-state'];
export const browserCases=['browser-prerequisite',...Object.keys(adapters).flatMap(a=>browserKinds.map(k=>`${a}:${k}`)),'network-no-egress'];
export const forbiddenRoutes=['share','api/share','upload','api/upload','attachments','api/attachments','update','self-update','setup','server',
  'api/server','api/open','api/file','file','files','api/prompts','api/unknown','provenance.json',
  '/health','/shutdown','/api/sessions','/api/poll?file=synthetic','/api/end','/session/0123456789abcdef','/artifact/0123456789abcdef',
  '/artifact/0123456789abcdef/index.html','/artifact/0123456789abcdef/.secret','/events/0123456789abcdef','/chrome-client.js','/chrome.css',
  '/design/tailwindcss-browser.js','/sdk.js','/whiteboard-frame','/whiteboard-assets/unknown',
  ...['prompts','layout-diagnostics','layout-warnings','layout-warnings/queue','layout-warnings/dismiss','artifact-failures','end','agent-reply',
    'export','share','chrome-loads/begin','artifact-loads/begin','mermaid-sources','whiteboard/0','whiteboard-channel','whiteboard/0/feedback-files','attachments','attachments/synthetic']
    .map(route=>`/api/0123456789abcdef/${route}`)];
export async function runBrowser(e) {
  assert.equal(e.config.chrome,CHROME);
  assert.equal(digest(CHROME),e.config.chromeIdentity.sha256);
  const version=await e.command([CHROME,'--version']);assert.match(version.out,/Google Chrome \d+\.\d+\.\d+\.\d+/);
  const profile=join(e.root,'chrome-profile');fs.mkdirSync(profile,{mode:0o700});
  const screenshots=join(e.output,'screenshots');fs.mkdirSync(screenshots,{mode:0o700});
  const logs=['chrome.stdout','chrome.stderr'].map(n=>fs.openSync(join(e.output,n),'wx',0o600));
  // No request interception, host resolver substitution, proxy, no-sandbox or
  // credential/profile reuse. The observer records attempted effects as well as
  // namespace-denied connections; every forbidden attempt fails the final audit.
  const argv=['--headless=new','--enable-automation','--remote-debugging-pipe',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check',
    '--disable-background-networking','--disable-component-update','--disable-sync','--disable-default-apps',
    '--disable-domain-reliability','--disable-client-side-phishing-detection','--safebrowsing-disable-auto-update',
    '--metrics-recording-only','--password-store=basic','--use-mock-keychain','--window-size=1280,1000','about:blank'];
  const chromeStartedAt=new Date().toISOString();
  const child=cp.spawn(CHROME,argv,{env:e.env,stdio:['ignore',...logs,'pipe','pipe']});logs.forEach(fd=>fs.closeSync(fd));
  const events=[];const cdp=new CDP(child.stdio[3],child.stdio[4],events);let closeFailure;
  child.on('error',error=>child.stdio[4].destroy(error));
  const allowedOrigins=new Set();
  try {
    const browserVersion=await cdp.call('Browser.getVersion');assert.match(browserVersion.product,/Chrome\//);
    const browserCommand=await cdp.call('Browser.getBrowserCommandLine');
    assert.ok(browserCommand.arguments.every(arg=>!arg.includes('no-sandbox')&&!arg.includes('disable-setuid-sandbox')));
    const sandboxTarget=await cdp.call('Target.createTarget',{url:'chrome://sandbox'});
    const sandboxSession=await cdp.call('Target.attachToTarget',{targetId:sandboxTarget.targetId,flatten:true});
    const sandbox=cdp.page(sandboxSession.sessionId);
    const sandboxText=(await waitFor(async()=>{
      const text=await sandbox.evaluate('document.body?.innerText || ""');return /SUID|Namespace|Seccomp|Sandbox/.test(text)?text:false;
    },10000)).value;
    fs.writeFileSync(join(e.output,'sandbox.txt'),sandboxText,{mode:0o600});
    assert.match(sandboxText,/Seccomp-BPF[^\n]*Yes/i,'actual sandbox status required');
    assert.doesNotMatch(sandboxText,/You are not adequately sandboxed/i);
    await cdp.call('Target.closeTarget',{targetId:sandboxTarget.targetId});
    e.ledger.pass('browser-prerequisite',{...e.config.chromeIdentity,version:version.out.trim(),browserVersion,argv,browserCommand,sandboxSha256:digest(join(e.output,'sandbox.txt')),disposableProfile:profile});
    for(const cli of Object.keys(adapters)) {
      const done=(k,v)=>e.ledger.pass(`${cli}:${k}`,v);const f=e.context(cli);
      const hostile='# Synthetic review heading\n\nSynthetic selected paragraph with Unicode 文档 é.\n\n- list\n\n| A | B |\n| - | - |\n| x | y |\n\n```html\n<script>executionSentinel=1</script>\n```\n\n<script>globalThis.executionSentinel=1;fetch("https://forbidden.invalid/")</script>\n<img src="https://forbidden.invalid/image" onerror="executionSentinel=2">\n<svg onload="executionSentinel=3"></svg>\n<form action="https://forbidden.invalid/"><input autofocus></form>\n[external](https://forbidden.invalid/navigation)\n![remote](https://forbidden.invalid/remote)\n[script](javascript:executionSentinel=4)\n\n```mermaid\ngraph LR; A-->B\n```\n';
      const a=await e.render(f,cli+'-browser',hostile);let s=await e.start(f,a);allowedOrigins.add(new URL(s.url).origin);
      const target=await cdp.call('Target.createTarget',{url:'about:blank'});
      const attached=await cdp.call('Target.attachToTarget',{targetId:target.targetId,flatten:true});const page=cdp.page(attached.sessionId);
      await page.call('Network.enable');await page.call('Runtime.enable');await page.call('Page.enable');
      await page.call('Page.navigate',{url:s.url});
      await waitFor(()=>page.evaluate('Boolean(document.querySelector("#artifact")?.contentDocument?.querySelector("h1"))'),10000);
      await waitFor(()=>page.evaluate('typeof configuration !== "undefined" && document.querySelector("#queue")?.disabled === false'),5000);
      await screenshot(page,join(screenshots,cli+'-loaded.png'));
      assert.equal(await page.evaluate('document.querySelector("#artifact").sandbox.value'),'allow-same-origin');
      done('walkthrough',{sessionId:s.id,artifact:a,startupMs:s.startupMs,screenshot:`screenshots/${cli}-loaded.png`,loadedRealPackagedUI:true});
      const content=await page.evaluate(`(()=>{const d=document.querySelector('#artifact').contentDocument;return {text:d.body.innerText,executed:d.defaultView.executionSentinel||0,active:d.querySelectorAll('script,iframe,form,img,svg,object,embed,a[href^="http"],a[href^="javascript"]').length};})()`);
      assert.match(content.text,/Synthetic selected paragraph/);assert.match(content.text,/<script>/);assert.equal(content.executed,0);assert.equal(content.active,0);
      await page.call('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
      assert.equal(await page.evaluate('document.querySelector("#artifact").contentDocument.defaultView.executionSentinel||0'),0);
      assert.match(await page.evaluate('document.querySelector("#artifact").contentDocument.body.innerText'),/Unicode 文档/);
      await page.call('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
      done('content-inert',{...content,offlineRetainedDOM:true,sourceSha256:a.sourceSha256,htmlSha256:a.htmlSha256});
      // Triple-click selects actual rendered paragraph text; mouseup/click are
      // trusted Chrome input events delivered to genuine pinned Lavish listeners.
      await clickFrame(page,'p',3);
      const selected=await page.evaluate('document.querySelector("#artifact").contentWindow.getSelection().toString()');assert.match(selected,/Synthetic selected paragraph/);
      await typeAndSend(page,'Text feedback from synthetic operator.');
      const textExport=await e.export(s,cli+'-text');const textData=JSON.parse(textExport.bytes);assert.equal(textData.events.length,1);
      assert.match(textData.events[0].selectedText,/Synthetic selected paragraph/);assert.equal(textData.events[0].target.type,'anchor');assert.equal(textData.events[0].feedbackText,'Text feedback from synthetic operator.');
      done('text-feedback',{event:textData.events[0],exportSha256:digest(textExport.path),realMouseSelection:true});
      // Clear prior selection through trusted mouse input before element target.
      await clickFrame(page,'h1',1);
      await typeAndSend(page,'Element feedback from synthetic operator.');
      const both=await e.export(s,cli+'-both');const data=JSON.parse(both.bytes);assert.equal(data.events.length,2);
      assert.match(data.events[1].selectedText,/Synthetic review heading/);assert.equal(data.events[1].target.type,'anchor');
      await screenshot(page,join(screenshots,cli+'-feedback.png'));
      done('element-feedback',{event:data.events[1],exportSha256:digest(both.path),screenshot:`screenshots/${cli}-feedback.png`});
      assert.deepEqual((await e.export(s,cli+'-both')).bytes,both.bytes);
      const originalJournal=digest(join(e.state(s),'journal.json'));await e.stop(s);s=await e.start(f,a);allowedOrigins.add(new URL(s.url).origin);
      assert.deepEqual((await e.export(s,cli+'-both')).bytes,both.bytes);assert.equal(digest(join(e.state(s),'journal.json')),originalJournal);
      await page.call('Page.navigate',{url:s.url});await waitFor(()=>page.evaluate('Boolean(document.querySelector("#artifact")?.contentDocument?.querySelector("h1"))'),10000);
      done('retry-restart',{eventIds:data.events.map(v=>v.eventId),journalSha256:originalJournal,exportsByteIdentical:true});
      // Oversized real UI send must retain its text, create no partial journal
      // and never display a durable acknowledgement for a rejected batch.
      await fill(page,'x'.repeat(65537));await click(page,'#queue');await click(page,'#send');
      await waitFor(()=>page.evaluate('document.querySelector("#notice").innerText.includes("not acknowledged")'),5000);
      assert.equal(await page.evaluate('queued.length'),1);assert.equal(await page.evaluate('queued[0].prompt.length'),65537);
      assert.equal(digest(join(e.state(s),'journal.json')),originalJournal);
      await screenshot(page,join(screenshots,cli+'-rejected.png'));
      done('limits-retain-unsent',{rejectedUtf8Bytes:65537,queueRetained:true,journalUnchanged:true,screenshot:`screenshots/${cli}-rejected.png`});
      await click(page,'.pill-close');
      await forbiddenCLI(e,done);
      const controls=await page.evaluate('Array.from(document.querySelectorAll("button,a,input,form")).map(el=>({tag:el.tagName,text:el.textContent,href:el.getAttribute("href"),action:el.getAttribute("action")}))');
      assert.ok(controls.every(v=>!/share|upload|setup|update|export|tailscale/i.test(v.text??'')));
      const uiRejections=await page.evaluate(`Promise.all(['api/share','api/upload','api/update','api/setup','api/server'].map(async route=>{const r=await fetch(route,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});return {route,status:r.status,body:await r.json()};}))`);
      for(const r of uiRejections) {assert.ok(r.status>=400);assert.equal(r.body.diagnostic,'ARTIFACT_POLICY_REJECTED');}
      done('forbidden-ui',{controls,browserOriginProbes:uiRejections,forbiddenControlsAbsent:true});
      await forbiddenHTTP(s,done);
      await forbiddenWS(s,done);
      await hostOrigin(s,done);
      const files=['../forbidden-read-sentinel','../../forbidden-read-sentinel','%2e%2e/forbidden-read-sentinel','content/../../forbidden-read-sentinel',
        `file?path=${join(e.root,'forbidden-read-sentinel')}`,`/etc/passwd`,`file://${join(e.root,'forbidden-read-sentinel')}`];
      for(const route of files) {const r=await raw(s,route);assert.ok(r.status>=400);assert.doesNotMatch(r.body,/synthetic forbidden read/);}
      done('file-confinement',{routes:files,allRejected:true,readSentinel:e.sentinels['forbidden-read-sentinel']});
      const state=e.owner(s);const snapshots=e.snapshot();const pid=state.supervisorPid;
      const socketIds=new Set(fs.readdirSync(`/proc/${pid}/fd`).flatMap(fd=>{try{return [fs.readlinkSync(`/proc/${pid}/fd/${fd}`)];}catch{return [];}}));
      const listeners=[];
      for(const table of ['tcp','tcp6']) for(const line of fs.readFileSync(`/proc/net/${table}`,'utf8').split('\n').slice(1)) {
        const cols=line.trim().split(/\s+/);if(cols[3]!=='0A'||!socketIds.has(`socket:[${cols[9]}]`))continue;
        assert.equal(cols[1].split(':')[0],'0100007F');listeners.push({table,address:cols[1]});
      }
      assert.equal(listeners.length,1);assert.equal(fs.statSync(e.state(s)).mode&0o777,0o700);assert.equal(fs.statSync(join(e.state(s),'journal.json')).mode&0o777,0o600);
      done('listeners-process-state',{owner:state,listeners,processes:snapshots.processes,files:snapshots.files});
      // End before a separate stale session; never auto-reopen the ended ID.
      await click(page,'#end');
      await waitFor(()=>page.evaluate('document.querySelector("#notice").innerText.includes("Review ended")'),5000);
      await e.cli(f,['review','start','--manifest',a.manifest,'--json'],6,'ARTIFACT_OWNER_CONFLICT');
      done('user-ended',{ended:true,noAutomaticReopen:true,eventIds:data.events.map(v=>v.eventId)});
      const staleArtifact=await e.render(f,cli+'-stale-browser');const stale=await e.start(f,staleArtifact);allowedOrigins.add(new URL(stale.url).origin);
      await page.call('Page.navigate',{url:stale.url});await waitFor(()=>page.evaluate('Boolean(document.querySelector("#artifact")?.contentDocument?.querySelector("h1"))'),10000);
      await fill(page,'Unsent stale draft.');await click(page,'#queue');
      const pollMark=events.length;
      await waitFor(()=>events.slice(pollMark).some(v=>v.method==='Network.responseReceived'&&v.params.response.url===stale.url+'api/status'),5000);
      const staleSource=fs.readFileSync(staleArtifact.source);fs.appendFileSync(staleArtifact.source,'\nChanged source.');
      await click(page,'#send');
      await waitFor(()=>page.evaluate('document.querySelector("#notice").innerText.includes("not acknowledged")'),1500);
      assert.equal(await page.evaluate('queued[0].prompt'),'Unsent stale draft.');
      await waitFor(()=>page.evaluate('document.querySelector("#notice").innerText.includes("frozen")'),5000);
      assert.equal(await page.evaluate('document.querySelector("#queue").disabled'),true);
      assert.equal(await page.evaluate('queued[0].prompt'),'Unsent stale draft.');
      assert.equal((await post(stale,'api/feedback',[e.event(stale)])).status,409);
      await e.export(stale,cli+'-stale-export',4,'ARTIFACT_STALE');
      await screenshot(page,join(screenshots,cli+'-stale.png'));
      done('stale-freeze',{unsentDraftRetained:true,newFeedbackRefused:true,rejectedSendCannotClaimAcknowledgement:true,exportExit:4,screenshot:`screenshots/${cli}-stale.png`});
      await cdp.call('Target.closeTarget',{targetId:target.targetId});await e.stop(stale);fs.writeFileSync(staleArtifact.source,staleSource);
    }
    e.network=events.filter(v=>v.method.startsWith('Network.'));
    const requests=e.network.filter(v=>v.method==='Network.requestWillBeSent');
    assert.ok(requests.length>0);
    const forbidden=requests.filter(v=>{const url=v.params.request.url;return !url.startsWith('data:')&&!allowedOrigins.has(new URL(url).origin);});
    assert.deepEqual(forbidden,[],'forbidden attempted browser requests');
    const exceptions=events.filter(v=>v.method==='Runtime.exceptionThrown');assert.deepEqual(exceptions,[],'real UI exception');
    e.ledger.pass('network-no-egress',{requestAttempts:requests.length,forbiddenAttempts:forbidden.length,allowedOrigins:[...allowedOrigins],kernelAuditRequired:true});
  } finally {
    e.network=events.filter(v=>v.method.startsWith('Network.'));
    try {await cdp.call('Browser.close');}catch(err){if(child.exitCode===null)closeFailure=err;}
    if(child.exitCode===null) {
      try {await waitFor(()=>child.exitCode!==null,5000);}catch{child.kill('SIGTERM');throw new Error('Chrome bounded cleanup failed');}
    }
    fs.writeFileSync(join(e.output,'chrome-command.json'),JSON.stringify({argv:[CHROME,...argv],startedAt:chromeStartedAt,endedAt:new Date().toISOString(),exit:child.exitCode,signal:child.signalCode,stdout:join(e.output,'chrome.stdout'),stderr:join(e.output,'chrome.stderr')},null,2)+'\n',{mode:0o600});
    if(closeFailure) throw closeFailure;
  }
}
async function screenshot(page,path) {const image=await page.call('Page.captureScreenshot',{format:'png'});const bytes=Buffer.from(image.data,'base64');assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');fs.writeFileSync(path,bytes,{mode:0o600});}
async function mouse(page,x,y,count=1) {await page.call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:count});await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:count});}
async function click(page,selector) {const point=await page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await mouse(page,point.x,point.y);}
async function clickFrame(page,selector,count) {
  const point=await page.evaluate(`(()=>{const f=document.querySelector('#artifact'),el=f.contentDocument.querySelector(${JSON.stringify(selector)});el.scrollIntoView();const a=f.getBoundingClientRect(),b=el.getBoundingClientRect();return {x:a.x+b.x+Math.min(b.width/2,100),y:a.y+b.y+b.height/2};})()`);
  await mouse(page,point.x,point.y,count);
}
async function fill(page,text) {await click(page,'#chatInput');await page.call('Input.insertText',{text});}
async function typeAndSend(page,text) {await fill(page,text);await click(page,'#queue');await click(page,'#send');await waitFor(()=>page.evaluate('document.querySelector("#notice").innerText.startsWith("Durably acknowledged") && queued.length === 0'),5000);}
async function forbiddenCLI(e,done) {
  const commands=['share','upload','update','self-update','setup','server','open','poll','end','stop','export','--managed-review-v1'];
  for(const cmd of commands) await e.command([join(e.inventory.tools['lavish-axi'].store,'bin/lavish-axi'),cmd],e.env,5,'ARTIFACT_POLICY_REJECTED');
  done('forbidden-cli',{commands,allExit:5,noUpstreamExecution:true});
}
export function raw(s,route,method='GET',headers={},body) {
  return new Promise((resolve,reject)=>{
    const url=new URL(s.url);const path=route.startsWith('/')?route:url.pathname+route;
    const req=http.request({hostname:'127.0.0.1',port:url.port,path,method,headers,signal:AbortSignal.timeout(3000)},res=>{
      let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:text}));res.on('error',reject);
    });req.on('error',reject);req.end(body);
  });
}
async function forbiddenHTTP(s,done) {
  for(const route of forbiddenRoutes) for(const method of ['GET','POST','PUT','DELETE']) {
    const r=await raw(s,route,method,{origin:new URL(s.url).origin,'content-type':'application/json'},method!=='GET'?'{}':undefined);
    assert.ok(r.status>=400);assert.equal(JSON.parse(r.body).diagnostic,'ARTIFACT_POLICY_REJECTED');
  }
  done('forbidden-http',{routes:forbiddenRoutes,methods:['GET','POST','PUT','DELETE'],rejections:forbiddenRoutes.length*4});
}
async function forbiddenWS(s,done) {
  const url=new URL(s.url);
  for(const route of [...forbiddenRoutes,'ws','socket.io']) {
    const path=route.startsWith('/')?route:url.pathname+route;
    const response=await new Promise((resolve,reject)=>{
    const socket=net.connect(Number(url.port),'127.0.0.1',()=>socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${url.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
    let result='';const timer=setTimeout(()=>{socket.destroy();reject(new Error('upgrade was not closed'));},3000);
    socket.on('data',b=>result+=b);socket.on('error',reject);socket.on('close',()=>{clearTimeout(timer);resolve(result);});
  });assert.match(response,/^HTTP\/1\.1 403 /);
  }
  done('forbidden-websocket',{routes:[...forbiddenRoutes,'ws','socket.io'],upgradeStatus:403,socketsClosed:true});
}
async function hostOrigin(s,done) {
  const cases=[{host:'foreign.invalid'},{origin:'https://foreign.invalid'},{'sec-fetch-site':'cross-site'}];
  for(const headers of cases) {const r=await raw(s,'','GET',headers);assert.ok(r.status>=400);assert.equal(JSON.parse(r.body).diagnostic,'ARTIFACT_POLICY_REJECTED');}
  done('host-origin',{headers:cases,allRejected:true});
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await launch('browser',process.argv.slice(2));
