import { renderArtifact } from "../../artifacts/render.js";
import {
  ArtifactPolicyError, artifactDiagnostic, assertArtifactAbsolutePath,
  assertArtifactEnvironment, assertManagedReviewAvailable, parseArtifactFeedbackTimeout,
} from "../../artifacts/policy.js";
import type { CliIo } from "../utils.js";

const HELP = [
  "Usage: artifact render --source /absolute/document.md --output-dir /absolute/new-companion --json",
  "       artifact review start --manifest /absolute/new-companion/manifest.json --json",
  "       artifact review status --session SESSION_ID --json",
  "       artifact review stop --session SESSION_ID --json",
  "       artifact review feedback --session SESSION_ID --output /absolute/new-feedback.json [--timeout-ms 1000] --json",
  "Render: no browser or selected Lavish required; existing output safety restrictions apply.",
  "Review: requires selected managed Lavish; lifecycle is unavailable in this phase even when selected.",
  "No automatic browser opening, package setup, sharing, host options or argument pass-through.",
].join("\n");

/** Deliberately not parseFlagPairs: duplicates, positional operands, implicit
 * booleans, unknown flags and --key=value are all rejected identically. */
function options(argv: string[], required: string[], optional: string[] = []): Map<string, string> {
  const allowed = new Set([...required, ...optional, "--json"]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (!allowed.has(key) || values.has(key)) throw artifactDiagnostic("ARTIFACT_USAGE_INVALID");
    if (key === "--json") { values.set(key, "true"); continue; }
    const value = argv[++index];
    if (!value || value.startsWith("-")) throw artifactDiagnostic("ARTIFACT_USAGE_INVALID");
    values.set(key, value);
  }
  if ([...required, "--json"].some((key) => !values.has(key))) throw artifactDiagnostic("ARTIFACT_USAGE_INVALID");
  return values;
}

export function runArtifactCommand(argv: string[], io: Required<CliIo>): number {
  try {
    // Metadata-only help is side-effect-free; no filesystem or runtime probe.
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help")
        || argv.length === 2 && argv[0] === "render" && argv[1] === "--help"
        || argv.length === 2 && argv[0] === "review" && argv[1] === "--help"
        || argv.length === 3 && argv[0] === "review" && ["start", "status", "stop", "feedback"].includes(argv[1]!) && argv[2] === "--help") {
      io.stdout(HELP);
      return 0;
    }
    assertArtifactEnvironment(process.env);
    if (argv[0] === "render") {
      const parsed = options(argv.slice(1), ["--source", "--output-dir"]);
      const payload = renderArtifact(parsed.get("--source")!, parsed.get("--output-dir")!);
      io.stdout(JSON.stringify({ schema: "pa-artifact/v1", operation: "render", status: "rendered", payload }));
      return 0;
    }
    if (argv[0] !== "review") throw artifactDiagnostic("ARTIFACT_USAGE_INVALID");
    const operation = argv[1];
    if (operation === "start") {
      const parsed = options(argv.slice(2), ["--manifest"]);
      assertArtifactAbsolutePath(parsed.get("--manifest")!);
      // Phase 2 does not probe or spawn a runtime. Even selected managed paths
      // cannot imply a qualified lifecycle. Phase 3 replaces this deny gate.
      return assertManagedReviewAvailable(false, process.env);
    }
    if (operation === "status" || operation === "stop" || operation === "feedback") {
      const parsed = operation === "feedback"
        ? options(argv.slice(2), ["--session", "--output"], ["--timeout-ms"])
        : options(argv.slice(2), ["--session"]);
      // Treat session as opaque, never a file path or PID. Provisional grammar
      // only rejects control/path injection; it claims no owned-session support.
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(parsed.get("--session")!)) throw artifactDiagnostic("ARTIFACT_USAGE_INVALID");
      if (operation === "feedback") {
        assertArtifactAbsolutePath(parsed.get("--output")!);
        parseArtifactFeedbackTimeout(parsed.get("--timeout-ms"));
      }
      throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
    }
    throw artifactDiagnostic("ARTIFACT_USAGE_INVALID");
  } catch (error) {
    const diagnostic = error instanceof ArtifactPolicyError ? error : artifactDiagnostic("ARTIFACT_RUNTIME_FAILED");
    io.stderr(diagnostic.message);
    return diagnostic.exitCode;
  }
}
