// A real synthetic ancestor whose normal exit must clean its installed session.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
const config=JSON.parse(fs.readFileSync(process.argv[2]));
const result=cp.spawnSync(config.executable,['artifact','review','start','--manifest',config.manifest,'--json'],{
  env:{...config.env,PA_ARTIFACT_OWNER_PID:String(process.pid)},encoding:'utf8',timeout:10000});
assert.equal(result.status,0);assert.equal(result.stderr,'');
fs.writeFileSync(config.response,result.stdout,{mode:0o600});
process.stdin.resume();
