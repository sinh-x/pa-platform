import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("native hidden terminal transport disables echo before prompting, restores TTY and does not reuse a prior secret", () => {
  const module = new URL("../operator-terminal.ts", import.meta.url).href;
  const worker = `import {operatorTerminal} from ${JSON.stringify(module)}; const t=operatorTerminal(()=>{}); const a=await t.secret('FIRST:'); console.log('COUNT1='+a.length); a.fill(0); const b=await t.secret('SECOND:'); console.log('COUNT2='+b.length); b.fill(0); console.log('RESTORED='+Boolean(process.stdin.isRaw));`;
  const python = `import os,pty,select,time,sys\npid,fd=pty.fork()\nif pid==0: os.execv(sys.argv[1],[sys.argv[1],'--import=tsx','--input-type=module','-e',sys.argv[2]])\nout=b''; sent=0; end=time.time()+15\nwhile time.time()<end:\n ready,_,_=select.select([fd],[],[],0.1)\n if ready:\n  try: chunk=os.read(fd,65536)\n  except OSError: break\n  if not chunk: break\n  out+=chunk\n  if sent==0 and b'FIRST:' in out: os.write(fd,b'synthetic-tty-fixture\\n'); sent=1\n  if sent==1 and b'SECOND:' in out: os.write(fd,b'other-tty-fixture\\n'); sent=2\n if b'RESTORED=' in out: break\nelse:\n os.kill(pid,9); raise RuntimeError('fixture timeout')\nos.waitpid(pid,0)\nos.close(fd)\nsys.stdout.buffer.write(out)\n`;
  const output = execFileSync("python3", ["-c", python, process.execPath, worker], { encoding: "utf8", timeout: 20000 });
  assert.match(output, /COUNT1=21/); assert.match(output, /COUNT2=17/); assert.match(output, /RESTORED=false/);
  assert.ok(!output.includes("synthetic-tty-fixture")); assert.ok(!output.includes("other-tty-fixture"));
});
