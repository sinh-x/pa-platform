import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { managedProcessPreload } from "../axi-browser.js";

test("constructed trace-parser regression: erased proc argv still requires complete fixed MCP execve for both exact PIDs", () => {
  // Parser/negative-control coverage only; synthetic zero counters and execve
  // lines here are NOT real pinned execution/observed-effects acceptance.
  const root = mkdtempSync(join(tmpdir(), "axi-mcp-observation-"));
  const matrix = fileURLToPath(new URL("../../../../scripts/axi-smoke/matrix.py", import.meta.url));
  try {
    const result = spawnSync("python3", ["-c", `
import importlib.util,json,pathlib
spec=importlib.util.spec_from_file_location('axi_matrix',${JSON.stringify(matrix)});module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
root=pathlib.Path(${JSON.stringify(root)})
class Audit:
  def __init__(self): self.root=root;self.chrome=pathlib.Path('/operator/chrome');self.receipt=None
  def case(self,name,evidence): self.receipt=evidence
rows=[{'mcpPid':pid,'mcpStart':'123','pinnedNode':'/pinned/node','pinnedMcp':'/pinned/mcp.js','profile':str(root/str(pid))} for pid in (11,22)]
preload=${JSON.stringify(managedProcessPreload())}
argv=lambda r:['/pinned/node','--import',preload,'/pinned/mcp.js','--executablePath=/operator/chrome','--userDataDir='+r['profile'],'--headless','--no-usage-statistics','--chrome-arg=--remote-debugging-pipe','--chrome-arg=--password-store=basic','--chrome-arg=--use-mock-keychain']
line=lambda r,args=None,pid=None:str(pid or r['mcpPid'])+' execve("/pinned/node", '+json.dumps(argv(r) if args is None else args)+', 0x0 /* variables */) = 0\\n'
runtime={'managedMcpPreload':preload,'cases':{'browser-concurrent':{'deployments':rows}},'effectCounters':{'delegatedRefresh':0,'inference':0,'routing':0,'mcpTelemetry':0,'credentialReads':1,'providerRequests':1,'providerInvocations':1}}
trace=root/'fixture.trace'
def invoke(text):
  trace.write_text(text);audit=Audit();module.Matrix.audit_trace(audit,trace,runtime);return audit.receipt
assert invoke(''.join(line(r) for r in rows))['verifiedMcpFixedArgvExecves']==2
for bad in (line(rows[0]),line(rows[0],pid=33)+line(rows[1]),line(rows[0],argv(rows[0])+['--no-sandbox'])+line(rows[1]),line(rows[0],[a for a in argv(rows[0]) if a!='--chrome-arg=--remote-debugging-pipe'])+line(rows[1]),line(rows[0], [a.replace(rows[0]['profile'],'/foreign') for a in argv(rows[0])])+line(rows[1]),line(rows[0])*2+line(rows[1])):
  try: invoke(bad)
  except Exception: continue
  raise AssertionError('unsafe/missing/replayed observation accepted')
print('constructed-parser-controls-passed')
    `], { env: { PATH: process.env.PATH ?? "", HOME: root, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "constructed-parser-controls-passed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
