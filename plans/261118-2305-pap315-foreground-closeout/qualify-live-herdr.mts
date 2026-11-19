// Manual PAP-315 qualification fixture, not a production CLI or model tool.
// Run only against the newly created disposable `pap315-qualification` pane.
// It injects controlled lifecycle frames for a REAL, explicitly identified Pi,
// then waits for operator quit. It sends no signal and never closes a pane.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { basename, isAbsolute } from "node:path";
import { createHerdrExitCleanup } from "../../packages/pi-pa/src/herdr-exit-cleanup.js";
import { readProcessFingerprint } from "../../packages/pa-core/dist/index.js";

const [pane, session, sessionPath] = process.argv.slice(2);
assert.ok(pane && /^[A-Za-z0-9:._-]+$/.test(pane));
assert.ok(session && /^[0-9a-f-]{36}$/.test(session));
assert.ok(sessionPath && isAbsolute(sessionPath) && basename(sessionPath).endsWith(`_${session}.jsonl`), "require the actual disposable session path, matching the installed reporter");
assert.ok(process.env.HERDR_SOCKET_PATH);
async function rpc(socketPath: string, method: string, params: object = {}) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    const id = `pap315-qualification:${randomUUID()}`, socket = connect(socketPath);
    let carry = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("qualification response timeout")); }, 2_000);
    socket.on("error", error => { clearTimeout(timer); socket.destroy(); reject(error); });
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", chunk => {
      carry += String(chunk);
      if (Buffer.byteLength(carry) > 256 * 1024) { socket.destroy(); clearTimeout(timer); reject(new Error("qualification response bound")); return; }
      if (!carry.includes("\n")) return;
      clearTimeout(timer); socket.destroy();
      try { const response = JSON.parse(carry.split("\n")[0]!); assert.equal(response.id, id); resolve(response); }
      catch (error) { reject(error); }
    });
  });
}
const realSocket = process.env.HERDR_SOCKET_PATH;
const before = (await rpc(realSocket, "agent.get", { target: pane })).result?.agent;
assert.equal(before?.name, "pap315-qualification", "refuse any non-fixture agent");
assert.equal(before?.agent, "pi");
const processInfo = (await rpc(realSocket, "pane.process_info", { pane_id: pane })).result?.process_info;
const processes = processInfo?.foreground_processes as Array<{ pid: number; name: string }>;
assert.ok(Array.isArray(processes));
// Installed Pi sets its process title to `pi`, replacing visible argv. The
// exact session option is supplied by the recorded Herdr agent.start call;
// require that named disposable agent's sole foreground Pi and pin its birth.
const child = processes.filter(process => process.name === "pi");
assert.equal(child.length, 1, "require the named disposable pane's sole foreground Pi");
const pid = child[0]!.pid, fingerprint = readProcessFingerprint(pid);
assert.ok(fingerprint);
const priorIds = new Set(((await rpc(realSocket, "agent.list")).result?.agents ?? []).map((agent: any) => agent.pane_id));
const stage = await createHerdrExitCleanup({ ...process.env, HERDR_PANE_ID: pane });
assert.ok(stage);
try {
  const seq = Date.now() * 1000;
  // `resume` explicitly rebinds this controlled fixture to the known real Pi.
  // These synthetic frames are NOT claimed as the installed extension's output.
  for (const [index, method] of ["pane.report_agent_session", "pane.report_agent"].entries()) {
    const response = await rpc(stage.environment.HERDR_SOCKET_PATH!, method, {
      pane_id: pane, source: "herdr:pi", agent: "pi", agent_session_path: sessionPath,
      session_start_source: "resume", seq: seq + index, ...(index ? { state: "idle" } : {}),
    });
    assert.ok(response.result);
  }
  const registered = (await rpc(realSocket, "agent.get", { target: pane })).result?.agent;
  assert.equal(registered?.agent_session?.value, sessionPath);
  console.log(JSON.stringify({ type: "PAP315-QUALIFICATION-REGISTERED", pane, pid, session, state: registered.agent_status }));
  const deadline = performance.now() + 120_000;
  while (readProcessFingerprint(pid)) {
    assert.deepEqual(readProcessFingerprint(pid), fingerprint, "never act on PID reuse");
    assert.ok(performance.now() < deadline, "operator did not quit fixture Pi");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const at = performance.now(), outcome = await stage.afterVerifiedExit("confirmed-process-gone");
  const elapsedMs = performance.now() - at;
  console.log(JSON.stringify({ type: "PAP315-QUALIFICATION-ACK", pane, elapsedMs, outcome }));
  assert.ok(["verified-absent", "acknowledged"].includes(outcome.status)); assert.equal(outcome.submitted, true);
  // Separate external read-only observation: Herdr's process fallback can
  // disappear after its clear handler replies. Never resend the clear.
  let after = await rpc(realSocket, "agent.get", { target: pane });
  const observedUntil = performance.now() + 1_500;
  while (after.error?.code !== "agent_not_found" && performance.now() < observedUntil) {
    await new Promise(resolve => setTimeout(resolve, 25));
    after = await rpc(realSocket, "agent.get", { target: pane });
  }
  const absenceObservedMs = performance.now() - at;
  assert.equal(after.error?.code, "agent_not_found");
  const nextIds = new Set(((await rpc(realSocket, "agent.list")).result?.agents ?? []).map((agent: any) => agent.pane_id));
  assert.ok([...priorIds].filter(id => id !== pane).every(id => nextIds.has(id)), "preserve unrelated agents");
  const paneAfter = (await rpc(realSocket, "pane.process_info", { pane_id: pane })).result?.process_info;
  assert.ok(paneAfter?.shell_pid);
  console.log(JSON.stringify({ type: "PAP315-QUALIFICATION-CLEARED", pane, elapsedMs, absenceObservedMs, outcome, shellPid: paneAfter.shell_pid, unrelatedPreserved: true }));
} finally { stage.dispose(); }
