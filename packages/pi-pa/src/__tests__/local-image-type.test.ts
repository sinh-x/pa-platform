import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import { detectAdmittedImageMimeType } from "../pi-extension/local-image-type.js";

// Known ordinary single-link fixture bytes only; no denied source is reopened.
test("admitted-byte MIME signatures match the existing Pi classifier without widening formats", async () => {
  const root = mkdtempSync(join(tmpdir(), "local-image-type-"));
  try {
    const png = Buffer.alloc(64); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(13, 8); png.write("IHDR", 12); png.writeUInt32BE(0, 33); png.write("IDAT", 37);
    const animated = Buffer.from(png); animated.write("acTL", 37);
    const bmp = Buffer.alloc(64); bmp.write("BM"); bmp.writeUInt32LE(64, 2); bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
    const cases = [Buffer.alloc(0), Buffer.from("plain λ text"), Buffer.from([255, 216, 255, 224]),
      Buffer.from([255, 216, 255, 247]), png, animated, Buffer.from("GIF89a"), Buffer.from("RIFFxxxxWEBP"), bmp,
      Buffer.from("unsupported AVIF/TIFF/PDF text")];
    // Truncated signatures and structured malformed headers must also stay safe.
    for (const input of [png, bmp]) for (let n = 0; n < input.length; n++) cases.push(input.subarray(0, n));
    for (const [index, bytes] of cases.entries()) {
      const path = join(root, `fixture-${index}.bin`); writeFileSync(path, bytes);
      assert.equal(detectAdmittedImageMimeType(bytes), await detectSupportedImageMimeTypeFromFile(path), `fixture ${index}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
