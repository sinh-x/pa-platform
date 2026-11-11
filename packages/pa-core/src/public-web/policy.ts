import { isIP } from "node:net";
import { assertNoSensitiveMatch, type SensitivePatternSet } from "../sensitive-patterns.js";
import { PublicWebError, WEB_LIMITS } from "./types.js";

function ipv4Number(address: string): number { return address.split(".").reduce((n, part) => n * 256 + Number(part), 0); }
function v4Range(address: number, base: string, prefix: number): boolean { const size = 2 ** (32 - prefix); return Math.floor(address / size) === Math.floor(ipv4Number(base) / size); }
function ipv6Number(address: string): bigint {
  const halves = address.split("::"), left = halves[0] ? halves[0].split(":") : [], right = halves[1] ? halves[1].split(":") : [];
  const parts = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return parts.reduce((value, part) => (value << 16n) + BigInt(`0x${part}`), 0n);
}
function v6Range(address: bigint, base: string, prefix: number): boolean { const bits = BigInt(128 - prefix); return address >> bits === ipv6Number(base) >> bits; }
/** Conservative globally routable unicast only; mapped/transition/special-use IPv6 is rejected. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const n = ipv4Number(address);
    const denied: Array<[string, number]> = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.175.48.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]];
    return !denied.some(([base, prefix]) => v4Range(n, base, prefix));
  }
  if (isIP(address) !== 6 || address.includes("%") || address.includes(".")) return false;
  const n = ipv6Number(address);
  return v6Range(n, "2000::", 3) && !([["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["2620:4f:8000::", 48], ["3fff::", 20]] as Array<[string, number]>).some(([base, prefix]) => v6Range(n, base, prefix));
}
export function normalizedAddress(address: string): string {
  if (isIP(address) === 6 && address.toLowerCase().startsWith("::ffff:") && isIP(address.slice(7)) === 4) return address.slice(7);
  if (isIP(address) === 6) return ipv6Number(address).toString(16);
  return address;
}
export function publicHostname(url: URL): string { return url.hostname.replace(/^\[|\]$/g, ""); }
export function checkSensitive(value: string, patterns: SensitivePatternSet): void {
  try { assertNoSensitiveMatch("content", value, patterns); } catch { throw new PublicWebError("WEB_SENSITIVE"); }
}
export function validatePublicUrl(input: string, patterns: SensitivePatternSet): URL {
  if (typeof input !== "string" || !input || Buffer.byteLength(input, "utf8") > WEB_LIMITS.urlBytes) throw new PublicWebError("WEB_INPUT");
  // WHATWG normalizes unusual IP spellings, backslashes and whitespace. Check raw
  // authority first so normalization cannot turn an unsafe/ambiguous input into a grant.
  if (!/^https:\/\//i.test(input) || /[\s\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(input)) throw new PublicWebError("WEB_INPUT");
  let url: URL;
  try { url = new URL(input); } catch { throw new PublicWebError("WEB_INPUT"); }
  if (Buffer.byteLength(url.href, "utf8") > WEB_LIMITS.urlBytes) throw new PublicWebError("WEB_INPUT");
  const authority = input.slice(8).split(/[/?#]/, 1)[0];
  if (url.protocol !== "https:" || url.username || url.password || url.port || input.includes("#") || authority.includes("@")) throw new PublicWebError("WEB_INPUT");
  const rawHost = authority.replace(/:443$/, "").toLowerCase();
  if (rawHost !== url.hostname.toLowerCase()) throw new PublicWebError("WEB_INPUT");
  const host = publicHostname(url);
  if (isIP(host)) { if (!isPublicAddress(host)) throw new PublicWebError("WEB_TARGET"); }
  else if (host.length > 253 || !host.includes(".") || host.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) || /\.(?:localhost|local|localdomain|internal|intranet|home|lan|arpa|onion|test|invalid|example)$/i.test(host)) throw new PublicWebError("WEB_TARGET");
  let decoded = input;
  for (let i = 0; i < 4; i++) {
    checkSensitive(decoded, patterns);
    try { assertNoSensitiveMatch("path", decoded, patterns); assertNoSensitiveMatch("filename", new URL(decoded).pathname.split("/").at(-1) ?? "", patterns); }
    catch { throw new PublicWebError("WEB_SENSITIVE"); }
    if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(decoded)) throw new PublicWebError("WEB_INPUT");
    // Credentials in URLs are forbidden even when too short for native secret regexes.
    if (/(?:[?&;/]|\b)(?:password|passwd|pwd|token|access[_-]?token|auth(?:orization)?|api[_-]?key|secret|signature|sig|credential|session(?:id)?|key)\s*=/i.test(decoded)) throw new PublicWebError("WEB_SENSITIVE");
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { throw new PublicWebError("WEB_INPUT"); }
    if (next === decoded) return url;
    decoded = next;
  }
  throw new PublicWebError("WEB_INPUT"); // reject excessive encoding rather than inspecting a partial decode
}
