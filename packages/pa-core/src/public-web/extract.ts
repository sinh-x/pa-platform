import { publicWebRuntime, type PublicWebRuntime } from "./runtime.js";
import { runWebProcess } from "./process.js";
import { PublicWebError, WEB_LIMITS } from "./types.js";

/** Fixed packaged HTMLParser, never page-supplied code. Inert JSON text only. */
export async function extractPublicText(source: string, mime: string, signal: AbortSignal = new AbortController().signal, runtime: PublicWebRuntime = publicWebRuntime()): Promise<{ text: string; title?: string }> {
  if (Buffer.byteLength(source) > WEB_LIMITS.bodyBytes) throw new PublicWebError("WEB_LIMIT");
  if (mime !== "text/html" && mime !== "text/plain") throw new PublicWebError("WEB_UNSUPPORTED");
  const result = await runWebProcess(runtime.python, ["-I", "-B", runtime.script, mime], signal,
    { input: Buffer.from(source), outputBytes: WEB_LIMITS.bodyBytes * 4 });
  if (result.status !== 0) throw new PublicWebError(result.status === 2 ? "WEB_UNSUPPORTED" : result.status === 3 ? "WEB_LIMIT" : "WEB_NETWORK");
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
    if (!value || typeof value.text !== "string" || !value.text || (value.title !== undefined && (typeof value.title !== "string" || Array.from(value.title).length > 256)) || Object.keys(value).some(key => key !== "text" && key !== "title")) throw new Error();
    return value;
  } catch { throw new PublicWebError("WEB_UNSUPPORTED"); }
}
