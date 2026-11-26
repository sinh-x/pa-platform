import type { SensitivePatternSet } from "./sensitive-patterns.js";

/** Opaque, ephemeral presentation reference, NOT read permission or provenance.
 * Only the existing path guard creates one after admission; no raw path is kept
 * on an error or accepted from a tool request as diagnostic authority. */
declare const referenceBrand: unique symbol;
export type LocalSourceDiagnosticReference = { readonly [referenceBrand]: true };
const references = new WeakMap<object, string>();
export const MAX_DIAGNOSTIC_FILE_CHARS = 512;

/** Pure disclosure check over the path guard's already loaded policy. No loads,
 * resolution, reads or probes. Protected-path admission remains with its owner. */
export function localSourceDiagnosticReference(path: string, policy: SensitivePatternSet): LocalSourceDiagnosticReference | undefined {
  try {
    if (typeof path !== "string" || !path.startsWith("/") || path.length > 4096) return undefined;
    for (const pattern of policy.patterns) {
      if (pattern.inputClass === "content" && new RegExp(pattern.regex.source, pattern.regex.flags.replace(/[gy]/g, "")).test(path)) return undefined;
    }
    // Keep the exact requested spelling, including hostile Unicode, recognizable
    // without allowing newlines, terminal controls, bidi or diagnostic labels.
    const display = JSON.stringify(path).replace(/[\p{Cc}\p{Cf}\p{Cs}:]/gu, char =>
      Array.from({ length: char.length }, (_, n) => `\\u${char.charCodeAt(n).toString(16).padStart(4, "0")}`).join(""));
    if (display.length > MAX_DIAGNOSTIC_FILE_CHARS) return undefined;
    const reference = Object.freeze({}) as LocalSourceDiagnosticReference;
    references.set(reference, display);
    return reference;
  } catch { return undefined; } // Missing/unusable disclosure evidence withholds the path, never the guard.
}

const facts = {
  "not-regular": ["file type", "The opened source is not a regular file. Regular-file admission is required; link and selected-document metadata checks were not evaluated", "before-read"],
  "ordinary-multiple-links": ["ordinary file hard-link count", "The ordinary reader requires exactly one hard link. No selected-Pi document binding was supplied on this route; immutable exception checks were not evaluated. This is an admission rejection, not an observed OS permission failure", "before-read"],
  "selected-alias": ["selected document path association", "The multi-link document's requested path differs from its resolved path. The selected-document exception requires an exact physical path; immutable metadata checks were not evaluated", "before-read"],
  "immutable-owner": ["selected document ownership", "The inspected entry is not root-owned, as required by the selected-document exception", "before-read"],
  "immutable-unlinked": ["selected document link metadata", "The inspected entry has zero links. The selected-document exception requires a linked entry", "before-read"],
  "store-directory-mode": ["selected document store-directory permissions", "The Nix store directory has write permissions not admitted by the selected-document policy", "before-read"],
  "store-entry-writable": ["selected document immutable permissions", "The inspected Nix store entry has write permissions. The selected-document exception requires it to be read-only", "before-read"],
  "ancestor-writable": ["selected document ancestor permissions", "An inspected ancestor permits group or other-user writes, which the selected-document policy does not admit", "before-read"],
  "selected-root": ["selected Pi package-root syntax", "The supplied selected-package root or path does not satisfy the finite canonical path contract. This scope check did not evaluate file metadata", "before-read"],
  "selected-scope": ["selected Pi document scope", "The requested path is outside the selected package's finite README/docs/examples document scope. This scope check did not evaluate file metadata", "before-read"],
  "text-image": ["selected document text classification", "The complete candidate bytes have a recognized image signature. The multi-link exception admits text documents, not images; UTF-8 validation was not evaluated", "after-read"],
  "text-utf8": ["selected document UTF-8 validation", "Complete fatal UTF-8 decoding failed. The multi-link exception requires valid UTF-8 text", "after-read"],
  "text-controls": ["selected document text controls", "The decoded text contains control characters forbidden by the multi-link text exception", "after-read"],
} as const;
export type LocalSourceUnsupportedCause = keyof typeof facts;
export interface LocalSourceUnsupportedObservation {
  readonly cause: LocalSourceUnsupportedCause;
  readonly reference?: LocalSourceDiagnosticReference;
  readonly links?: bigint;
  readonly entry?: "file" | "ancestor";
  readonly readState?: "not-started" | "attempted";
}
export function normalizeUnsupportedObservation(input: unknown): LocalSourceUnsupportedObservation | undefined {
  try {
    if (!input || typeof input !== "object") return undefined;
    const value = (key: string): unknown => Object.getOwnPropertyDescriptor(input, key)?.value;
    const cause = value("cause"), reference = value("reference"), links = value("links"), entry = value("entry"), readState = value("readState");
    if (typeof cause !== "string" || !Object.hasOwn(facts, cause)) return undefined;
    return Object.freeze({ cause: cause as LocalSourceUnsupportedCause,
      reference: reference && typeof reference === "object" && references.has(reference) ? reference as LocalSourceDiagnosticReference : undefined,
      links: typeof links === "bigint" && links >= 0n && links <= 0xffffffffffffffffn ? links : undefined,
      entry: entry === "file" || entry === "ancestor" ? entry : undefined,
      readState: readState === "not-started" || readState === "attempted" ? readState : undefined });
  } catch { return undefined; }
}

/** Finite, bounded, pure guidance. Unknown faults/objects cannot supply prose,
 * commands, a path, exception text or a nested envelope. */
export function renderUnsupportedLocalSource(input?: LocalSourceUnsupportedObservation): string {
  const observed = normalizeUnsupportedObservation(input), fact = observed && facts[observed.cause];
  const path = observed?.reference && references.get(observed.reference);
  const file = path ? `Requested file: ${path}.` : "File path withheld: safe disclosure was not established or the reference exceeds the display limit.";
  const condition = observed?.readState === "not-started" ? "Admission checks rejected this request before reading file content; no content was delivered."
    : observed?.readState === "attempted" ? "File-content reading started, but admission rejected delivery. No content was delivered."
    : fact?.[2] === "after-read" ? "Candidate bytes were inspected for validation; no content was delivered."
    : "The reader rejected the source; no content was delivered. Whether file-content reading started is not established by this check.";
  const linkCount = observed?.cause === "ordinary-multiple-links" && observed.links !== undefined && observed.links > 1n ? `The regular file has ${observed.links} hard links. ` : "";
  const entry = observed?.entry ? ` Inspected entry: ${observed.entry === "file" ? "the source file" : "an ancestor directory"}.` : "";
  const reason = fact ? `${linkCount}${fact[1]}.${entry}` : "The exact failed admission predicate is unknown. This code alone does not establish a hard-link rejection, an OS permission failure or a restriction on every Nix-store file.";
  return `Document content withheld. ${file}\nCondition: ${condition}\nSource: Local reader ${fact ? fact[0] : "source admission"} check (LOCAL_SOURCE_UNSUPPORTED_FILE).\nReason: ${reason}\nCorrection: Ask the PPA reader maintainer to inspect the original source classification and supported reading route. Impact: none. Actor: operator. New approval: not required to ask. Prerequisite: preserve the source and original request; do not copy files, change permissions or switch readers to evade admission. Any repair needs separate authority.\nResume Action: Retry only after the owning service establishes an eligible source and supported route. Admission is checked again; a Nix-store path or read-only mode alone does not grant an exception.`;
}
