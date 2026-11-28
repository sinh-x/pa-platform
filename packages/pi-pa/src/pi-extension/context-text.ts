// Literal reader text, never terminal markup. Limits are UTF-16 code units.
export const CONTEXT_FIELD_LIMIT = 16_384;
export const CONTEXT_VIEW_LIMIT = 131_072;
export function contextText(value: string, limit = CONTEXT_FIELD_LIMIT): string {
  const truncated = value.length > limit;
  let text = value.slice(0, limit).replace(/\r\n?/g, "\n").replace(/\t/g, "    ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?");
  if (truncated) text += "\n[truncated]";
  return text;
}
