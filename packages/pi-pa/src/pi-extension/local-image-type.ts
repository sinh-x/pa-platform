/** Pure byte classifier for already-admitted local bytes. No path opens.
 * Matches Pi 0.84.4's supported image signatures and 4100-byte sniff window;
 * intentionally does not broaden formats via an image-decoder dependency.
 * Signature policy adapted from pi-coding-agent dist/utils/mime.js:
 * Copyright (c) 2025 Mario Zechner, MIT license.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export function detectAdmittedImageMimeType(bytes: Buffer): string | null {
  const b = bytes.subarray(0, 4100);
  const has = (offset: number, signature: readonly number[]) => b.length >= offset + signature.length
    && signature.every((value, index) => b[offset + index] === value);
  const ascii = (offset: number, signature: string) => has(offset, [...signature].map(c => c.charCodeAt(0)));
  if (has(0, [0xff, 0xd8, 0xff])) return b[3] === 0xf7 ? null : "image/jpeg";
  if (has(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (b.length < 16 || b.readUInt32BE(8) !== 13 || !ascii(12, "IHDR")) return null;
    for (let offset = 8; offset + 8 <= b.length;) {
      if (ascii(offset + 4, "acTL")) return null;
      if (ascii(offset + 4, "IDAT")) break;
      const next = offset + 12 + b.readUInt32BE(offset);
      if (next <= offset || next > b.length) break;
      offset = next;
    }
    return "image/png";
  }
  if (ascii(0, "GIF")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "BM") && b.length >= 26) {
    const size = b.readUInt32LE(2), pixels = b.readUInt32LE(10), header = b.readUInt32LE(14);
    if (size !== 0 && size < 26 || pixels < 14 + header || size !== 0 && pixels >= size) return null;
    const position = header === 12 ? 22 : header >= 40 && header <= 124 && b.length >= 30 ? 26 : undefined;
    if (position !== undefined && b.readUInt16LE(position) === 1 && [1, 4, 8, 16, 24, 32].includes(b.readUInt16LE(position + 2))) return "image/bmp";
  }
  return null;
}
