import { resolve } from "node:path";
import { SourceContentSecurityError } from "./source-content-security.js";

/** Descriptor mechanics input, NOT authenticated provenance or a public grant.
 * Only a fixed-build producer that itself executes the selected Pi may bind it
 * to a guarded reader. Never accept this object from tool/config/env input. */
export interface SelectedPiDocumentBinding {
  readonly packageRoot: string;
  assertStable(): void;
}
const unsupported = (): never => { throw new SourceContentSecurityError("LOCAL_SOURCE_UNSUPPORTED_FILE"); };

/** Pure finite scope: exact README, or a descendant of docs/examples. Neither
 * the store shape nor this membership check authenticates the selected host. */
export function assertSelectedPiDocumentPath(path: string, packageRoot: string): void {
  if (typeof packageRoot !== "string" || packageRoot.length > 4096
    || !/^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/]+(?:\/[^/]+)*$/.test(packageRoot)
    || resolve(packageRoot) !== packageRoot || typeof path !== "string" || resolve(path) !== path
    || path.includes("\0") || packageRoot.includes("\0")) unsupported();
  if (path === `${packageRoot}/README.md`) return;
  for (const name of ["docs", "examples"]) {
    const prefix = `${packageRoot}/${name}/`;
    if (path.startsWith(prefix) && path.length > prefix.length) return;
  }
  unsupported();
}

/** Multi-link eligibility is text only: complete fatal UTF-8 decoding; reject
 * C0 other than HT/LF/CR, DEL/C1, and recognized image signatures even when an
 * artificial image header happens to contain only valid text bytes. No filename
 * extension or lossy replacement decoder can turn binary data into text. */
export function assertImmutableDocumentText(bytes: Uint8Array): void {
  const prefix = Buffer.from(bytes.subarray(0, 12));
  const ascii = prefix.toString("latin1");
  if (ascii.startsWith("GIF") || ascii.startsWith("BM")
    || ascii.startsWith("\x89PNG\r\n\x1a\n") || prefix[0] === 0xff && prefix[1] === 0xd8
    || ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") unsupported();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return unsupported(); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text)) unsupported();
}
