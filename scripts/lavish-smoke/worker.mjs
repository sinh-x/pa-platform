// Private observer child. Public APIs are matrix.py, runtime.mjs, browser.mjs.
import fs from 'node:fs';
import { join } from 'node:path';
import { assertObserverStoreOwnership, Evidence, jsonFile, validateInventory } from './common.mjs';
import { runRuntime, runtimeCases } from './runtime.mjs';
import { runBrowser, browserCases } from './browser.mjs';
const config=JSON.parse(fs.readFileSync(process.argv[2]));
validateInventory(config.inventory);
if(!['runtime','browser'].includes(config.role))throw new Error('unknown worker role');
const e=new Evidence(config,config.role==='runtime'?runtimeCases:browserCases);
const report={schema:'pa-lavish-results/v1',status:'failed',role:config.role,startedAt:new Date().toISOString(),observerPid:process.pid,
  requiredCases:e.ledger.required,cases:e.ledger.cases,commands:e.commands,before:e.before};
try {
  // User namespaces can map host root to overflow UID 65534. Never relax core's
  // immutable/root-owner checks to accommodate such an observer configuration.
  assertObserverStoreOwnership([config.inventory.outputs['8'],config.inventory.tools['lavish-axi'].store].map(p=>fs.statSync(p)));
  await (config.role==='runtime'?runRuntime:runBrowser)(e);
  report.counts=e.ledger.finish();report.status='passed';
} catch(error) {
  const browserPrerequisite=config.role==='browser'&&!e.ledger.cases['browser-prerequisite'];
  report.failure={kind:error.constructor.name,message:error.message,stack:error.stack,...(browserPrerequisite?{diagnostic:'ARTIFACT_BROWSER_REQUIRED'}:{})};process.exitCode=browserPrerequisite?3:1;
} finally {
  try {await e.cleanup();await e.assertQuiescentNamespace();}catch(error){report.status='failed';report.cleanupFailure={kind:error.constructor.name,message:error.message};process.exitCode=1;}
  report.after=e.after ?? e.snapshot();report.network=e.network ?? [];report.artifacts=e.artifacts;
  report.missingCases=e.ledger.required.filter(n=>!Object.hasOwn(e.ledger.cases,n));report.endedAt=new Date().toISOString();
  jsonFile(join(config.output,'worker-results.json'),report);
}
