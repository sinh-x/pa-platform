import { stripVTControlCharacters } from "node:util";

/** Derived from spawn/resume intent and the adapter's successful version probe. */
export interface PiStartupContext { fresh: boolean; version: string }
export const PI_STARTUP_MAX_BYTES = 4096;

/** Presentation only. Callers retain raw input in their existing diagnostic sinks.
 * One gate per transport; pipe stdout events close the stderr gate as well.
 */
export class PiStartupPresentation {
  private pending = Buffer.alloc(0);
  private open: boolean;
  private readonly expected: string;

  constructor(id: string, context?: PiStartupContext) {
    this.open = context?.fresh === true && /^(?:v)?1\.0\.4$/.test(context.version.trim())
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
    this.expected = `Warning: No project session found with id '${id}'; creating a new session with that id.`;
  }

  get bufferedBytes(): number { return this.pending.length; }

  push(chunk: Buffer): Buffer {
    if (!this.open) return chunk;
    const newline = chunk.indexOf(10);
    const prefixLength = newline < 0 ? chunk.length : newline + 1;
    // Close at the byte cap, without ever retaining a larger comparison buffer.
    if (this.pending.length + prefixLength >= PI_STARTUP_MAX_BYTES) {
      return Buffer.concat([this.close(), chunk]);
    }
    if (newline < 0) {
      this.pending = Buffer.concat([this.pending, chunk]);
      return Buffer.alloc(0);
    }
    const line = Buffer.concat([this.pending, chunk.subarray(0, prefixLength)]);
    this.pending = Buffer.alloc(0);
    this.open = false;
    const comparison = stripVTControlCharacters(line.toString("utf8")).replace(/\r?\n$/, "");
    return comparison === this.expected ? chunk.subarray(prefixLength) : Buffer.concat([line, chunk.subarray(prefixLength)]);
  }

  /** EOF, the first protocol event, or another stream's output ends startup. */
  close(): Buffer {
    this.open = false;
    const pending = this.pending;
    this.pending = Buffer.alloc(0);
    return pending;
  }
}

/** Optional for old runner configs: absent context always passes output through. */
export function validPiStartupContext(value: unknown): value is PiStartupContext | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Partial<PiStartupContext>;
  return Object.keys(context).sort().join(",") === "fresh,version" && typeof context.fresh === "boolean"
    && typeof context.version === "string" && context.version.length <= 128;
}
