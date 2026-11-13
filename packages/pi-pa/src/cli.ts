#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AutoWaitlistStore, runCoreCommand, runWorkflowCommand, templateFailure } from "@pa-platform/pa-core";
import { createDefaultPiHooks } from "./deploy.js";
import { removePi, setupPi, statusPi } from "./setup.js";
import { PiAdapter } from "./adapter.js";
import { probePiNativeRegistryAddon, runPiManagedToolSmoke } from "./native-host.js";
import { runReviewPreflightCommand } from "./review-preflight.js";
import { piWorkflowReadHost, piRetainedTemplateHost } from "./workflow-host.js";
import { runDocumentDescription } from "./document-cli.js";
import { runTicketStatusCommand } from "./ticket-status.js";
import { CHILD_RECONCILIATION_USAGE, runChildReconciliationCommand } from "./child-reconciliation.js";
import { TICKET_RECOVERY_USAGE, runTicketRecoveryInspectionCommand } from "./ticket-recovery.js";
import { TICKET_WORKTREE_RECOVERY_USAGE, runTicketWorktreeRecoveryCommand } from "./ticket-worktree-recovery.js";
import { AUTO_USAGE, runAutoCommand } from "./auto-cli.js";
import { runAutoForeground } from "./auto-foreground.js";
import { piAutoForegroundHooks } from "./auto-runtime.js";
import { publishAutoNotice, runAutoBackgroundCommand } from "./auto-background.js";

if (process.argv[2] === "auto") {
  process.exitCode = ["tick", "units"].includes(process.argv[3] ?? "")
    ? await runAutoBackgroundCommand(process.argv.slice(3), { stdout: s => process.stdout.write(`${s}\n`), stderr: s => process.stderr.write(`${s}\n`) })
    : process.argv.length === 3 && process.stdin.isTTY
    ? await runAutoForeground(undefined, { ...piAutoForegroundHooks, changed: journal => {
      try {
        const notice = publishAutoNotice(journal, new AutoWaitlistStore().read());
        if (notice?.delivery === "unavailable") process.stderr.write("Desktop notification unavailable. The item is saved; run ppa auto. No approval or launch is inferred from notification delivery.\n");
      } catch { process.stderr.write("Desktop notification outcome is unknown. Keep the saved item and inspect ppa auto status; do not repeat a launch.\n"); }
    } })
    : runAutoCommand(process.argv.slice(3), { stdout: s => process.stdout.write(`${s}\n`), stderr: s => process.stderr.write(`${s}\n`) });
} else if (process.argv[2] === "workflow" || process.argv[2] === "decision") {
  process.exitCode = runWorkflowCommand(process.argv[2], process.argv.slice(3), { stdout: s => process.stdout.write(`${s}\n`), stderr: s => process.stderr.write(`${s}\n`) }, piWorkflowReadHost());
} else if (process.argv[2] === "ticket-status") {
  process.exitCode = runTicketStatusCommand(process.argv.slice(3), { stdout: s => process.stdout.write(`${s}\n`), stderr: s => process.stderr.write(`${s}\n`) });
} else if (process.argv[2] === "document") {
  process.exitCode = runDocumentDescription(process.argv.slice(3), { stdout: s => process.stdout.write(`${s}\n`), stderr: s => process.stderr.write(`${s}\n`) });
} else if (process.argv[2] === "template") {
  // Template --version selects a resource revision, not the global PPA version.
  // This route uses only existing read-only workflow journals, never deployment
  // hooks, database migration or a caller-supplied run/resource override.
  try { process.exitCode = await runCoreCommand(process.argv.slice(2), { binaryName: "ppa", templateHost: piRetainedTemplateHost() }); }
  catch (error) { process.stdout.write(`${JSON.stringify(templateFailure(error))}\n`); process.exitCode = 1; }
} else if (process.argv[2] === "pi" && process.argv[3] === "ticket-worktree") {
  process.exitCode = runTicketWorktreeRecoveryCommand(process.argv.slice(4));
} else if (process.argv[2] === "pi" && process.argv[3] === "inspect-recovery") {
  process.exitCode = runTicketRecoveryInspectionCommand(process.argv.slice(4));
} else if (process.argv[2] === "pi" && process.argv[3] === "reconcile-child") {
  process.exitCode = runChildReconciliationCommand(process.argv.slice(4));
} else if (process.argv.includes("--version") || process.argv.includes("-V")) {
  const pkg = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version: string };
  process.stdout.write(`ppa ${pkg.version}\n`);
  process.exit(0);
} else if (process.argv[2] === "review") {
  process.exitCode = runReviewPreflightCommand(process.argv.slice(3));
} else if (process.argv[2] === "pi" && ["setup", "status", "remove", "preflight", "smoke-tools", "teardown-smoke"].includes(process.argv[3] ?? "")) {
  const local = process.argv.includes("--local");
  const action = process.argv[3];
  process.exitCode = await (action === "setup"
    ? setupPi({ local }).then((result) => { process.stdout.write(`${result.changed ? "Configured" : "Already configured"}: ${result.settingsPath}\nPackages:\n${result.packages.join("\n")}\nReload active Pi sessions with /reload.\n`); })
    : action === "status"
      ? Promise.resolve(statusPi({ local })).then((result) => { process.stdout.write(`Settings: ${result.settingsPath}\nExtension source: ${result.extensionPath}\nConfig source: ${result.configDir}\nConfigured: ${result.configured ? "yes" : "no"}\nPackages:\n${result.packages.length > 0 ? result.packages.join("\n") : "(none)"}\nReload active Pi sessions with /reload.\n`); })
      : action === "preflight"
        ? new PiAdapter().preflight().then(() => { process.stdout.write(`${JSON.stringify(probePiNativeRegistryAddon())}\n`); })
        : action === "smoke-tools"
          ? Promise.resolve(runPiManagedToolSmoke()).then((result) => { process.stdout.write(`${JSON.stringify(result)}\n`); })
          : action === "teardown-smoke"
            ? new PiAdapter().preflight().then(() => { runTeardownSmoke(process.argv.slice(4)); })
            : removePi({ local }).then((result) => { process.stdout.write(`${result.changed ? "Removed" : "Nothing removed"}: ${result.settingsPath}\n`); })
  ).then(() => 0).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; });
} else {
process.exitCode = await runCoreCommand(process.argv.slice(2), { hooks: createDefaultPiHooks(), binaryName: "ppa" });
if (process.argv.length === 2 || process.argv[2] === "--help") process.stdout.write(`\n${AUTO_USAGE}\nPi-only: workflow list|show|validate|preflight|status|next; decision show|verify (read-only).\nPi-only: ticket-status --help (selected administrative status owner; no approval/effects).\nPi-only: document describe --format json (interface discovery only; no CLI approval/effects).\nPi-only: review preflight --ticket <ID> --objective-file <request.json> [--json]\n${CHILD_RECONCILIATION_USAGE}\n${TICKET_RECOVERY_USAGE}\n${TICKET_WORKTREE_RECOVERY_USAGE}\n`);
}

function runTeardownSmoke(args: string[]): void {
  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/pap-167-pi-retry-smoke.mjs");
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    env: { ...process.env, PAP167_PPA_INVOKED: "1" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Installed Pi teardown smoke terminated with signal ${result.signal}.`);
  if (result.status !== 0) throw new Error(`Installed Pi teardown smoke exited with status ${result.status ?? 1}.`);
}
