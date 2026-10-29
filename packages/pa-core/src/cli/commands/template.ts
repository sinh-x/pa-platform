import { templateFailure, templateService, type TemplateHost } from "../../templates/service.js";
import { MAX_TEMPLATE_REQUEST_BYTES, object, reject, strictJson, type Row } from "../../templates/schema.js";
import type { CliIo } from "../utils.js";
import { reviewBundleTemplateConsumer } from "../../workflows/producer.js";

export interface TemplateCliHost extends TemplateHost { input?: AsyncIterable<Uint8Array | string> }
export async function runTemplateCommand(argv: string[], io: Required<CliIo>, host: TemplateCliHost = {}): Promise<number> {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) {
    io.stdout("Usage: ppa template list|show|render|validate [ID --version REVISION] [--format json|markdown]\nrender: stdin {bindings}; validate: stdin {bindings,candidate}. Unsigned structural drafts only; no writes. Pi/PPA only.\nNative pa_template takes {request: RAW_JSON_DOCUMENT}; the document uses action/id/version/bindings/candidate and is capped at 65,536 UTF-8 bytes."); return 0;
  }
  let format = "json";
  try {
    const args = [...argv]; const action = args.shift();
    if (!["list", "show", "render", "validate"].includes(action ?? "")) reject("TEMPLATE_ACTION", "request", "supported action required");
    const request: Row = { action };
    if (action !== "list") { request.id = args.shift(); }
    const seen = new Set<string>();
    while (args.length) {
      const key = args.shift()!;
      if (!["--version", "--format"].includes(key) || seen.has(key) || !args.length) reject("TEMPLATE_FIELD", "request", "unknown, repeated or incomplete option");
      seen.add(key); const value = args.shift()!;
      if (key === "--version") request.version = value; else format = value;
    }
    if (!["json", "markdown"].includes(format)) reject("TEMPLATE_FIELD", "request", "supported output format required");
    if (action === "list" && Object.hasOwn(request, "version")) reject("TEMPLATE_FIELD", "request", "list takes no version");
    if (action === "render" || action === "validate") {
      const chunks: Buffer[] = []; let count = 0;
      for await (const chunk of host.input ?? process.stdin) {
        const bytes = Buffer.from(chunk); count += bytes.length;
        if (count > MAX_TEMPLATE_REQUEST_BYTES) reject("TEMPLATE_SIZE", "request", "stdin exceeds request byte limit");
        chunks.push(bytes);
      }
      const body = object(strictJson(Buffer.concat(chunks)), action === "render" ? ["bindings"] : ["bindings", "candidate"]);
      Object.assign(request, body);
    }
    const result = templateService(request, { ...host, reviewBundleConsumer: host.reviewBundleConsumer ?? reviewBundleTemplateConsumer, team: host.team ?? process.env.PA_TEAM, mode: host.mode ?? process.env.PA_MODE });
    if (format === "json") io.stdout(JSON.stringify(result));
    else {
      const { source, candidate, ...metadata } = result;
      io.stdout(`# Canonical template result (unsigned)\n\n${result.limitations as string}\n\n${JSON.stringify(metadata, null, 2)}\n\n${typeof candidate === "string" ? candidate : typeof source === "string" ? source : ""}`);
    }
    return result.ok ? 0 : 1;
  } catch (error) { io.stdout(JSON.stringify(templateFailure(error))); return 1; }
}
