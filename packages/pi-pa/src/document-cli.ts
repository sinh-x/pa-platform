import { documentInterfaceDescription } from "@pa-platform/pa-core";

/** Static discovery only: no store construction, root overrides or CLI consent. */
export function runDocumentDescription(args: string[], io: { stdout(text: string): void; stderr(text: string): void }): number {
  if (!args.length || (args.length === 1 && args[0] === "--help")) {
    io.stdout("Usage: ppa document describe --format json\nDescribe pa_document's exact native request fields and limits. No CLI capture, publication, queue or imported approvals. Use the authenticated foreground Pi requirements tool; availability and installed qualification are separate facts."); return 0;
  }
  if (args.length === 3 && args[0] === "describe" && args[1] === "--format" && args[2] === "json") { io.stdout(JSON.stringify(documentInterfaceDescription())); return 0; }
  io.stderr("Unsupported document command. Use: ppa document --help. Native decisions/effects cannot be imported through CLI."); return 1;
}
