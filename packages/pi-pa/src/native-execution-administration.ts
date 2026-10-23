import { runCoreCommand } from "@pa-platform/pa-core";
import type { PiToolCall } from "./pi-extension/index.js";

export interface ExecutionAdministrationIdentity { readonly deploymentId: string; readonly ticket: string }
export type ExecutionAdministration =
  | { readonly kind: "core"; readonly argv: readonly string[] }
  | { readonly kind: "date"; readonly utc: boolean }
  | { readonly kind: "ticket-comment" };

/** Exact administrative vocabulary, NOT a shell allowlist. Matching commands
 * are dispatched in-process to existing core owners with the live environment.
 * No shell, argv suffix, model-provided port, or phase-check authority is added. */
export function executionAdministration(call: PiToolCall, identity: ExecutionAdministrationIdentity): ExecutionAdministration | null {
  const raw = call.toolName ?? call.name;
  const name = raw?.startsWith("functions.") ? raw.slice(10) : raw;
  const input = call.input;
  if (name === "pa_ticket") {
    if (Object.keys(input).some((key) => !["action", "id", "author", "content"].includes(key))
      || input.action !== "comment" || input.id !== identity.ticket
      || input.author !== "builder/team-manager"
      || typeof input.content !== "string" || !input.content.trim() || Buffer.byteLength(input.content) > 16_384) return null;
    return { kind: "ticket-comment" };
  }
  if (name !== "bash" || typeof input.command !== "string"
    || Object.keys(input).some((key) => !["command", "timeout"].includes(key))
    || (input.timeout !== undefined && (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > 14_400))) return null;
  const command = input.command;
  if (command === "date" || command === "date -u") return { kind: "date", utc: command === "date -u" };
  const exact = new Map<string, readonly string[]>([
    ["ppa bulletin list", ["bulletin", "list"]],
    ["ppa repos list", ["repos", "list"]],
    [`ppa ticket show ${identity.ticket}`, ["ticket", "show", identity.ticket]],
    [`ppa ticket show ${identity.ticket} --json`, ["ticket", "show", identity.ticket, "--json"]],
    [`ppa status ${identity.deploymentId}`, ["status", identity.deploymentId]],
    [`ppa status ${identity.deploymentId} --json`, ["status", identity.deploymentId, "--json"]],
  ]);
  const argv = exact.get(command);
  if (argv) return { kind: "core", argv };
  // Failure reporting only. Success, ratings, fallbacks, log paths and updates
  // require their own acceptance/metadata contracts; this port cannot claim them.
  const prefix = `ppa registry complete ${identity.deploymentId} --status `;
  if (!command.startsWith(prefix)) return null;
  const match = /^(partial|failed) --summary (?:"([^"$`\\\r\n]*)"|'([^'\r\n]*)')$/.exec(command.slice(prefix.length));
  const summary = match?.[2] ?? match?.[3];
  if (!match || !summary?.trim() || Buffer.byteLength(summary) > 16_384) return null;
  return { kind: "core", argv: ["registry", "complete", identity.deploymentId, "--status", match[1]!, "--summary", summary] };
}

/** Called only AFTER the live native session reauthenticates the exact call.
 * Typed ticket comments retain their original registered TicketStore port. */
export async function runExecutionAdministration(request: Exclude<ExecutionAdministration, { kind: "ticket-comment" }>): Promise<{ text: string; exitCode: number }> {
  if (request.kind === "date") {
    const now = new Date();
    return { text: `${request.utc ? now.toUTCString() : now.toString()}\n`, exitCode: 0 };
  }
  const output: string[] = [];
  const exitCode = await runCoreCommand([...request.argv], { binaryName: "ppa", io: { stdout: (line) => output.push(line), stderr: (line) => output.push(line) } });
  return { text: output.join("\n"), exitCode };
}
