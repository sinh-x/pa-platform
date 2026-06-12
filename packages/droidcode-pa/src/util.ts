export const STDERR_TAIL_BYTES = 2000;

export function tailString(text: string, max: number): string {
  if (!text) return "";
  return text.length <= max ? text : text.slice(text.length - max);
}

export function firstLine(text: string): string {
  if (!text) return "";
  return text.split("\n", 1)[0] ?? "";
}
