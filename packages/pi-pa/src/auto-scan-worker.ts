// Fixed read-only scanner subprocess. No caller-provided module/command, effect
// handler, approval port or stdin. The parent owns the 120-second wall deadline.
import { scanAutoWaitlist } from "@pa-platform/pa-core";
try { process.stdout.write(JSON.stringify(scanAutoWaitlist())); }
catch { process.exitCode = 1; }
