import { readFileSync } from "node:fs";
import { TicketStore } from "../../tickets/store.js";
// Native data-owner concurrency fixture only; no claim of policy/human admission.
const store = new TicketStore(process.argv[2]!);
try { store.appendAutoDraftWithIntent(readFileSync(process.argv[3]!), { assertCurrent() {}, assertArtifacts() {} }); process.exitCode = 0; }
catch { process.exitCode = 2; }
