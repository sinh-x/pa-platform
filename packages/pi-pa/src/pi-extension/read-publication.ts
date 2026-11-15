import { SourceContentSecurityError, type LocalSourceFile, type SensitivePatternSet } from "@pa-platform/pa-core";
import { bindLocalReadTool } from "./bound-local-read.js";
import { filterLocalToolResult, localContentFailure } from "./local-content-security.js";
import type { PiToolDefinition, PiToolResult } from "./index.js";

type AcquireSource = (path: string, patterns: SensitivePatternSet, signal?: AbortSignal) => LocalSourceFile;
type ReadFactory = Parameters<typeof bindLocalReadTool>[0];
interface PendingRead {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly sources: LocalSourceFile[];
  published?: PiToolResult;
  released: boolean;
  cleanupFailed: boolean;
}

const unavailable = () => localContentFailure(new SourceContentSecurityError("LOCAL_SOURCE_UNAVAILABLE"));

/** Private transport custody, NOT source provenance. Only the fixed native host
 * composes this owner with its authenticated acquirer and actual synchronous
 * runtime emission hook. Ordinary constructors do not acquire an exception.
 * No root, identity, grant or publisher is accepted through tool arguments. */
export class ReadPublicationOwner {
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<PendingRead>();
  readonly #results = new WeakMap<object, PendingRead>();
  readonly #ids = new Map<string, PendingRead>();

  createTool(factory: ReadFactory, acquire: AcquireSource): PiToolDefinition {
    const definition = bindLocalReadTool(factory, acquire);
    return { ...definition, execute: async (id, input, signal, update, context) => {
      if (this.#lifetime.signal.aborted) return unavailable();
      const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
      const pending: PendingRead = { id, signal: combined, sources: [], released: false, cleanupFailed: false };
      if (this.#ids.has(id)) return unavailable();
      this.#pending.add(pending);
      this.#ids.set(id, pending);
      const reader = bindLocalReadTool(factory, (path, patterns, acquisitionSignal) => {
        if (pending.released || combined.aborted) throw new SourceContentSecurityError("LOCAL_SOURCE_UNAVAILABLE");
        const source = acquire(path, patterns, acquisitionSignal);
        pending.sources.push(source);
        // Transfer ownership to the production publisher. The formatter cannot
        // release its pins before the runtime's later awaited transformations.
        return { bytes: source.bytes, assertStable: () => source.assertStable(), close() {} };
      });
      try {
        const result = await reader.execute(id, input, combined, update, context);
        this.#results.set(result.content, pending);
        return result;
      } catch (error) {
        this.#release(pending);
        this.#pending.delete(pending);
        this.#ids.delete(id);
        throw error;
      }
    } };
  }

  /** Called synchronously by the selected Pi runtime immediately before its
   * first public event sink. Later events reuse the committed outcome; shutdown
   * does not retract checked content that was already published while valid. */
  publishEvent(event: unknown, assertCurrentHost?: () => void): boolean {
    if (!event || typeof event !== "object") return false;
    const record = event as Record<string, any>;
    const result = record.type === "tool_execution_end" && record.toolName === "read" ? record.result
      : ["message_start", "message_end"].includes(record.type) && record.message?.role === "toolResult" && record.message?.toolName === "read" ? record.message
        : undefined;
    if (!result || typeof result !== "object" || !Array.isArray(result.content)) return false;
    const id = record.toolCallId ?? record.message?.toolCallId;
    const contentOwner = this.#results.get(result.content);
    const pending = contentOwner ?? this.#ids.get(id);
    if (!pending) return false;
    const correlated = contentOwner === pending && pending.id === id;
    if (!correlated && pending.published) {
      withholdUnownedReadEvent(event);
      return true;
    }
    if (!pending.published) {
      let failed = !correlated || pending.signal.aborted || this.#lifetime.signal.aborted || pending.released;
      if (!failed) {
        try { assertCurrentHost?.(); for (const source of pending.sources) source.assertStable(); }
        catch { failed = true; }
      }
      // Snapshot only the reader result contract, never the transport envelope.
      // The event may refer to the original result object, which is replaced in
      // place below; the committed snapshot must not alias that object.
      let checked = unavailable();
      if (!failed) {
        try {
          checked = structuredClone(filterLocalToolResult("read", {
            content: result.content, details: result.details ?? {},
            ...(result.isError === true || record.isError === true ? { isError: true } : {}),
            ...(Object.hasOwn(result, "structuredContent") ? { structuredContent: result.structuredContent } : {}),
          }));
        } catch { /* Uncopyable output cannot inherit native read custody. */ }
      }
      this.#release(pending);
      try { assertCurrentHost?.(); } catch { failed = true; }
      pending.published = failed || pending.cleanupFailed || pending.signal.aborted || this.#lifetime.signal.aborted ? unavailable() : checked;
      this.#pending.delete(pending);
      this.#ids.delete(pending.id);
    }
    // Never expose the private committed snapshot through mutable event
    // aliases. Later sinks get a fresh projection with correlated identity.
    const published = structuredClone(pending.published);
    this.#results.set(published.content, pending);
    if (record.type === "tool_execution_end") {
      // Preserve the outcome object's identity so later runtime messages use
      // the same replacement, but drop every unowned payload on withholding.
      for (const key of Object.keys(result)) delete result[key];
      Object.assign(result, published);
      record.isError = published.isError === true;
    } else {
      result.content = published.content;
      result.details = published.details;
      result.isError = published.isError === true;
      if (Object.hasOwn(result, "structuredContent") && published.structuredContent !== undefined) result.structuredContent = published.structuredContent;
      else delete result.structuredContent;
    }
    return true;
  }

  revoke(): void {
    this.#lifetime.abort();
    for (const pending of this.#pending) this.#release(pending);
    this.#pending.clear();
    this.#ids.clear();
  }

  #release(pending: PendingRead): void {
    if (pending.released) return;
    pending.released = true;
    for (const source of pending.sources.splice(0)) {
      try { source.close(); } catch { pending.cleanupFailed = true; }
    }
  }
}

/** Private selected-host transport only; this callback confers no source grant. */
export function publishReadEvent(owners: ReadonlySet<ReadPublicationOwner>, event: unknown, assertCurrentHost: () => void): void {
  const validate = () => {
    try { assertCurrentHost(); }
    catch (error) { for (const owner of owners) owner.revoke(); throw error; }
  };
  try {
    // A committed content identity is checked before current-host validation.
    // Only first commitment requires live host/source evidence; an unowned
    // event cannot borrow either the callback or an earlier checked snapshot.
    for (const owner of owners) if (owner.publishEvent(event, validate)) return;
  } catch { for (const owner of owners) owner.revoke(); }
  withholdUnownedReadEvent(event);
}

/** The selected native publisher never accepts an uncorrelated read body.
 * A result transformed into a new content identity cannot inherit old custody. */
export function withholdUnownedReadEvent(event: unknown): void {
  if (!event || typeof event !== "object") return;
  const record = event as Record<string, any>;
  const result = record.type === "tool_execution_end" && record.toolName === "read" ? record.result
    : ["message_start", "message_end"].includes(record.type) && record.message?.role === "toolResult" && record.message?.toolName === "read" ? record.message
      : undefined;
  if (!result || typeof result !== "object") return;
  const failure = unavailable();
  if (record.type === "tool_execution_end") {
    for (const key of Object.keys(result)) delete result[key];
    Object.assign(result, failure);
    record.isError = true;
  } else {
    result.content = failure.content; result.details = failure.details; result.isError = true;
    delete result.structuredContent;
  }
}
