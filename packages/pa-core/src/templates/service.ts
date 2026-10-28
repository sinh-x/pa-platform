import { resolve } from "node:path";
import { findSensitiveMatch } from "../sensitive-patterns.js";
import { parseReviewMatrix, parseReviewObjective } from "../validation/review-contract.js";
import { loadTemplateRegistry, type TemplateSelection } from "./registry.js";
import { MAX_TEMPLATE_BYTES, MAX_TEMPLATE_REQUEST_BYTES, object, reject, relativePath, strictJson, string, TemplateError, utf8, type Row, type TemplateBinding, type TemplateEntry } from "./schema.js";

export interface TemplateHost { selection?: TemplateSelection; team?: string; mode?: string }
export type TemplateResult = { schemaVersion: "pa-template-result/v1"; unsigned: true; ok: boolean; operation: string; [key: string]: unknown };
export const TEMPLATE_LIMITATIONS = "Structural drafts only: no human decision, authenticated native facts, readiness, custody, publication or executed UAT is certified.";
export const MAX_TEMPLATE_RESULT_BYTES = 50 * 1024;
export function templateFailure(error: unknown): TemplateResult {
  const e = error instanceof TemplateError ? error : new TemplateError("TEMPLATE_REJECTED", "service", "input or selected configuration could not be safely processed");
  return { schemaVersion: "pa-template-result/v1", unsigned: true, ok: false, operation: "rejected", code: e.code, diagnostic: e.message, limitations: TEMPLATE_LIMITATIONS };
}
/** Pure read-only service. No stores, writers, subprocesses, imports or template evaluation. */
export function templateService(input: Uint8Array | Row, host: TemplateHost = {}): TemplateResult {
  try {
    const bytes = input instanceof Uint8Array ? input : Buffer.from(JSON.stringify(input));
    const request = object(strictJson(bytes), ["action"], ["id", "version", "bindings", "candidate"]);
    const action = request.action;
    if (!["list", "show", "render", "validate"].includes(String(action))) reject("TEMPLATE_ACTION", "request", "supported action required");
    object(request, action === "list" ? ["action"] : action === "show" ? ["action", "id", "version"] : action === "render" ? ["action", "id", "version", "bindings"] : ["action", "id", "version", "bindings", "candidate"]);
    const loaded = loadTemplateRegistry(host.selection);
    sensitive(JSON.stringify(loaded.registry));
    const base = { schemaVersion: "pa-template-result/v1" as const, unsigned: true as const, ok: true, operation: action as string, registry: { schemaVersion: loaded.registry.schemaVersion, runtimeContract: loaded.registry.runtimeContract, ...loaded.identity }, limitations: TEMPLATE_LIMITATIONS };
    let result: TemplateResult;
    if (action === "list") result = { ...base, entries: loaded.registry.entries };
    else {
      const id = string(request.id, /^[a-z0-9-]+$/, 64), version = string(request.version, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
      const entry = loaded.registry.entries.find((e) => e.id === id);
      if (!entry) reject("TEMPLATE_ID", "request", "unknown template ID");
      if (entry.revision !== version) reject("TEMPLATE_VERSION", "request", "exact selected template revision required");
      const source = loaded.sources.get(id)!;
      sensitive(source.raw);
      if (action === "show") result = { ...base, entry, source: source.raw };
      else {
        if (!entry.capabilities.render || (action === "validate" && !entry.capabilities.validate)) reject("TEMPLATE_CAPABILITY", "entry", "requested capability is explicitly gated by the selected registry");
        // Finite decision/handoff consumers are not interchangeable with generic
        // section checks. Never let config self-assert authority compatibility.
        if (["pair-signoff", "handoff-fresh", "handoff-amendment"].includes(id)) reject("TEMPLATE_CONSUMER_REQUIRED", "entry", "finite producer/consumer qualification is not delivered for this contract");
        if (!entry.contexts.some((c) => (c.team === "*" || c.team === host.team) && (c.mode === "*" || c.mode === host.mode))) reject("TEMPLATE_CONTEXT", "context", "actual host team/mode does not match allowed context");
        const bindings = object(request.bindings, [], Object.keys(entry.bindings));
        const encoded: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const [name, schema] of Object.entries(entry.bindings)) {
          if (!Object.hasOwn(bindings, name)) { if (schema.required) reject("TEMPLATE_MISSING_BINDING", "bindings", "required typed binding is missing"); continue; }
          encoded[name] = binding(bindings[name], schema);
        }
        const used = new Set<string>();
        const candidate = source.body.replace(/\{\{([a-z][A-Za-z0-9]{0,63})\}\}/g, (_match, name: string) => {
          used.add(name);
          if (!Object.hasOwn(encoded, name)) reject("TEMPLATE_UNRESOLVED", "source", "placeholder lacks an explicit binding");
          return encoded[name]!;
        });
        if (Object.keys(encoded).some((name) => !used.has(name))) reject("TEMPLATE_UNUSED_BINDING", "bindings", "binding has no declared source placeholder");
        if (/\{\{|\}\}/.test(candidate)) reject("TEMPLATE_UNRESOLVED", "candidate", "unresolved or malformed placeholder");
        if (Buffer.byteLength(candidate) > MAX_TEMPLATE_BYTES) reject("TEMPLATE_SIZE", "candidate", "rendered document exceeds byte limit");
        sensitive(candidate);
        validateShape(candidate, entry);
        if (action === "validate") {
          if (typeof request.candidate !== "string") reject("TEMPLATE_FIELD", "candidate", "exact candidate string required");
          const supplied = utf8(Buffer.from(request.candidate));
          if (supplied !== request.candidate || supplied !== candidate) reject("TEMPLATE_CANDIDATE", "candidate", "candidate must equal the complete deterministic rendering without normalization");
        }
        result = { ...base, entry, candidate, validation: { structural: true, consumer: entry.validation.kind !== "sections", authority: false } };
      }
    }
    // Same envelope bound for both adapters. Never truncate signed/source bytes.
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_TEMPLATE_RESULT_BYTES) reject("TEMPLATE_RESPONSE_SIZE", "result", "complete result exceeds shared native transport bound");
    return result;
  } catch (error) { return templateFailure(error); }
}
function sensitive(value: string): void {
  if (findSensitiveMatch("content", value)) reject("TEMPLATE_SENSITIVE", "input", "sensitive content is not permitted");
}
function binding(value: unknown, schema: TemplateBinding): string {
  if (schema.type === "json") {
    const encoded = JSON.stringify(value);
    if (!encoded || Buffer.byteLength(encoded) > MAX_TEMPLATE_REQUEST_BYTES) reject("TEMPLATE_BINDING", "bindings", "bounded JSON value required");
    sensitive(encoded); return encoded;
  }
  if (typeof value !== "string") reject("TEMPLATE_BINDING", "bindings", "binding has incorrect type");
  sensitive(value);
  if (schema.type === "multiline") {
    utf8(Buffer.from(value), MAX_TEMPLATE_REQUEST_BYTES);
    if (/[\p{Cf}\p{Cs}\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value) || /\r(?!\n)|\{\{|\}\}/.test(value)) reject("TEMPLATE_BINDING", "bindings", "unsafe narrative control or placeholder");
    // Narrative is inert indented Markdown, never a producer clause/header.
    return value.split(/\r?\n/).map((line) => `    ${line}`).join("\n");
  }
  const s = string(value, undefined, MAX_TEMPLATE_REQUEST_BYTES);
  const patterns: Partial<Record<TemplateBinding["type"], RegExp>> = {
    ticket: /^[A-Z][A-Z0-9]*-[0-9]+$/, repository: /^[A-Za-z0-9_-]+$/, sha: /^[0-9a-f]{40}$/, digest: /^[0-9a-f]{64}$/, revision: /^r[0-9]{3,}$/, handoff: /^(fresh|amendment)$/,
    branch: /^feature\/[A-Z][A-Z0-9]*-[0-9]+-[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    root: /^\/[A-Za-z0-9_./-]+$/,
    text: /^[\p{L}\p{N} ,.'()_-]+$/u,
  };
  if (patterns[schema.type] && !patterns[schema.type]!.test(s)) reject("TEMPLATE_BINDING", "bindings", "typed binding grammar mismatch");
  if (schema.type === "path") relativePath(s);
  if (schema.type === "root" && resolve(s) !== s) reject("TEMPLATE_BINDING", "bindings", "unaliased root required");
  if (schema.type === "branch" && (s.includes("..") || s.includes("//") || s.endsWith("/") || s.split("/").some((part) => part.endsWith(".") || part.endsWith(".lock")))) reject("TEMPLATE_BINDING", "bindings", "unaliased feature branch required");
  if (schema.type === "text" && /\b(?:approv\w*|reject\w*|withdraw\w*|revoke\w*)\b/i.test(s)) reject("TEMPLATE_BINDING", "bindings", "narrative cannot supply decision clauses");
  return s;
}
function validateShape(candidate: string, entry: TemplateEntry): void {
  if (entry.validation.kind === "review-matrix") { parseReviewMatrix(candidate); return; }
  if (entry.validation.kind === "review-objective") { parseReviewObjective(candidate); return; }
  const lines = candidate.split(/\r?\n/); let previous = -1;
  for (const section of entry.validation.sections) {
    const indexes = lines.flatMap((line, i) => line === section ? [i] : []);
    if (indexes.length !== 1 || indexes[0]! <= previous) reject("TEMPLATE_STRUCTURE", "candidate", "required sections must occur exactly once in declared order");
    previous = indexes[0]!;
  }
}
