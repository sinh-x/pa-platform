// Isolated foreground transport stand-in, not a real Pi/operator UAT session.
// The production adapter records our incarnation and PID. Never insert launch
// evidence or construct an authenticated actor in this child.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createPaRepoSetupTool } from "../../pi-extension/repo-setup.js";

const deadline = Date.now() + 10_000;
while (!existsSync(join(process.env.PA_DEPLOYMENT_DIR!, "pi-process-identity.json"))) {
  if (Date.now() >= deadline) throw new Error("launch incarnation was not recorded");
  await setTimeout(10);
}
const tool = createPaRepoSetupTool(), results = [];
for (const request of [{ action: "discover", path: "." }, { action: "inspect" }]) {
  const result = await tool.execute("launch-regression", { request: JSON.stringify(request) }, undefined, undefined, { cwd: process.cwd() });
  results.push(JSON.parse(result.content[0]!.text));
}
writeFileSync(process.argv[2]!, JSON.stringify({ pid: process.pid, cwd: process.cwd(), results }));
if (results.some(result => result.ok !== true)) process.exitCode = 1;
