// Disposable concurrency fixture only; no product/decision/dispatch effects.
import { appendFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { AutoWaitlistStore } from "../../auto/store.js";
import { buildAutoWaitlist } from "../../auto/waitlist.js";
const [usage, root, hold] = process.argv.slice(2);
const view = new AutoWaitlistStore(usage!).scan(() => {
  appendFileSync(join(root!, "producer-started"), "started\n");
  process.send!("producer-started");
  if (hold === "hold") {
    // Hold the actual scan until the parent observes the contender's result;
    // module startup speed must not determine whether the processes overlap.
    const release = Buffer.alloc(1);
    if (readSync(0, release, 0, 1, null) !== 1 || release[0] !== 1) throw new Error("Fixture producer was not released.");
  }
  const at = new Date().toISOString();
  return buildAutoWaitlist({ observedAt: at, completedAt: at, projects: [
    { key: "pa-platform", prefix: "PAP", canonicalRoot: join(root!, "pa-platform") },
    { key: "pa-platform-config", prefix: "PAPC", canonicalRoot: join(root!, "pa-platform-config") },
  ], tickets: [] });
});
process.stdout.write(`${view.scan}\n`);
process.disconnect!();
