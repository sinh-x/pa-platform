import { isBlockedFilePath, isDestructiveCommand } from "@pa-platform/pa-core";
import * as PaSafety from "@pa-platform/pa-core";
import type { PiSafetyDecision, PiToolCall } from "./index.js";

/** Editor/extension-registration-free boundary shared by the CLI-loaded native
 * adapter and the extension. Loading CLI admission must not load editor aliases. */
export function interceptToolCall(call: PiToolCall): PiSafetyDecision {
  const rawName = (call.name ?? call.toolName ?? "").toLowerCase();
  const name = rawName.startsWith("functions.") ? rawName.slice("functions.".length) : rawName;
  if (name === "bash" || name === "shell" || name === "execute") {
    const command = typeof call.input.command === "string" ? call.input.command : "";
    const decision = evaluateAdapterSafety({ kind: "shell", value: command }, "ppa");
    if (!decision.allowed) return blockedSafetyDecision(decision);
  }
  for (const filePath of declaredPathValues(call.input)) {
    const decision = evaluateAdapterSafety({ kind: "path", value: filePath }, "ppa");
    if (!decision.allowed) return blockedSafetyDecision(decision);
  }
  return { allowed: true };
}

type AdapterSafetyInput = { kind: "prose" | "path" | "shell"; value: string };
interface AdapterSafetyDecision { allowed: boolean; reason?: string; guidance?: string; target?: string }
interface AdapterSafetyModule {
  evaluateSafetyPolicy?: (input: AdapterSafetyInput, options?: { trashExecutable?: string; cwd?: string; env?: Pick<NodeJS.ProcessEnv, "TMPDIR"> }) => AdapterSafetyDecision;
  isBlockedFilePath: (filePath: string) => boolean;
  isDestructiveCommand: (command: string) => boolean;
  formatTrashMoveGuidance?: (target: string, executable?: string) => string;
}
const ADAPTER_SAFETY = { ...PaSafety, isBlockedFilePath, isDestructiveCommand } as unknown as AdapterSafetyModule;
const PATH_KEYS = new Set(["path", "filePath", "file_path"]);

function evaluateAdapterSafety(input: AdapterSafetyInput, trashExecutable: string): AdapterSafetyDecision {
  if (ADAPTER_SAFETY.evaluateSafetyPolicy) return ADAPTER_SAFETY.evaluateSafetyPolicy(input, { trashExecutable });
  if (input.kind === "prose") return { allowed: true };
  if (input.kind === "path") return ADAPTER_SAFETY.isBlockedFilePath(input.value)
    ? { allowed: false, reason: `Protected path access is not allowed: ${input.value}`, target: input.value }
    : { allowed: true };
  return legacyShellDecision(input.value, trashExecutable);
}

function legacyShellDecision(command: string, trashExecutable: string): AdapterSafetyDecision {
  const deletion = /(?:^|[\s;&|()])(?:command\s+|sudo\s+)*(?:rm|rmdir|unlink|shred)\b(?:\s+-[^\s]+)*\s+("[^"]+"|'[^']+'|[^\s;&|()<>]+)/i.exec(command);
  if (deletion) {
    const target = deletion[1] ?? "<target>";
    const guidance = ADAPTER_SAFETY.formatTrashMoveGuidance?.(target, trashExecutable)
      ?? `${trashExecutable} trash move ${target} --reason 'Replace direct deletion denied by PA safety policy' --yes`;
    return { allowed: false, reason: `Direct deletion is not allowed for target ${target}`, guidance, target };
  }
  const redirect = /(?:^|[^>])(?:\d*)>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|()]+)/g;
  for (const match of command.matchAll(redirect)) {
    const target = stripShellQuotes(match[1] ?? "");
    if (target === "/dev/null" || target.startsWith("/tmp/") || target.startsWith("$TMPDIR/")) continue;
    return { allowed: false, reason: `Output is allowed only for /dev/null or a verified system-temp target: ${target}`, target };
  }
  for (const token of command.match(/"[^"]*"|'[^']*'|[^\s;&|()]+/g) ?? []) {
    const value = stripShellQuotes(token);
    if (value.includes(" ") || (!value.includes("/") && !value.startsWith(".") && !/\.(?:json|ya?ml|env|netrc|npmrc|pypirc)$/i.test(value))) continue;
    if (ADAPTER_SAFETY.isBlockedFilePath(value)) return { allowed: false, reason: `Protected path access is not allowed: ${token}`, target: token };
  }
  const commandWithoutRedirects = command.replace(redirect, " ");
  return ADAPTER_SAFETY.isDestructiveCommand(commandWithoutRedirects)
    ? { allowed: false, reason: "Destructive command detected by PA safety policy." }
    : { allowed: true };
}

function blockedSafetyDecision(decision: AdapterSafetyDecision): PiSafetyDecision {
  const guidance = decision.guidance ? ` Use ${decision.guidance}.` : "";
  return { allowed: false, reason: `BLOCKED: ${decision.reason ?? "PA safety policy denied this operation."}${guidance}` };
}

function declaredPathValues(input: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!PATH_KEYS.has(key)) continue;
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) values.push(...value.filter((item): item is string => typeof item === "string"));
  }
  return values;
}

function stripShellQuotes(value: string): string {
  return ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) ? value.slice(1, -1) : value;
}
