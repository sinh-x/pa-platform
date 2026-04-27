// Storage is UTC ISO 8601 with a Z suffix; display is host-local time with an explicit offset.

export function nowUtc(date = new Date()): string {
  return date.toISOString();
}

export function parseTimestamp(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`invalid timestamp: ${value}`);
  return date;
}

export function formatLocal(value: string): string {
  return formatLocalDate(parseTimestamp(value));
}

export function formatLocalShort(value: string): string {
  return formatLocalDate(parseTimestamp(value));
}

/** @deprecated Use nowUtc() for storage and formatLocal()/formatLocalShort() for display. */
export const localISOTimestamp = nowUtc;

function formatLocalDate(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(absOffset / 60))}:${pad2(absOffset % 60)}`;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${offset}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
