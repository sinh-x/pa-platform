import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
let frame;
export function initialize(data) { frame = data; }
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  if (!frame || !result.url.startsWith("file:")) return result;
  const path = fileURLToPath(result.url), physical = realpathSync(path);
  if (physical.startsWith(frame.sourceRoot + "/packages/") && physical.includes("/src/") && !physical.includes("/__tests__/")) throw new Error("qualification denied runtime source fallback");
  const prefix = frame.moduleRoot + "/";
  if (physical.startsWith(prefix) && /^packages\/(?:pa-core|pi-pa|opencode-pa|runtime-host)\/dist\//.test(physical.slice(prefix.length)) && !physical.includes("/__tests__/")) {
    const relative = physical.slice(prefix.length), expected = frame.modules[relative];
    if (!expected || hash(readFileSync(physical)) !== expected) throw new Error("qualification denied implementation module substitution");
    appendFileSync(frame.audit, JSON.stringify({ kind: "implementation", path: physical, sha256: expected }) + "\n", { mode: 0o600 });
  }
  if (physical.startsWith(frame.harness + "/packages/") && (physical.includes("/src/") || physical.includes("/dist/")) && !physical.includes("/__tests__/")) {
    const relative = physical.slice(frame.harness.length + 1).replace("/dist/", "/src/").replace(/\.js$/, ".ts"), expected = frame.bridges[relative];
    if (!expected || hash(readFileSync(physical)) !== expected.bridgeSha256) throw new Error("qualification denied modified implementation bridge");
  }
  return result;
}
