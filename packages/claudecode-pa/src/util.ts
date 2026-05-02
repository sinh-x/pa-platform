export const STDERR_TAIL_BYTES = 2000;

// Truncates from the end by UTF-16 code units, not Unicode codepoints. Acceptable
// for diagnostic logs — same approximation opa uses for stderr tails.
export function tailString(text: string, max: number): string {
  if (!text) return "";
  return text.length <= max ? text : text.slice(text.length - max);
}

export function firstLine(text: string): string {
  if (!text) return "";
  return text.split("\n", 1)[0] ?? "";
}
