import { resolve } from "node:path";
import { ProducerContractError } from "../tickets/producer-contract.js";
import { isCanonicalTicketId } from "../tickets/validate.js";
import { findSensitiveMatch } from "../sensitive-patterns.js";
import { parseReviewMatrix, parseReviewMatrixSource, parseReviewObjective, ReviewContractError } from "../validation/review-contract.js";
import { validateDocument } from "./documents.js";
import { validateWorkflowProducer } from "./workflow-producers.js";
import { loadTemplateRegistry, type TemplateSelection } from "./registry.js";
import { digest, MAX_TEMPLATE_BYTES, MAX_TEMPLATE_REQUEST_BYTES, object, reject, relativePath, strictJson, string, TemplateError, utf8, type Row, type TemplateBinding, type TemplateEntry } from "./schema.js";

export interface TemplateConsumerPort {
  /** Runtime-owned actual consumer, never a field supplied by CLI/tool JSON. */
  schemaVersion: "pa-review-bundle/v1";
  validate: (raw: Uint8Array) => unknown;
}
export interface TemplateHost { selection?: TemplateSelection; team?: string; mode?: string; reviewBundleConsumer?: TemplateConsumerPort }
export type TemplateResult = { schemaVersion: "pa-template-result/v1"; unsigned: true; ok: boolean; operation: string; [key: string]: unknown };
export const TEMPLATE_LIMITATIONS = "Structural drafts only: no human decision, authenticated native facts, readiness, custody, publication or executed UAT is certified.";
export const MAX_TEMPLATE_RESULT_BYTES = 50 * 1024;
function templateSchema(entry: TemplateEntry): string {
  const schemas: Record<TemplateEntry["validation"]["kind"], string> = { sections: "pa-template-document/v1", "task-handoff": "pa-task-handoff/v1", "pair-signoff": "pa-pair-signoff/v1", "review-matrix": "pa-review-matrix/v1", "review-objective": "pa-review-objective/v1", "review-bundle": "pa-review-bundle/v1" };
  return schemas[entry.validation.kind];
}
function entryMetadata(entry: TemplateEntry) { return { ...entry, templateSchema: templateSchema(entry) }; }
/** Explicit encoding of new typed JSON drafts, never a signed-byte rewrite. */
function canonicalJson(value: unknown): string {
  const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(key => [key, ordered((v as Row)[key])])) : v;
  return JSON.stringify(ordered(value));
}
export function templateFailure(error: unknown): TemplateResult {
  const e = error instanceof TemplateError ? error : error instanceof ProducerContractError
    ? new TemplateError("TEMPLATE_PRODUCER", "workflow-producer", "complete typed producer contract is missing, conflicting or malformed")
    : error instanceof ReviewContractError ? new TemplateError(`TEMPLATE_CONSUMER_${error.code.replace("REVIEW_", "")}`, `review-consumer.${error.diagnostic.source}`,  "producer does not satisfy the actual supported finite review contract")
    : new TemplateError("TEMPLATE_REJECTED", "service", "input or selected configuration could not be safely processed");
  return { schemaVersion: "pa-template-result/v1", unsigned: true, ok: false, operation: "rejected", code: e.code, diagnostic: e.message, limitations: TEMPLATE_LIMITATIONS };
}
/** Pure read-only service. No stores, writers, subprocesses, imports or template evaluation. */
export function templateService(input: Uint8Array | string | Row, host: TemplateHost = {}): TemplateResult {
  try {
    if (typeof input === "string") {
      if (input.length > MAX_TEMPLATE_REQUEST_BYTES || Buffer.byteLength(input) > MAX_TEMPLATE_REQUEST_BYTES) reject("TEMPLATE_SIZE", "input", "request document exceeds byte limit");
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input)) reject("TEMPLATE_UTF8", "input", "request document contains unpaired Unicode surrogates");
    }
    const bytes = input instanceof Uint8Array ? input : Buffer.from(typeof input === "string" ? input : JSON.stringify(input));
    const request = object(strictJson(bytes), ["action"], ["id", "version", "bindings", "candidate"]);
    const action = request.action;
    if (typeof action !== "string" || !["list", "show", "render", "validate"].includes(action)) reject("TEMPLATE_ACTION", "request", "supported action required");
    object(request, action === "list" ? ["action"] : action === "show" ? ["action", "id", "version"] : action === "render" ? ["action", "id", "version", "bindings"] : ["action", "id", "version", "bindings", "candidate"]);
    const loaded = loadTemplateRegistry(host.selection);
    sensitive(JSON.stringify(loaded.registry));
    const base = { schemaVersion: "pa-template-result/v1" as const, unsigned: true as const, ok: true, operation: action as string, registry: { schemaVersion: loaded.registry.schemaVersion, runtimeContract: loaded.registry.runtimeContract, ...loaded.identity }, limitations: TEMPLATE_LIMITATIONS };
    let result: TemplateResult;
    if (action === "list") result = { ...base, entries: loaded.registry.entries.map(entryMetadata) };
    else {
      const id = string(request.id, /^[a-z0-9-]+$/, 64), version = string(request.version, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
      const entry = loaded.registry.entries.find((e) => e.id === id);
      if (!entry) reject("TEMPLATE_ID", "request", "unknown template ID");
      if (entry.revision !== version) reject("TEMPLATE_VERSION", "request", "exact selected template revision required");
      const source = loaded.sources.get(id)!;
      sensitive(source.raw);
      if (action === "show") result = { ...base, entry: entryMetadata(entry), source: source.raw };
      else {
        if (!entry.capabilities.render || (action === "validate" && !entry.capabilities.validate)) reject("TEMPLATE_CAPABILITY", "entry", "requested capability is explicitly gated by the selected registry");
        if (!entry.contexts.some((c) => (c.team === "*" || c.team === host.team) && (c.mode === "*" || c.mode === host.mode))) reject("TEMPLATE_CONTEXT", "context", "actual host team/mode does not match allowed context");
        const bindings = object(request.bindings, [], Object.keys(entry.bindings));
        const encoded: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const [name, schema] of Object.entries(entry.bindings)) {
          if (!Object.hasOwn(bindings, name)) { if (schema.required) reject("TEMPLATE_MISSING_BINDING", `bindings.${name}`, "required typed binding is missing"); continue; }
          encoded[name] = binding(bindings[name], schema, `bindings.${name}`);
        }
        // Validate both selected and unselected branches; a typo cannot hide
        // behind a currently absent optional binding.
        const tokenRemainder = source.body.replace(/\{\{[#^/]?([a-z][A-Za-z0-9]{0,63})\}\}/g, (_match, name: string) => {
          if (!Object.hasOwn(entry.bindings, name)) reject("TEMPLATE_UNRESOLVED", "source", "source references an undeclared binding");
          return "";
        });
        if (/\{\{/.test(tokenRemainder)) reject("TEMPLATE_UNRESOLVED", "source", "source contains an unsupported placeholder or selector");
        const used = new Set<string>();
        // Optional blocks are a finite declarative selector, not an evaluator.
        // Nesting, undeclared fields and conditions on required fields reject.
        const selectedBody = source.body.replace(/\{\{([#^])([a-z][A-Za-z0-9]{0,63})\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_match, selector: string, name: string, body: string) => {
          if (!entry.bindings[name] || entry.bindings[name]!.required || /\{\{[#^/]/.test(body)) reject("TEMPLATE_UNRESOLVED", "source", "optional blocks require one declared optional binding without nesting");
          const present = Object.hasOwn(encoded, name);
          if (present) used.add(name);
          return present === (selector === "#") ? body : "";
        });
        const remainingSyntax = selectedBody.replace(/\{\{([a-z][A-Za-z0-9]{0,63})\}\}/g, "");
        if (/\{\{/.test(remainingSyntax)) reject("TEMPLATE_UNRESOLVED", "source", "source contains unmatched selectors or placeholders");
        const candidate = selectedBody.replace(/\{\{([a-z][A-Za-z0-9]{0,63})\}\}/g, (_match, name: string) => {
          used.add(name);
          if (!Object.hasOwn(encoded, name)) reject("TEMPLATE_UNRESOLVED", "source", "placeholder lacks an explicit binding");
          return encoded[name]!;
        });
        if (Object.keys(encoded).some((name) => !used.has(name))) reject("TEMPLATE_UNUSED_BINDING", "bindings", "binding has no declared source placeholder");
        if (Buffer.byteLength(candidate) > MAX_TEMPLATE_BYTES) reject("TEMPLATE_SIZE", "candidate", "rendered document exceeds byte limit");
        sensitive(candidate);
        validateShape(candidate, entry, host, bindings);
        if (action === "validate") {
          if (typeof request.candidate !== "string") reject("TEMPLATE_FIELD", "candidate", "exact candidate string required");
          const supplied = utf8(Buffer.from(request.candidate));
          if (supplied !== request.candidate || supplied !== candidate) reject("TEMPLATE_CANDIDATE", "candidate", "candidate must equal the complete deterministic rendering without normalization");
        }
        result = { ...base, entry: entryMetadata(entry), candidate,
          producer: { schemaVersion: "pa-template-producer/v1", templateId: entry.id, templateRevision: entry.revision, templateSchema: templateSchema(entry), sourceSha256: entry.source.sha256,
            configRevision: loaded.identity.configRevision, registrySha256: loaded.identity.registrySha256, bindingsSha256: digest(canonicalJson(bindings)), candidateSha256: digest(candidate),
            consumerContract: entry.validation.kind === "review-bundle" ? "pa-review-bundle/v1" : entry.validation.kind === "review-matrix" ? "pa-review-matrix/v1" : entry.validation.kind === "review-objective" ? "pa-review-objective/v1" : entry.validation.kind === "task-handoff" ? "pa-task-handoff/v1" : entry.validation.kind === "pair-signoff" ? "pa-pair-signoff/v1" : null },
          validation: { structural: true, consumer: entry.validation.kind !== "sections", authority: false } };
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
function binding(value: unknown, schema: TemplateBinding, source: string): string {
  if (schema.type === "json") {
    const encoded = canonicalJson(value);
    if (!encoded || Buffer.byteLength(encoded) > MAX_TEMPLATE_REQUEST_BYTES) reject("TEMPLATE_BINDING", source, "bounded JSON value required");
    sensitive(encoded); return encoded;
  }
  if (typeof value !== "string") reject("TEMPLATE_BINDING", source, "binding has incorrect type");
  sensitive(value);
  if (schema.type === "multiline") {
    utf8(Buffer.from(value), MAX_TEMPLATE_REQUEST_BYTES);
    if (/[\p{Cf}\p{Cs}\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value) || /\r(?!\n)|\{\{|\}\}/.test(value)) reject("TEMPLATE_BINDING", source, "unsafe narrative control or placeholder");
    // Narrative is inert indented Markdown, never a producer clause/header.
    return `    ${value.replaceAll("\n", "\n    ")}`;
  }
  if (!value.length || value.length > MAX_TEMPLATE_REQUEST_BYTES || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) reject("TEMPLATE_BINDING", source, "bounded scalar binding without control or format characters required");
  const s = value;
  const patterns: Partial<Record<TemplateBinding["type"], RegExp>> = {
    ticket: /^[A-Z][A-Z0-9]*-[0-9]+$/, repository: /^[A-Za-z0-9_-]+$/, sha: /^[0-9a-f]{40}$/, digest: /^[0-9a-f]{64}$/, revision: /^r[0-9]{3,}$/, handoff: /^(fresh|amendment)$/,
    branch: /^feature\/[A-Z][A-Z0-9]*-[0-9]+-[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    root: /^\/[A-Za-z0-9_./-]+$/, "comment-ref": /^[A-Z][A-Z0-9]*-[0-9]+#c-[0-9]{17}$/,
    text: /^[\p{L}\p{N} ,.'()_-]+$/u,
  };
  if (patterns[schema.type] && !patterns[schema.type]!.test(s)) reject("TEMPLATE_BINDING", source, `binding requires the exact ${schema.type} grammar`);
  if ((schema.type === "ticket" && !isCanonicalTicketId(s)) || (schema.type === "comment-ref" && !isCanonicalTicketId(s.split("#")[0]))) reject("TEMPLATE_BINDING", source, "binding requires a canonical bounded ticket ID");
  if (schema.type === "path") relativePath(s);
  if (schema.type === "matrix-source") parseReviewMatrixSource(s);
  if (schema.type === "root" && resolve(s) !== s) reject("TEMPLATE_BINDING", source, "unaliased root required");
  if (schema.type === "branch" && (s.includes("..") || s.includes("//") || s.endsWith("/") || s.split("/").some((part) => part.endsWith(".") || part.endsWith(".lock")))) reject("TEMPLATE_BINDING", source, "unaliased feature branch required");
  if (schema.type === "text" && /\b(?:approv\w*|reject\w*|withdraw\w*|revoke\w*)\b/i.test(s)) reject("TEMPLATE_BINDING", source, "narrative cannot supply decision clauses");
  return s;
}
function validateShape(candidate: string, entry: TemplateEntry, host: TemplateHost, bindings: Row): void {
  if (entry.validation.kind === "task-handoff" || entry.validation.kind === "pair-signoff") { validateWorkflowProducer(candidate, entry, bindings); return; }
  if (entry.validation.kind === "review-bundle") {
    if (!host.reviewBundleConsumer || host.reviewBundleConsumer.schemaVersion !== "pa-review-bundle/v1") reject("TEMPLATE_CONSUMER_REQUIRED", "workflow", "PAP-271 must register its actual pa-review-bundle/v1 parser; no template-side authority or fallback exists");
    host.reviewBundleConsumer.validate(Buffer.from(candidate)); return;
  }
  if (entry.validation.kind === "review-matrix") { parseReviewMatrix(candidate); return; }
  if (entry.validation.kind === "review-objective") { parseReviewObjective(candidate); return; }
  validateDocument(candidate, entry.id, entry.validation.sections);
}
