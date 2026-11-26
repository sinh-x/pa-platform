import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import yaml from "js-yaml";

export const SECURITY_POLICY_SCHEMA = "pa-security-defaults/v1";
export const MAX_SECURITY_POLICY_BYTES = 64 * 1024;
export interface SecurityPatternData { readonly pattern: string; readonly flags: "" | "i" }
export interface SecurityDefaults {
  readonly schemaVersion: typeof SECURITY_POLICY_SCHEMA;
  readonly sha256: string;
  readonly safety: { readonly destructiveCommands: readonly SecurityPatternData[]; readonly blockedFilePatterns: readonly SecurityPatternData[] };
  readonly sensitive: { readonly filenames: readonly SecurityPatternData[]; readonly paths: readonly SecurityPatternData[]; readonly contents: readonly SecurityPatternData[] };
}
export type SecurityPolicyFailure = "unavailable" | "invalid" | "limit";
const reasons: Record<SecurityPolicyFailure, string> = {
  unavailable: "The required PA-owned default asset could not be acquired as a stable regular file.",
  invalid: "The required PA-owned default asset does not satisfy its supported data schema.",
  limit: "The required PA-owned default asset exceeds a supported byte or rule bound.",
};
/** Fixed, nonsecret guidance. No paths, YAML, exception prose, probes or retries. */
export class SecurityPolicyError extends Error {
  readonly category: SecurityPolicyFailure;
  constructor(category: SecurityPolicyFailure) {
    const safeCategory = category === "invalid" || category === "limit" ? category : "unavailable";
    super(`Security-dependent work is blocked; do not repeat a possible effect yet.\nCondition: Required security defaults cannot be used; the underlying operation's execution state is not established by this error.\nSource: PA-owned security defaults (${safeCategory}).\nReason: ${reasons[safeCategory]} No empty-rule or external fallback is allowed.\nCorrection: Ask the security/runtime operator to inspect the coherent code-and-policy package. Impact: none. Actor: agent or operator. New approval: not required to ask; any repair needs separate authority. Prerequisite: preserve the selected package and original operation evidence.\nResume Action: After owner-supported package correction, reestablish the process baseline. Reconcile any possible prior effect through its owner before a resumed request; admission is checked again.`);
    this.name = "SecurityPolicyError";
    this.category = safeCategory;
  }
}
const invalid = (): never => { throw new SecurityPolicyError("invalid"); };
const limit = (): never => { throw new SecurityPolicyError("limit"); };

/** Pure validation for the owned bundle only, not the legacy private schema. */
export function validateSecurityPolicy(bytes: Uint8Array): SecurityDefaults {
  if (bytes.byteLength > MAX_SECURITY_POLICY_BYTES) return limit();
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // CORE_SCHEMA accepts data only; duplicate keys reject by default. Aliases
    // cannot introduce shared/cyclic objects: every schema node is visited once.
    const raw: unknown = yaml.load(text, { schema: yaml.CORE_SCHEMA });
    const seen = new Set<object>();
    const record = (value: unknown, keys: string[]): Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
        || seen.has(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid();
      seen.add(value);
      return value as Record<string, unknown>;
    };
    let count = 0;
    const group = (value: unknown, safety = false): readonly SecurityPatternData[] => {
      if (!Array.isArray(value) || !value.length || seen.has(value)) return invalid();
      seen.add(value);
      if ((count += value.length) > 256) return limit();
      const entries = new Set<string>();
      return Object.freeze(value.map(item => {
        const entry = record(item, ["pattern", "flags"]);
        if (typeof entry.pattern !== "string" || !entry.pattern.length || (entry.flags !== "" && entry.flags !== "i") || (safety && entry.flags !== "i")) return invalid();
        if (entry.pattern.length > 4096) return limit();
        const key = JSON.stringify([entry.pattern, entry.flags]);
        if (entries.has(key)) return invalid();
        entries.add(key);
        new RegExp(entry.pattern, entry.flags);
        return Object.freeze({ pattern: entry.pattern, flags: entry.flags });
      }));
    };
    const root = record(raw, ["schemaVersion", "safety", "sensitive"]);
    if (root.schemaVersion !== SECURITY_POLICY_SCHEMA) return invalid();
    const safety = record(root.safety, ["destructiveCommands", "blockedFilePatterns"]);
    const sensitive = record(root.sensitive, ["filenames", "paths", "contents"]);
    return Object.freeze({ schemaVersion: SECURITY_POLICY_SCHEMA, sha256: createHash("sha256").update(bytes).digest("hex"),
      safety: Object.freeze({ destructiveCommands: group(safety.destructiveCommands, true), blockedFilePatterns: group(safety.blockedFilePatterns, true) }),
      sensitive: Object.freeze({ filenames: group(sensitive.filenames), paths: group(sensitive.paths), contents: group(sensitive.contents) }) });
  } catch (error) {
    if (error instanceof SecurityPolicyError) throw error;
    return invalid();
  }
}

let baseline: SecurityDefaults | SecurityPolicyError | undefined;
/** Lazy module-instance baseline, fixed to the selected package; no ambient root. */
export function getSecurityDefaults(): SecurityDefaults {
  if (baseline instanceof SecurityPolicyError) throw baseline;
  if (baseline) return baseline;
  try {
    baseline = acquireDefaults();
    return baseline;
  } catch (error) {
    baseline = error instanceof SecurityPolicyError ? error : new SecurityPolicyError("unavailable");
    throw baseline;
  }
}
function acquireDefaults(): SecurityDefaults {
  const fd = openSync(new URL("./policies/security-defaults.v1.yaml", import.meta.url), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new SecurityPolicyError("unavailable");
    if (before.size > BigInt(MAX_SECURITY_POLICY_BYTES)) return limit();
    const bytes = Buffer.alloc(MAX_SECURITY_POLICY_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > MAX_SECURITY_POLICY_BYTES) return limit();
    const after = fstatSync(fd, { bigint: true });
    if (BigInt(size) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new SecurityPolicyError("unavailable");
    return validateSecurityPolicy(bytes.subarray(0, size));
  } finally { closeSync(fd); }
}
