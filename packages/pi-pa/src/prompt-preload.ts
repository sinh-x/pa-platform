// Fixed non-selected Node CLI bridge. This runs after the foreground exec gate,
// or in the already-owned managed child, before Pi's unchanged CLI parser.
import { consumePiPromptArgs, piPromptDiagnostic } from "./prompt-transport.js";

try {
  process.argv = consumePiPromptArgs(process.argv, process.env.PA_DEPLOYMENT_DIR);
  // Do not install this launch-only bridge into subsequent child tools.
  const option = `--import=${import.meta.url}`;
  const options = process.env.NODE_OPTIONS;
  const remaining = options?.endsWith(option) ? options.slice(0, -option.length).trimEnd() : options;
  if (remaining) process.env.NODE_OPTIONS = remaining; else delete process.env.NODE_OPTIONS;
} catch {
  process.stderr.write(`${piPromptDiagnostic()}\n`);
  process.exit(1);
}
