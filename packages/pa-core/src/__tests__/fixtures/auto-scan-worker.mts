// Disposable concurrency fixture only; no product/decision/dispatch effects.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { AutoWaitlistStore } from "../../auto/store.js";
import { buildAutoWaitlist } from "../../auto/waitlist.js";
const [usage, root] = process.argv.slice(2);
const view = new AutoWaitlistStore(usage!).scan(() => {
  appendFileSync(join(root!, "producer-started"), "started\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  const at = new Date().toISOString();
  return buildAutoWaitlist({ observedAt: at, completedAt: at, projects: [
    { key: "pa-platform", prefix: "PAP", canonicalRoot: join(root!, "pa-platform") },
    { key: "pa-platform-config", prefix: "PAPC", canonicalRoot: join(root!, "pa-platform-config") },
  ], tickets: [] });
});
process.stdout.write(`${view.scan}\n`);
