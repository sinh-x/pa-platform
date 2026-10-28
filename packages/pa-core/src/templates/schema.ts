import { createHash } from "node:crypto";
import { DOCUMENT_PROFILES } from "./document-profiles.js";
import { workflowProducerBindings } from "./binding-contracts.js";
import { parseReviewEvidenceJson, ReviewContractError } from "../validation/review-contract.js";

export const TEMPLATE_CONTRACT = "pa-template-registry/v1" as const;
export const TEMPLATE_RUNTIME = "pa-template-runtime/v1" as const;
export const MAX_TEMPLATE_BYTES = 1_048_576;
export const MAX_TEMPLATE_REQUEST_BYTES = 65_536;
export const TEMPLATE_IDS = ["requirements", "uat-review", "builder-objective", "implementation-phase-report", "orchestration-report", "project-agent-guide", "spike-full-requirements", "spike-learning-note", "spike-light-report", "spike-research-report", "uat-plan", "handoff-fresh", "handoff-amendment", "pair-signoff", "review-matrix", "review-objective"] as const;
/** Explicit PAP-271 extension; definitions/enablement/decisions remain workflow-owned. */
export const TEMPLATE_EXTENSION_IDS = ["review-bundle"] as const;
export type TemplateId = typeof TEMPLATE_IDS[number] | typeof TEMPLATE_EXTENSION_IDS[number];
export type Row = Record<string, unknown>;
export type BindingType = "text" | "multiline" | "ticket" | "repository" | "root" | "path" | "branch" | "sha" | "digest" | "revision" | "handoff" | "matrix-source" | "comment-ref" | "json";
export interface TemplateBinding { type: BindingType; required: boolean }
export interface TemplateEntry {
  id: TemplateId; revision: string; purpose: string; owner: string;
  contexts: Array<{ runtime: "pi"; team: string; mode: string }>;
  source: { path: string; sha256: string; selector: null | { start: string; end: string } };
  bindings: Record<string, TemplateBinding>;
  validation: { kind: "sections" | "review-matrix" | "review-objective" | "review-bundle" | "task-handoff" | "pair-signoff"; sections: string[] };
  capabilities: { render: boolean; validate: boolean; reason: string; authorityGate: string };
}
export interface TemplateRegistry { schemaVersion: typeof TEMPLATE_CONTRACT; configRevision: string; runtimeContract: typeof TEMPLATE_RUNTIME; entries: TemplateEntry[] }
export class TemplateError extends Error {
  constructor(readonly code: string, readonly source: string, readonly reason: string) {
    super(`Condition: ${code}\nSource: ${source}\nReason: ${reason}\nCorrection: The config/runtime owner must supply the exact supported selected template contract and bindings.\nResume Action: Retry retrieval or structural validation after correction; no approval or readiness is granted.`);
    this.name = "TemplateError";
  }
}
export function reject(code: string, source: string, reason: string): never { throw new TemplateError(code, source, reason); }
export function digest(bytes: string | Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function utf8(bytes: Uint8Array, limit = MAX_TEMPLATE_BYTES): string {
  if (bytes.byteLength > limit) reject("TEMPLATE_SIZE", "input", "byte limit exceeded");
  if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) reject("TEMPLATE_UTF8", "input", "BOM is unsupported");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return reject("TEMPLATE_UTF8", "input", "valid UTF-8 required"); }
}
export function strictJson(bytes: Uint8Array, limit = MAX_TEMPLATE_REQUEST_BYTES): unknown {
  utf8(bytes, limit);
  try { return parseReviewEvidenceJson(bytes, "template.input"); }
  catch (error) {
    const code = error instanceof ReviewContractError ? error.code.replace("REVIEW_", "TEMPLATE_") : "TEMPLATE_JSON";
    return reject(code, "input", "one bounded JSON object without duplicate fields or excessive nesting is required");
  }
}
export function object(value: unknown, required: string[], optional: string[] = []): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject("TEMPLATE_FIELD", "schema", "object required");
  const row = value as Row;
  if (required.some((key) => !Object.hasOwn(row, key)) || Object.keys(row).some((key) => ![...required, ...optional].includes(key))) reject("TEMPLATE_FIELD", "schema", "missing or unknown fields");
  return row;
}
export function string(value: unknown, pattern?: RegExp, max = 2048): string {
  if (typeof value !== "string" || !value.length || value.length > max || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) || (pattern && !pattern.test(value))) reject("TEMPLATE_FIELD", "schema", "field does not match its bounded grammar");
  return value;
}
export function relativePath(value: unknown): string {
  const path = string(value, /^[A-Za-z0-9_./-]+$/);
  if (path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) reject("TEMPLATE_PATH", "source", "contained unaliased relative path required");
  return path;
}
function list(value: unknown, min = 0, max = 64): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) reject("TEMPLATE_FIELD", "schema", "bounded array required");
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") reject("TEMPLATE_FIELD", "schema", "boolean required"); return value; }
export function parseTemplateRegistry(bytes: Uint8Array): TemplateRegistry {
  const r = object(strictJson(bytes, MAX_TEMPLATE_BYTES), ["schemaVersion", "configRevision", "runtimeContract", "entries"]);
  if (r.schemaVersion !== TEMPLATE_CONTRACT || r.runtimeContract !== TEMPLATE_RUNTIME) reject("TEMPLATE_VERSION", "registry", "unsupported registry/runtime contract pair");
  const entries = list(r.entries, TEMPLATE_IDS.length, TEMPLATE_IDS.length + TEMPLATE_EXTENSION_IDS.length).map((value): TemplateEntry => {
    const e = object(value, ["id", "revision", "purpose", "owner", "contexts", "source", "bindings", "validation", "capabilities"]);
    if (![...TEMPLATE_IDS, ...TEMPLATE_EXTENSION_IDS].includes(e.id as TemplateId)) reject("TEMPLATE_ID", "registry", "unknown inventory ID");
    const source = object(e.source, ["path", "sha256", "selector"]);
    const path = relativePath(source.path);
    if (!/^skills\/templates\/[a-z0-9-]+\.md$/.test(path)) reject("TEMPLATE_PATH", "registry", "resource must belong to the canonical template family");
    if ((TEMPLATE_IDS.slice(0, 10) as readonly string[]).includes(e.id as string) && path !== `skills/templates/${e.id as string}.md`) reject("TEMPLATE_INVENTORY", "registry", "initial canonical document IDs must retain their owned source paths");
    let selector: TemplateEntry["source"]["selector"] = null;
    if (source.selector !== null) { const s = object(source.selector, ["start", "end"]); selector = { start: string(s.start), end: string(s.end) }; if (selector.start === selector.end) reject("TEMPLATE_SELECTOR", "registry", "distinct selector delimiters required"); }
    const bindings = object(e.bindings, [], Object.keys((e.bindings ?? {}) as Row));
    if (Object.keys(bindings).length > 128) reject("TEMPLATE_SIZE", "registry", "too many bindings");
    const parsedBindings: Record<string, TemplateBinding> = Object.create(null) as Record<string, TemplateBinding>;
    for (const [key, value] of Object.entries(bindings)) {
      string(key, /^[a-z][A-Za-z0-9]{0,63}$/);
      const b = object(value, ["type", "required"]);
      if (typeof b.type !== "string" || !["text", "multiline", "ticket", "repository", "root", "path", "branch", "sha", "digest", "revision", "handoff", "matrix-source", "comment-ref", "json"].includes(b.type)) reject("TEMPLATE_BINDING", "registry", "unknown binding type");
      parsedBindings[key] = { type: b.type as BindingType, required: boolean(b.required) };
    }
    const bindingContract = workflowProducerBindings(e.id as string);
    if (bindingContract && (Object.keys(parsedBindings).length !== Object.keys(bindingContract).length || Object.entries(bindingContract).some(([key, value]) => parsedBindings[key]?.type !== value.type || parsedBindings[key]?.required !== value.required))) reject("TEMPLATE_BINDING", "registry", "workflow producer requires its exact runtime-owned typed binding schema");
    const v = object(e.validation, ["kind", "sections"]);
    if (typeof v.kind !== "string" || !["sections", "review-matrix", "review-objective", "review-bundle", "task-handoff", "pair-signoff"].includes(v.kind)) reject("TEMPLATE_CAPABILITY", "registry", "unsupported structural validator");
    const sections = list(v.sections).map((s) => string(s, /^#{1,6} [^#].*$/));
    if (new Set(sections).size !== sections.length || (v.kind === "sections" && !sections.length) || (v.kind !== "sections" && sections.length)) reject("TEMPLATE_FIELD", "registry", "unique section contracts required for Markdown only");
    const requiredKind = e.id === "handoff-fresh" || e.id === "handoff-amendment" ? "task-handoff" : ["review-matrix", "review-objective", "review-bundle", "pair-signoff"].includes(e.id as string) ? e.id : "sections";
    if (v.kind !== requiredKind) reject("TEMPLATE_CAPABILITY", "registry", "each producer requires its actual runtime-owned structural consumer");
    if (v.kind === "sections" && sections.length < (DOCUMENT_PROFILES[e.id as TemplateId]?.minimumSections ?? Infinity)) reject("TEMPLATE_STRUCTURE", "registry", "standard document must declare its complete minimum section contract");
    const c = object(e.capabilities, ["render", "validate", "reason", "authorityGate"]);
    if (c.validate === true && c.render !== true) reject("TEMPLATE_CAPABILITY", "registry", "standalone validation cannot bypass an explicitly disabled renderer");
    const contexts = list(e.contexts, 1).map((value): TemplateEntry["contexts"][number] => { const c = object(value, ["runtime", "team", "mode"]); if (c.runtime !== "pi") reject("TEMPLATE_CONTEXT", "registry", "only Pi/PPA is supported"); return { runtime: "pi", team: string(c.team, /^(?:\*|[a-z0-9-]+)$/), mode: string(c.mode, /^(?:\*|[a-z0-9-]+)$/) }; });
    return { id: e.id as TemplateId, revision: string(e.revision, /^(?:v?(?:0|[1-9][0-9]*)(?:\.[0-9]+){0,2}|r[0-9]{3,})$/), purpose: string(e.purpose), owner: string(e.owner), contexts,
      source: { path, sha256: string(source.sha256, /^[0-9a-f]{64}$/), selector }, bindings: parsedBindings,
      validation: { kind: v.kind as TemplateEntry["validation"]["kind"], sections }, capabilities: { render: boolean(c.render), validate: boolean(c.validate), reason: string(c.reason), authorityGate: string(c.authorityGate) } };
  });
  if (new Set(entries.map((e) => e.id)).size !== entries.length || TEMPLATE_IDS.some((id) => !entries.some((e) => e.id === id))) reject("TEMPLATE_INVENTORY", "registry", "every initial standard must have exactly one disposition");
  return { schemaVersion: TEMPLATE_CONTRACT, runtimeContract: TEMPLATE_RUNTIME, configRevision: string(r.configRevision, /^(?:selected|[0-9a-f]{40})$/), entries: entries.sort((a, b) => a.id < b.id ? -1 : 1) };
}
