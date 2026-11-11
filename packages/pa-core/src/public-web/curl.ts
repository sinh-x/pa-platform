import { isIP } from "node:net";
import { publicHostname, isPublicAddress, validatePublicUrl } from "./policy.js";
import { loadSensitivePatterns } from "../sensitive-patterns.js";
import { decodePublicBody } from "./transport.js";
import { publicWebRuntime, type PublicWebRuntime } from "./runtime.js";
import { runWebProcess } from "./process.js";
import { PublicWebError, WEB_LIMITS, type PublicWebResponse } from "./types.js";

/** One request, no curl redirect/retry/DNS/proxy/config expansion. The reader
 * validates ALL DNS answers; --resolve pins this hop at libcurl's connection
 * boundary while preserving the original hostname and normal certificate checks.
 */
export function publicCurlArguments(url: URL, address: string, ca: string): string[] {
  const host = publicHostname(url), literal = isIP(host);
  if (url.protocol !== "https:" || url.port || url.username || url.password || !isPublicAddress(address) || (literal && host !== address)) throw new PublicWebError("WEB_TARGET");
  return ["-q", "--silent", "--show-error", "--globoff", "--no-location", "--max-redirs", "0",
    "--proto", "=https", "--proto-redir", "=https", "--proxy", "", "--noproxy", "*", "--no-netrc",
    "--http1.1", "--tlsv1.2", "--cacert", ca, "--connect-timeout", "10", "--max-time", String(WEB_LIMITS.requestMs / 1000),
    "--max-filesize", String(WEB_LIMITS.bodyBytes), "--request", "GET", "--header", "Accept: text/html, text/plain",
    "--header", "Accept-Encoding: identity", "--header", "Connection: close", "--user-agent", "PA-PublicReader/1",
    ...(isIP(address) === 6 ? ["--ipv6"] : ["--ipv4"]),
    ...(!literal ? ["--resolve", `${host}:443:${isIP(address) === 6 ? `[${address}]` : address}`] : []),
    "--include", "--output", "-", "--url", url.href];
}

export function parseCurlHeaders(bytes: Buffer): { status: number; headers: Record<string, string | undefined> } {
  if (bytes.length > 16 * 1024) throw new PublicWebError("WEB_LIMIT");
  const blocks = bytes.toString("latin1").split("\r\n\r\n");
  if (blocks.pop() !== "" || !blocks.length) throw new PublicWebError("WEB_NETWORK");
  let final: ReturnType<typeof parseCurlHeaders> | undefined;
  for (const block of blocks) {
    const lines = block.split("\r\n"), status = /^HTTP\/1\.[01] ([1-5]\d\d)(?: [^\r\n]*)?$/.exec(lines.shift() ?? "");
    if (!status || final) throw new PublicWebError("WEB_NETWORK");
    const headers: Record<string, string | undefined> = {};
    for (const line of lines) {
      const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[\t ]*([^\x00-\x08\x0a-\x1f\x7f]*)$/.exec(line);
      if (!match) throw new PublicWebError("WEB_UNSUPPORTED");
      const name = match[1].toLowerCase();
      if (["location", "content-type", "content-encoding", "content-length"].includes(name)) {
        if (headers[name] !== undefined) throw new PublicWebError("WEB_UNSUPPORTED");
        headers[name] = match[2].trim();
      }
    }
    if (Number(status[1]) >= 200) final = { status: Number(status[1]), headers };
  }
  if (!final) throw new PublicWebError("WEB_NETWORK");
  return final;
}

export async function fetchCurlPublicHop(url: URL, address: string, signal: AbortSignal, runtime: PublicWebRuntime = publicWebRuntime()): Promise<PublicWebResponse> {
  // Defence at the actual process boundary, not merely model tool validation.
  validatePublicUrl(url.href, loadSensitivePatterns());
  const result = await runWebProcess(runtime.curl, publicCurlArguments(url, address, runtime.ca), signal,
    { outputBytes: WEB_LIMITS.bodyBytes + 16 * 1024 });
  if (result.status !== 0) throw new PublicWebError(result.status === 63 ? "WEB_LIMIT" : result.status === 28 ? "WEB_TIMEOUT" : "WEB_NETWORK");
  // --include writes headers and the still-compressed body to the owned stdout.
  // Avoid reopening /dev/fd: Node subprocess pipes may be socket pairs on Linux.
  let offset = 0;
  for (;;) {
    const begin = offset, end = result.stdout.indexOf("\r\n\r\n", begin);
    if (end < 0) throw new PublicWebError("WEB_NETWORK");
    offset = end + 4;
    if (offset > 16 * 1024) throw new PublicWebError("WEB_LIMIT");
    if (!/^HTTP\/1\.[01] 1\d\d(?: |\r)/.test(result.stdout.subarray(begin, end).toString("latin1"))) break;
  }
  const { status, headers } = parseCurlHeaders(result.stdout.subarray(0, offset));
  const body = result.stdout.subarray(offset);
  if (body.length > WEB_LIMITS.bodyBytes) throw new PublicWebError("WEB_LIMIT");
  // Error/redirect bodies may be downloaded under the same finite bound, but are
  // never decompressed/interpreted/returned as page evidence. No curl -L.
  if (status !== 200) return { status, headers, body: Buffer.alloc(0), compressedBytes: 0 };
  if (headers["content-length"] && (!/^\d+$/.test(headers["content-length"]) || Number(headers["content-length"]) > WEB_LIMITS.bodyBytes)) throw new PublicWebError("WEB_LIMIT");
  return { status, headers, body: await decodePublicBody(body, headers["content-encoding"]?.toLowerCase().trim() ?? "identity", signal), compressedBytes: body.length };
}
