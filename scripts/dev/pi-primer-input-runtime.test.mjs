import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Explicit source-built package qualification, never installation, a live PA
// ticket, an external provider, or a new reader/host selection mechanism.
const root = process.env.PA_TEST_SELECTED_PPA_ROOT;
const prefix = root && join(root, "share", "pa-platform");
const launchModule = root && await import(pathToFileURL(join(prefix, "packages/pi-pa/dist/selected-pi-launch.js")).href);
const transport = root && await import(pathToFileURL(join(prefix, "packages/pi-pa/dist/prompt-transport.js")).href);
const selected = launchModule?.resolveSelectedPiLaunch();
const sha = body => createHash("sha256").update(body).digest("hex");

async function run(args, env, evidence) {
  const child = spawn(selected.entryFile, ["--pa-managed-child", ...args], { cwd: env.HOME, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", closed = false, anchor;
  child.stdout.on("data", bytes => { stdout = (stdout + bytes).slice(-8192); });
  child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-8192); });
  const ended = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); }); });
  const timeout = setTimeout(() => { if (!closed) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } }, 30000);
  try {
    const gate = await launchModule.awaitSelectedPiChild(selected, child.pid); anchor = gate.fingerprint;
    assert.equal(existsSync(evidence), false, "real Pi input code cannot run while native admission is held");
    gate.release();
    return { ...await ended, stdout, stderr, anchor };
  } finally {
    clearTimeout(timeout);
    if (!closed) { try { process.kill(-child.pid, "SIGKILL"); } catch {} await ended; }
  }
}

test("PAP-318 actual selected Pi initial-user-input boundary preserves inline semantics without a provider", { skip: !root }, async () => {
  assert.ok(selected);
  for (const body of ["x".repeat(635831), "\ufeffViệt 日本語 🚀\r\ntrailing\n\n", "no trailing newline", ""]) {
    const directory = mkdtempSync(join(tmpdir(), "pap318 selected 'space'-")), agent = join(directory, "agent"), config = join(directory, "config"), evidence = join(directory, "input.jsonl");
    try {
      mkdirSync(join(agent, "extensions"), { recursive: true }); mkdirSync(config);
      writeFileSync(join(config, "sensitive-patterns.yaml"), "contents: []\n");
      writeFileSync(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
      // A local model catalog satisfies Pi's ordinary model-selection precheck.
      // The input observer handles the prompt before any model/provider request.
      writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: "http://127.0.0.1:1/never", api: "openai-completions", apiKey: "$OPENAI_API_KEY", models: [{ id: "pap318-inert", name: "Unused inert model", contextWindow: 1048576, maxTokens: 1, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
      writeFileSync(join(agent, "extensions", "input-observer.ts"), `import fs from 'node:fs'; import {createHash} from 'node:crypto'; export default function(pi) {
        pi.on('input', event => {
          const stat=fs.readFileSync('/proc/self/stat','utf8');
          fs.appendFileSync(${JSON.stringify(evidence)}, JSON.stringify({type:event.type,source:event.source,pid:process.pid,birth:stat.slice(stat.lastIndexOf(') ')+2).split(' ')[19],bytes:Buffer.byteLength(event.text),sha256:createHash('sha256').update(event.text).digest('hex'),images:event.images?.length??0,maxArg:Math.max(...fs.readFileSync('/proc/self/cmdline').toString().split('\\0').map(x=>Buffer.byteLength(x))),maxEnv:Math.max(...Object.values(process.env).map(x=>Buffer.byteLength(x)))})+'\\n');
          return {action:'handled'};
        });
        pi.on('before_agent_start', () => { fs.writeFileSync(${JSON.stringify(join(directory, "agent-started"))}, ''); throw Error('PAP-318 fixture forbids agent execution'); });
      }`);
      const primer = join(directory, "primer.md"); writeFileSync(primer, body);
      const env = launchModule.selectedPiEnvironment(selected, { HOME: directory, TMPDIR: directory, PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", NO_COLOR: "1", OPENAI_API_KEY: randomUUID(), PA_DEPLOYMENT_DIR: directory, PA_PLATFORM_CONFIG: config, PA_AI_USAGE_HOME: directory, PA_REGISTRY_DB: join(directory, "registry.db") });
      const flags = ["--print", "--mode", "json", "--no-session", "--extension", join(prefix, "packages/pi-pa/dist/pi-extension/index.js"), "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline", "--provider", "openai", "--model", "pap318-inert", "--thinking", "off"];
      const result = await run([...flags, transport.preparePiPrompt(primer)], env, evidence);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(existsSync(join(directory, "agent-started")), false, "input handling finishes before any model/agent execution");
      const records = existsSync(evidence) ? readFileSync(evidence, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
      // Pi's existing empty positional input does not initiate a user turn.
      assert.equal(records.length, body ? 1 : 0);
      if (body) {
        const observed = records[0];
        assert.equal(observed.type, "input"); assert.equal(observed.source, "interactive"); assert.equal(observed.images, 0);
        assert.equal(observed.bytes, Buffer.byteLength(body)); assert.equal(observed.sha256, sha(body));
        assert.equal(observed.pid, result.anchor.pid); assert.equal(observed.birth, result.anchor.startTimeTicks);
        assert.ok(observed.maxArg < 128 * 1024); assert.ok(observed.maxEnv < 128 * 1024);
      }
      assert.equal(readdirSync(directory).some(name => name.endsWith(".input") || name.includes(".cleanup-")), false);
      // Compare the original inline route for payloads below the OS argument
      // limit; both must enter the same Pi input boundary, role and ordering.
      if (Buffer.byteLength(body) < 128 * 1024) {
        rmSync(evidence, { force: true });
        const inline = await run([...flags, body], env, evidence); assert.equal(inline.code, 0, inline.stderr);
        const control = existsSync(evidence) ? readFileSync(evidence, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
        const contentFacts = values => values.map(({ type, source, bytes, sha256, images }) => ({ type, source, bytes, sha256, images }));
        assert.deepEqual(contentFacts(control), contentFacts(records));
        assert.equal(existsSync(join(directory, "agent-started")), false);
      }
      // A missing referenced input fails in the selected host, before Pi input dispatch.
      rmSync(evidence, { force: true });
      const absent = transport.preparePiPrompt(primer);
      rmSync(join(directory, readdirSync(directory).find(name => name.endsWith(".input"))));
      const rejected = await run([...flags, absent], env, evidence);
      assert.equal(rejected.code, 1); assert.match(rejected.stderr, /PROMPT_INPUT/); assert.equal(existsSync(evidence), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
