export const MAX_TOOL_BYTES = 50 * 1024;
export const MAX_TOOL_LINES = 2000;

export function boundJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  const lines = json.split("\n");
  if (Buffer.byteLength(json, "utf8") <= MAX_TOOL_BYTES && lines.length <= MAX_TOOL_LINES) return json;
  const candidate = lines.slice(0, MAX_TOOL_LINES).join("\n");
  const notice = "Inspect the PA registry, ticket, or deployment artifact for the complete result.";
  let low = 0;
  let high = candidate.length;
  let result = JSON.stringify({ truncated: true, preview: "", notice });
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const end = middle > 0 && isHighSurrogate(candidate.charCodeAt(middle - 1)) ? middle - 1 : middle;
    const encoded = JSON.stringify({ truncated: true, preview: candidate.slice(0, end), notice });
    if (Buffer.byteLength(encoded, "utf8") <= MAX_TOOL_BYTES) {
      result = encoded;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function isHighSurrogate(value: number): boolean { return value >= 0xd800 && value <= 0xdbff; }
