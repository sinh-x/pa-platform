import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { interactionCatalogue, validateInteractionCatalogue, type CatalogueEntry } from "./catalogue.js";
import {
  INTERACTIONS_VERSION, MAX_INTERACTION_PAGE_BYTES, MAX_INTERACTION_PAGE_LINES,
  SOURCE_ONLY_AVAILABILITY, parseCapabilityRequest, type CapabilityRequest, type InteractionAvailability,
} from "./contract.js";

export type InteractionDiscoveryCode = "INTERACTION_CURSOR" | "INTERACTION_NOT_FOUND" | "INTERACTION_OUTPUT_LIMIT" | "INTERACTION_CATALOGUE";
const guidance: Record<InteractionDiscoveryCode, { reason: string; correction: string; resume: string }> = {
  INTERACTION_CURSOR: {
    reason: "The continuation does not belong to this reader and unchanged query, or its integrity could not be established.",
    correction: "Restart the read-only listing without a cursor. Impact: read-only. Actor: agent. New approval: not required. Prerequisite: preserve the query and do not treat partial earlier pages as a complete view.",
    resume: "Use only the returned continuation with the same reader, filters and page limit. No effect is requested.",
  },
  INTERACTION_NOT_FOUND: {
    reason: "The operation is not present in this source inventory; this says nothing about installed support or permission.",
    correction: "List source operations to find the supported identifier. Impact: read-only. Actor: agent. New approval: not required. Prerequisite: use this same source reader, not a guessed execution interface.",
    resume: "Repeat the read-only description with an identifier returned by the listing.",
  },
  INTERACTION_OUTPUT_LIMIT: {
    reason: "One complete descriptor cannot fit within the output bound. It has not been silently truncated.",
    correction: "Ask the interaction runtime maintainer to inspect descriptor size. Impact: none. Actor: agent. New approval: not required to ask. Prerequisite: preserve the source version; any repair needs its own authority.",
    resume: "Repeat source discovery after the owner provides bounded complete descriptors; do not infer completion from missing data.",
  },
  INTERACTION_CATALOGUE: {
    reason: "The source inventory failed its structural or high-risk classification checks; it cannot be presented as valid coverage.",
    correction: "Ask the interaction runtime maintainer to reconcile the source inventory. Impact: none. Actor: agent. New approval: not required to ask. Prerequisite: preserve existing source evidence; any repair needs its own authority.",
    resume: "Construct a new source reader only after the inventory checks pass. This does not install or authorize a tool.",
  },
};
export class InteractionDiscoveryError extends Error {
  constructor(readonly code: InteractionDiscoveryCode) {
    const detail = guidance[code];
    super([
      "Source capability discovery could not complete.",
      "Condition: A complete source capability result is unavailable.",
      "Source: Interaction source-catalogue reader.",
      `Reason: ${detail.reason}`,
      `Correction: ${detail.correction}`,
      `Resume Action: ${detail.resume}`,
    ].join("\n"));
    this.name = "InteractionDiscoveryError";
  }
}
interface SourceView {
  schemaVersion: typeof INTERACTIONS_VERSION;
  scope: "source-only";
  viewVersion: string;
  availability: InteractionAvailability;
}
export type SourceCapabilityResult = SourceView & (
  | { action: "describe"; operation: CatalogueEntry }
  | { action: "list"; operations: readonly CatalogueEntry[]; page: { offset: number; total: number; complete: boolean; nextCursor: string | null } }
);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
function fits(value: string): boolean { return Buffer.byteLength(value, "utf8") <= MAX_INTERACTION_PAGE_BYTES && value.split("\n").length <= MAX_INTERACTION_PAGE_LINES; }
function bounded(result: SourceCapabilityResult): string {
  const raw = JSON.stringify(result);
  if (!fits(raw)) throw new InteractionDiscoveryError("INTERACTION_OUTPUT_LIMIT");
  return raw;
}

/** Source metadata only, with an immutable per-reader view. No filesystem, CLI,
 * registry, role or admission probes; no effects. The optional catalogue is a
 * trusted construction/test seam, NEVER a field accepted from a tool request.
 * Cursors are integrity tokens for pagination only, not transferable authority.
 * A new reader invalidates old cursors even when source bytes are unchanged. */
export function createSourceCatalogueReader(catalogue: readonly CatalogueEntry[] = interactionCatalogue): (raw: string | Uint8Array) => string {
  const rows = (JSON.parse(JSON.stringify(catalogue)) as CatalogueEntry[])
    .sort((a, b) => a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0);
  if (validateInteractionCatalogue(rows).length) throw new InteractionDiscoveryError("INTERACTION_CATALOGUE");
  const viewVersion = hash(JSON.stringify(rows));
  const view: SourceView = { schemaVersion: INTERACTIONS_VERSION, scope: "source-only", viewVersion, availability: SOURCE_ONLY_AVAILABILITY };
  const cursorKey = randomBytes(32);
  const sign = (bytes: Uint8Array): Buffer => createHmac("sha256", cursorKey).update(bytes).digest();
  const issueCursor = (offset: number, query: string): string => {
    const bytes = Buffer.from(JSON.stringify({ offset, query, viewVersion }), "utf8");
    return Buffer.concat([bytes, sign(bytes)]).toString("base64url");
  };
  const cursorOffset = (cursor: string, query: string, total: number): number => {
    try {
      const decoded = Buffer.from(cursor, "base64url");
      if (decoded.toString("base64url") !== cursor || decoded.length <= 32) throw new Error();
      const bytes = decoded.subarray(0, -32);
      if (!timingSafeEqual(decoded.subarray(-32), sign(bytes))) throw new Error();
      // Only this reader can sign these exact generated bytes. Raw caller JSON
      // still passes through the duplicate-key/Unicode/bounds parser separately.
      const payload = JSON.parse(bytes.toString("utf8")) as { offset: number; query: string; viewVersion: string };
      if (payload.query !== query || payload.viewVersion !== viewVersion || !Number.isSafeInteger(payload.offset) || payload.offset <= 0 || payload.offset >= total) throw new Error();
      return payload.offset;
    } catch { throw new InteractionDiscoveryError("INTERACTION_CURSOR"); }
  };
  return raw => {
    const request = parseCapabilityRequest(raw);
    if (request.action === "describe") {
      const operation = rows.find(row => row.operationId === request.operationId);
      if (!operation) throw new InteractionDiscoveryError("INTERACTION_NOT_FOUND");
      return bounded({ ...view, action: "describe", operation });
    }
    const selected = rows.filter(row => (!request.family || row.family === request.family) && (!request.effect || row.effectClass === request.effect));
    const query = queryIdentity(request);
    const offset = request.cursor ? cursorOffset(request.cursor, query, selected.length) : 0;
    const operations: CatalogueEntry[] = [];
    const page = (): SourceCapabilityResult => {
      const end = offset + operations.length;
      const complete = end === selected.length;
      return { ...view, action: "list", operations, page: { offset, total: selected.length, complete, nextCursor: complete ? null : issueCursor(end, query) } };
    };
    for (const row of selected.slice(offset, offset + request.limit)) {
      operations.push(row);
      if (!fits(JSON.stringify(page()))) { operations.pop(); break; }
    }
    if (operations.length === 0 && selected.length > offset) throw new InteractionDiscoveryError("INTERACTION_OUTPUT_LIMIT");
    return bounded(page());
  };
}
function queryIdentity(request: Extract<CapabilityRequest, { action: "list" }>): string {
  return hash(JSON.stringify({ family: request.family ?? null, effect: request.effect ?? null, limit: request.limit }));
}
