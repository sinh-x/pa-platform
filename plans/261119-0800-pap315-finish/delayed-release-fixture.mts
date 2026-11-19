// Manual disposable-pane fixture: delay A's ORIGINAL release until B claims
// that same pane, lowering B's wire counters to prove source-first guarding.
// No synthetic state, extra release, process signal, or pane-close is generated.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const [pane] = process.argv.slice(2), original = process.env.HERDR_SOCKET_PATH;
assert.ok(pane && /^[A-Za-z0-9:._-]+$/.test(pane) && original);
const root = mkdtempSync(join(tmpdir(), "pap315-race-")); chmodSync(root, 0o700);
const endpoint = join(root, "proxy.sock"), sockets = new Set<Socket>();
let held: { frame: string; id: string; source: string; seq: number } | undefined;
let applying = false, protectedB = false, done = false;
const counters = new Map<string, number>();
function exchange(frame: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(original!); sockets.add(socket); let body = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("native fixture response timeout")); }, 2_000);
    const finish = () => { clearTimeout(timer); sockets.delete(socket); socket.destroy(); };
    socket.on("error", error => { finish(); reject(error); });
    socket.on("connect", () => socket.write(frame));
    socket.on("data", chunk => {
      body += String(chunk); if (Buffer.byteLength(body) > 1024 * 1024) { finish(); reject(new Error("native fixture response bound")); return; }
      if (!body.includes("\n")) return;
      try { const response = JSON.parse(body.split("\n")[0]!); finish(); resolve(response); }
      catch (error) { finish(); reject(error); }
    });
  });
}
const request = (method: string, params: object) => exchange(`${JSON.stringify({ id: `pap315-race:${randomUUID()}`, method, params })}\n`);
async function protectReplacement(source: string, seq: number): Promise<void> {
  if (!held || applying || source === held.source) return;
  applying = true;
  assert.ok(held.seq > seq, "force a larger old-A counter, not a clock-order assumption");
  const response = await exchange(held.frame); assert.equal(response.id, held.id); assert.ok(response.result);
  const current = await request("agent.get", { target: pane }); assert.equal(current.result?.agent?.agent, "ppa-pi");
  protectedB = true;
  console.log(JSON.stringify({ type: "PAP315-DELAYED-RELEASE-PRESERVED", pane, originalRequestId: held.id, sourceA: held.source, seqA: held.seq, sourceB: source, seqB: seq, replacementPresent: true }));
}
const server = createServer({ allowHalfOpen: true }, client => {
  sockets.add(client); client.on("error", () => client.destroy()); client.on("close", () => sockets.delete(client)); let carry = "";
  client.setTimeout(5_000, () => client.destroy());
  client.on("data", chunk => {
    carry += String(chunk); if (Buffer.byteLength(carry) > 1024 * 1024) { client.destroy(); return; }
    if (!carry.includes("\n")) return;
    client.removeAllListeners("data");
    void (async () => {
      const body = JSON.parse(carry.split("\n")[0]!), params = body.params;
      const managed = params?.pane_id === pane && params.agent === "ppa-pi" && /^ppa:pi:[0-9a-f-]{36}$/.test(params.source ?? "");
      if (managed && body.method === "pane.release_agent" && !held) {
        held = { frame: `${JSON.stringify(body)}\n`, id: body.id, source: params.source, seq: params.seq };
        console.log(JSON.stringify({ type: "PAP315-RELEASE-HELD", pane, requestId: held.id, source: held.source, seq: held.seq, endpoint }));
        // PPA times out and returns; do not reply or dispatch this request yet.
        return;
      }
      const state = managed && body.method === "pane.report_agent" && held && params.source !== held.source;
      if (managed && held && params.source !== held.source && ["pane.report_agent", "pane.report_agent_session"].includes(body.method)) {
        const next = (counters.get(params.source) ?? 0) + 1; counters.set(params.source, next); params.seq = next;
      }
      const response = await exchange(`${JSON.stringify(body)}\n`);
      if (!client.destroyed) client.end(`${JSON.stringify(response)}\n`);
      if (state && response.result) await protectReplacement(params.source, params.seq);
      if (managed && body.method === "pane.release_agent" && held && params.source !== held.source) {
        assert.ok(protectedB); done = true;
        setTimeout(() => { console.log(JSON.stringify({ type: "PAP315-RACE-FIXTURE-DONE", pane })); dispose(); }, 100);
      }
    })().catch(error => { console.error(`PAP315-RACE-FIXTURE-FAILED:${error instanceof Error ? error.message : "unknown"}`); process.exitCode = 1; dispose(); });
  });
});
const deadline = setTimeout(() => { if (!done) { console.error("PAP315-RACE-FIXTURE-TIMEOUT"); process.exitCode = 1; } dispose(); }, 180_000);
function dispose() {
  clearTimeout(deadline); server.close(); for (const socket of sockets) socket.destroy(); rmSync(root, { recursive: true, force: true });
}
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
console.log(JSON.stringify({ type: "PAP315-RACE-FIXTURE-READY", pane, endpoint }));
