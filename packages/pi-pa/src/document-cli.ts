import { documentInterfaceDescription } from "@pa-platform/pa-core";
import { runLocalReviewCommand, type LocalReviewCliIO, type LocalReviewHandler } from "./local-review-cli.js";
import type { Readable } from "node:stream";

export async function runDocumentCommand(args: string[], io: LocalReviewCliIO, options: { stdin?: Readable; handler?: LocalReviewHandler } = {}): Promise<number> {
  if (args[0] === "review") return runLocalReviewCommand(args.slice(1), io, options);
  const messages: { stream: "stdout" | "stderr"; text: string }[] = [];
  const code = runDocumentDescription(args, { stdout: text => { messages.push({ stream: "stdout", text }); }, stderr: text => { messages.push({ stream: "stderr", text }); } });
  for (const message of messages) await io[message.stream](message.text);
  return code;
}

/** Static discovery only: no store construction, root overrides or CLI consent. */
export function runDocumentDescription(args: string[], io: { stdout(text: string): void; stderr(text: string): void }): number {
  if (!args.length || (args.length === 1 && args[0] === "--help")) {
    io.stdout("Usage: ppa document describe --format json\n       ppa document review --help\nDescribe pa_document's exact native request fields and limits, or inspect local-unverified v2 review/decision commands. Local decisions are unauthenticated; they are not human identity evidence. No CLI capture, publication, ref promotion, queue or imported approvals. Runtime selection and installed qualification are separate facts."); return 0;
  }
  if (args.length === 3 && args[0] === "describe" && args[1] === "--format" && args[2] === "json") { io.stdout(JSON.stringify(documentInterfaceDescription())); return 0; }
  io.stderr("Unsupported document command. Use: ppa document --help. Native decisions/effects cannot be imported through CLI."); return 1;
}
