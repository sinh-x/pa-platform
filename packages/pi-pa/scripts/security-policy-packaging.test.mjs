import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildSync } from "esbuild";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const asset = readFileSync(join(root, "packages/pa-core/src/policies/security-defaults.v1.yaml"));
const run = (directory, code) => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: directory, encoding: "utf8", timeout: 15000,
    env: { ...process.env, PA_PLATFORM_CONFIG: join(directory, "config"), NODE_OPTIONS: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
function fixture(fn) {
  const directory = mkdtempSync(join(tmpdir(), "pa-owned-policy-"));
  mkdirSync(join(directory, "config"));
  try { fn(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function bundled(directory) {
  // Actual consumer modules, no mock evaluator or alternate policy implementation.
  const core = join(directory, "core.ts"), entry = join(directory, "entry.ts");
  writeFileSync(core, ["security-policy", "sensitive-patterns", "safety-policy", "source-content-security", "activity/index"].map(name => `export * from ${JSON.stringify(join(root, `packages/pa-core/src/${name}.ts`))};`).join("\n"));
  writeFileSync(entry, `export * from './core.ts';\nexport { interceptToolCall } from ${JSON.stringify(join(root, "packages/pi-pa/src/pi-extension/safety.ts"))};\nexport { bindLocalReadTool } from ${JSON.stringify(join(root, "packages/pi-pa/src/pi-extension/bound-local-read.ts"))};\nexport { filterLocalToolResult } from ${JSON.stringify(join(root, "packages/pi-pa/src/pi-extension/local-content-security.ts"))};`);
  buildSync({ entryPoints: [entry], outfile: join(directory, "policy.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", alias: { "@pa-platform/pa-core": core }, logLevel: "silent" });
}
const prelude = `import assert from 'node:assert/strict'; import * as p from './policy.mjs'; import {mkdirSync,writeFileSync,readFileSync,renameSync} from 'node:fs';`;

test("actual bundled consumers import lazily, cache failures and retain machine codes/effect uncertainty", () => fixture(directory => {
  bundled(directory);
  run(directory, prelude + `
    // Import and prose do not attempt default initialization. A missing first-use
    // asset fails closed across pre-call and result owners, including shell help.
    assert.equal(p.evaluateSafetyPolicy({kind:'prose',value:'ordinary'}).allowed,true);
    const d=p.evaluateSafetyPolicy({kind:'shell',value:'ppa --help'});
    assert.equal(d.code,'sensitive-policy-unavailable'); assert.equal(d.allowed,false);
    assert.match(d.reason,/PA-owned security defaults \\(unavailable\\)/);
    const before=p.interceptToolCall({name:'bash',input:{command:'printf ordinary'}});
    assert.equal(before.allowed,false); assert.match(before.reason,/SAFETY_SENSITIVE_POLICY_UNAVAILABLE/);
    const result=p.filterLocalToolResult('bash',{content:[{type:'text',text:'ordinary already-completed effect'}],details:{}});
    assert.equal(result.details.code,'LOCAL_CONTENT_POLICY'); assert.equal(result.details.outputWithheld,true);
    assert.equal(result.details.effectState,'not-established');
    assert.equal(result.isError,true); assert.match(result.content[0].text,/Reconcile any possible prior effect/);
    assert.throws(()=>p.assertLocalFileSource('/ordinary.txt'),e=>e.code==='LOCAL_CONTENT_POLICY');
    let acquisitions=0, executions=0;
    const reader=p.bindLocalReadTool(()=>({description:'inert reader seam',execute:async()=>{executions++;throw new Error('unreachable');}}),()=>{acquisitions++;throw new Error('unreachable');});
    const direct=await reader.execute('missing-default',{path:'/ordinary-report.html'},undefined,undefined,{cwd:process.cwd()});
    assert.equal(direct.details.code,'LOCAL_CONTENT_POLICY'); assert.equal(direct.details.outputWithheld,true);
    assert.equal(direct.isError,true); assert.match(direct.content[0].text,/PA-owned security defaults \\(unavailable\\)/);
    assert.match(direct.content[0].text,/coherent code-and-policy package/);
    assert.equal(acquisitions,0); assert.equal(executions,0);
    mkdirSync('./policies'); writeFileSync('./policies/security-defaults.v1.yaml',${JSON.stringify(asset.toString())});
    assert.throws(()=>p.getSecurityDefaults(),p.SecurityPolicyError,'same unavailable instance never blindly retries');
  `);
}));

test("bundled import does not eagerly read defaults, baseline survives asset/CWD changes, private additions stay live", () => fixture(directory => {
  bundled(directory);
  // The asset is absent at import; successful later first use proves laziness.
  run(directory, prelude + `
    mkdirSync('./policies'); writeFileSync('./policies/security-defaults.v1.yaml',${JSON.stringify(asset.toString())});
    const initial=p.getSecurityDefaults();
    assert.equal(p.interceptToolCall({name:'read',input:{path:'/ordinary-report.html'}}).allowed,true);
    assert.equal(p.interceptToolCall({name:'read',input:{path:'/report/.env'}}).allowed,false);
    assert.equal(p.interceptToolCall({name:'bash',input:{command:'ppa --help'}}).allowed,true);
    assert.equal(p.interceptToolCall({name:'bash',input:{command:'rm /ordinary-report.html'}}).allowed,false);
    const report='./ordinary-report.html'; const text=Array.from({length:400},(_,i)=>'ordinary line '+i).join('\\n');
    writeFileSync(report,text,{flag:'wx'}); assert.equal(p.readGuardedLocalTextFile(report),text);
    assert.throws(()=>writeFileSync(report,'collision',{flag:'wx'})); assert.equal(readFileSync(report,'utf8'),text);
    // Ordinary disposable twin only; preserve a stale exact-text conflict.
    const old=readFileSync(report,'utf8'); writeFileSync(report,old.replace('ordinary line 0','updated line 0'));
    assert.notEqual(readFileSync(report,'utf8'),old); assert.equal(readFileSync(report,'utf8').startsWith('updated'),true);
    writeFileSync('./policies/security-defaults.v1.yaml','invalid');
    writeFileSync('./config/sensitive-patterns.yaml',"contents:\\n - 'INERT_PRIVATE_ADDITION'\\n");
    assert.equal(p.findSensitiveMatch('content','INERT_PRIVATE_ADDITION')?.source,'local-config');
    writeFileSync('./config/sensitive-patterns.yaml',''); assert.equal(p.findSensitiveMatch('content','INERT_PRIVATE_ADDITION'),undefined);
    writeFileSync('./config/sensitive-patterns.yaml',"content_patterns:\\n - '['\\n"); assert.throws(()=>p.loadSensitivePatterns());
    assert.equal(p.getSecurityDefaults(),initial); process.chdir('config'); assert.equal(p.getSecurityDefaults(),initial);
  `);
  // New instance rejects the changed package instead of reusing another instance.
  run(directory, prelude + `assert.throws(()=>p.getSecurityDefaults(),e=>e.category==='invalid');`);
}));

test("compiled dist is self-contained and byte-identical without source checkout; omitted asset fails first use only", () => fixture(directory => {
  const dist = join(root, "packages/pa-core/dist");
  assert.deepEqual(readFileSync(join(dist, "policies/security-defaults.v1.yaml")), asset);
  cpSync(dist, join(directory, "dist"), { recursive: true });
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  run(directory, `import assert from 'node:assert/strict'; import {getSecurityDefaults} from './dist/security-policy.js'; import {loadSensitivePatterns} from './dist/sensitive-patterns.js'; assert.equal(getSecurityDefaults().schemaVersion,'pa-security-defaults/v1'); assert.ok(loadSensitivePatterns().patterns.length);`);
  rmSync(join(directory, "dist/policies"), { recursive: true });
  run(directory, `import assert from 'node:assert/strict'; import {loadSensitivePatterns} from './dist/sensitive-patterns.js'; assert.throws(()=>loadSensitivePatterns(),e=>e.category==='unavailable');`);
}));

test("required asset acquisition rejects symlinks, directories and oversized files without fallback", () => fixture(directory => {
  bundled(directory);
  mkdirSync(join(directory, "policies"));
  const path = join(directory, "policies/security-defaults.v1.yaml");
  const target = join(directory, "ordinary.yaml"); writeFileSync(target, asset);
  symlinkSync(target, path);
  run(directory, prelude + `assert.throws(()=>p.getSecurityDefaults(),e=>e.category==='unavailable');`);
  rmSync(path); mkdirSync(path);
  run(directory, prelude + `assert.throws(()=>p.getSecurityDefaults(),e=>e.category==='unavailable');`);
  rmSync(path, { recursive: true }); writeFileSync(path, Buffer.alloc(65537, 32));
  run(directory, prelude + `assert.throws(()=>p.getSecurityDefaults(),e=>e.category==='limit');`);
}));

test("build rejects invalid source without copying over a prior validated dist asset", () => fixture(directory => {
  mkdirSync(join(directory, "scripts")); mkdirSync(join(directory, "dist")); mkdirSync(join(directory, "src/policies"), { recursive: true });
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  cpSync(join(root, "packages/pa-core/scripts/build-security-policy.mjs"), join(directory, "scripts/build-security-policy.mjs"));
  cpSync(join(root, "packages/pa-core/dist/security-policy.js"), join(directory, "dist/security-policy.js"));
  const source = join(directory, "src/policies/security-defaults.v1.yaml"), output = join(directory, "dist/policies/security-defaults.v1.yaml");
  writeFileSync(source, asset);
  run(directory, `await import('./scripts/build-security-policy.mjs');`);
  assert.deepEqual(readFileSync(output), asset);
  writeFileSync(source, 'invalid');
  const result = spawnSync(process.execPath, [join(directory, "scripts/build-security-policy.mjs")], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.match(result.stderr, /defaults \(invalid\)/); assert.ok(result.stderr.length <= 2001);
  assert.deepEqual(readFileSync(output), asset, "failed build retains old bytes but never establishes package success");
}));

test("Rogue-One capture and native resume preserve missing/invalid packaged-policy guidance in fresh processes", () => fixture(directory => {
  const entry = join(directory, "rogue-entry.ts");
  writeFileSync(entry, [
    `export {RogueOneConfig,RogueOneConfigError} from ${JSON.stringify(join(root, "packages/pa-core/src/deploy/rogue-one-config.ts"))};`,
    `export {SecurityPolicyError} from ${JSON.stringify(join(root, "packages/pa-core/src/security-policy.ts"))};`,
    `export {parseTeamYamlContent} from ${JSON.stringify(join(root, "packages/pa-core/src/yaml-parser.ts"))};`,
    `export {appendRegistryEvent,closeDb} from ${JSON.stringify(join(root, "packages/pa-core/src/registry/index.ts"))};`,
    `export {getDeployPaths} from ${JSON.stringify(join(root, "packages/pa-core/src/deploy/paths.ts"))};`,
  ].join("\n"));
  buildSync({ entryPoints: [entry], outfile: join(directory, "rogue-policy.mjs"), bundle: true, packages: "external", platform: "node", format: "esm", target: "node22", logLevel: "silent" });
  symlinkSync(join(root, "packages/pa-core/node_modules"), join(directory, "node_modules"), "dir");
  mkdirSync(join(directory, "policies")); writeFileSync(join(directory, "policies/security-defaults.v1.yaml"), asset);
  const setup = `
    import assert from 'node:assert/strict';
    import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
    Object.assign(process.env,{PA_PLATFORM_HOME:process.cwd()+'/config',PA_PLATFORM_CONFIG:process.cwd()+'/user',PA_AI_USAGE_HOME:process.cwd()+'/usage',PA_REGISTRY_DB:process.cwd()+'/registry.db'});
    delete process.env.PA_PLATFORM_TEAMS; delete process.env.PA_PLATFORM_SKILLS;
    const p=await import('./rogue-policy.mjs');
    const context={deploymentId:'d-349aaa',runtime:'pi',repoKey:'fixture',repoRoot:'/fixture/repo',worktreeRoot:'/fixture/worktree'};
    const pair={provider:'openai-codex',model:'gpt-6.2-sol',source:'mode'};
    const team=p.parseTeamYamlContent(JSON.stringify({name:'rogue-one',description:'Fixture',objective:'Original objective',agents:[],default_mode:'direct',deploy_modes:[{id:'direct',label:'Direct',mode_type:'interactive'}]}));
    const capture=()=>p.RogueOneConfig.capture(context,{team:'rogue-one'},team,pair);
  `;
  run(directory, setup + `
    mkdirSync('./config/teams',{recursive:true});writeFileSync('./config/teams/rogue-one.yaml',JSON.stringify(team));
    const captured=capture(), dir=p.getDeployPaths(context.deploymentId).deployDir;
    mkdirSync(dir,{recursive:true,mode:0o700});captured.materialize(context.deploymentId);
    writeFileSync(dir+'/session-id-pi.txt','original-session',{mode:0o600});
    p.appendRegistryEvent({deployment_id:context.deploymentId,event:'started',timestamp:new Date().toISOString(),team:'rogue-one',mode:'direct',rogue_one:true,runtime:'pi',binary:'ppa',invocation_channel:'cli',repo:context.worktreeRoot,repo_root:context.repoRoot,worktree_root:context.worktreeRoot,provider:pair.provider,models:{team:pair.model},note:captured.note});
    p.closeDb();
  `);
  const policy = join(directory, "policies/security-defaults.v1.yaml");
  for (const category of ["unavailable", "invalid"]) {
    if (category === "unavailable") rmSync(policy); else writeFileSync(policy, "invalid");
    run(directory, setup + `
      const expected=new p.SecurityPolicyError(${JSON.stringify(category)}).message;
      const archive=p.getDeployPaths(context.deploymentId).deployDir+'/rogue-one-config.json', before=readFileSync(archive);
      for(const attempt of [capture,()=>p.RogueOneConfig.resume(context.deploymentId,{team:'rogue-one'},context)]) {
        assert.throws(attempt,error=>{
          assert.ok(error instanceof p.RogueOneConfigError);assert.equal(error.cause,'policy');assert.equal(error.message,expected);
          assert.ok(error.message.length<=2000);for(const label of ['Condition:','Source:','Reason:','Correction:','Resume Action:'])assert.equal(error.message.split(label).length-1,1);
          return true;
        });
      }
      assert.deepEqual(readFileSync(archive),before,'policy failure never rewrites original snapshot');p.closeDb();
    `);
  }
}));

test("finite selected-document bundle includes actual security source closure and resolves rebased shipped asset", () => fixture(directory => {
  const nix = readFileSync(join(root, "nix/selected-pi-document-qualification.nix"), "utf8");
  // Materialize ONLY the actual Nix copy closure. Missing source copies/exports
  // must fail here, rather than silently resolving against the full checkout.
  for (const [, source, names, destination] of nix.matchAll(/cp \$\{\.\.\/([^}]+)\}\/\{([^}]+)\}\.ts (work\/[^\s]+)/g)) {
    mkdirSync(join(directory, destination), { recursive: true });
    for (const name of names.split(",")) cpSync(join(root, source, `${name}.ts`), join(directory, destination, `${name}.ts`));
  }
  for (const [, source, destination] of nix.matchAll(/cp \$\{\.\.\/([^}]+\.(?:ts|mjs))\} (work\/[^\s]+)/g)) {
    mkdirSync(join(directory, destination, ".."), { recursive: true });
    cpSync(join(root, source), join(directory, destination));
  }
  symlinkSync(join(root, "node_modules"), join(directory, "work/node_modules"), "dir");
  const entry = join(directory, "work/packages/pi-pa/runtime/local-source-core.ts");
  const actual = buildSync({ entryPoints: [join(directory, "work/packages/pi-pa/runtime/qualify.mjs")], outfile: join(directory, "doc-qualify.mjs"), bundle: true, platform: "node", format: "esm", target: "node24", alias: { "@pa-platform/pa-core": entry }, external: ["./selection.mjs"], metafile: true, write: false, logLevel: "silent" });
  assert.ok(Object.keys(actual.metafile.inputs).some(path => path.endsWith("security-policy.ts")));
  buildSync({ entryPoints: [entry], outfile: join(directory, "finite.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
  mkdirSync(join(directory, "policies")); writeFileSync(join(directory, "policies/security-defaults.v1.yaml"), asset);
  run(directory, `import assert from 'node:assert/strict'; import {loadSensitivePatterns} from './finite.mjs'; assert.ok(loadSensitivePatterns().patterns.length);`);
  rmSync(join(directory, "policies"), { recursive: true });
  run(directory, `import assert from 'node:assert/strict'; import {loadSensitivePatterns} from './finite.mjs'; assert.throws(()=>loadSensitivePatterns(),e=>e.category==='unavailable');`);
  assert.match(nix, /security-policy/); assert.match(nix, /\$out\/lib\/policies/); assert.match(nix, /cmp.*security-defaults/);
}));
