// Test harness: execute the actual built PPA entry module repeatedly, including
// its argv/version dispatch. No parallel formatter or trusted-host service seam.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [cli, fixturePath] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(fixturePath, "utf8"));
const write = process.stdout.write.bind(process.stdout);
let count = 0;
for (const c of cases) for (let n = 0; n < c.repeats; n++) {
  process.argv = [process.execPath, cli, ...c.argv]; process.exitCode = undefined;
  Object.defineProperty(process, "stdin", { configurable: true, value: (async function* () { if (c.body !== undefined) yield Buffer.from(c.body); })() });
  let output = ""; process.stdout.write = ((chunk, _encoding, callback) => { output += chunk.toString(); if (typeof callback === "function") callback(); return true; });
  await import(`${pathToFileURL(cli).href}?disposable_case=${count++}`);
  assert.equal(process.exitCode, c.exitCode);
  assert.deepEqual(JSON.parse(output), c.expected);
}
process.stdout.write = write; process.exitCode = 0;
write(JSON.stringify({ schemaVersion: "pa-template-public-cli-fixture/v1", cases: count, passed: true, evidenceClass: "source-built-disposable-not-installed-or-human-authority" }) + "\n");
