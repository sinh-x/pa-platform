import { inspectRepositoryMutationLease, quarantineRepositoryMutationLease, formatRepositoryAdmissionDiagnostic } from "../../deploy/index.js";
import { resolveRepoExecutionPath } from "../../repos.js";
import type { CliIo } from "../utils.js";

interface RepositoryArgs {
  repo?: string;
  expectedEvidence?: string;
}

export function runRepositoryCommand(argv: string[], io: Required<CliIo>): number {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h" || action === "help") {
    printRepositoryHelp(io);
    return 0;
  }
  if (action !== "inspect" && action !== "quarantine") {
    io.stderr(`Unknown repository command: ${action}`);
    printRepositoryHelp(io);
    return 1;
  }
  const parsed = parseRepositoryArgs(rest);
  if ("error" in parsed) {
    io.stderr(parsed.error);
    return 1;
  }
  let repository: ReturnType<typeof resolveRepoExecutionPath>;
  try {
    repository = resolveRepoExecutionPath(parsed.args.repo);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (action === "inspect") {
    const inspection = inspectRepositoryMutationLease(repository.repoRoot);
    io.stdout(formatRepositoryAdmissionDiagnostic({ canonicalRepoKey: repository.repoKey, canonicalRepoRoot: repository.repoRoot, inspection }));
    return 0;
  }
  if (!parsed.args.expectedEvidence) {
    io.stderr("--expected-evidence is required for repository quarantine; run repository inspect first");
    return 1;
  }
  const result = quarantineRepositoryMutationLease({
    canonicalRepoKey: repository.repoKey,
    canonicalRepoRoot: repository.repoRoot,
    expectedEvidenceIdentity: parsed.args.expectedEvidence,
  });
  if (result.status === "rejected") {
    io.stderr(result.diagnostic);
    return 1;
  }
  io.stdout(result.diagnostic);
  return 0;
}

function parseRepositoryArgs(argv: string[]): { args: RepositoryArgs } | { error: string } {
  const args: RepositoryArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--repo" && flag !== "--expected-evidence") return { error: `Unsupported repository option: ${flag}` };
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) return { error: `${flag} requires a value` };
    if (flag === "--repo") args.repo = value;
    else args.expectedEvidence = value;
    index += 1;
  }
  if (args.expectedEvidence && !/^v1-[a-f0-9]{64}$/.test(args.expectedEvidence)) return { error: "--expected-evidence must be a v1 SHA-256 evidence identity" };
  return { args };
}

function printRepositoryHelp(io: Required<CliIo>): void {
  io.stdout("Usage: repository <inspect|quarantine> [options]");
  io.stdout("");
  io.stdout("Safely inspect or quarantine repository builder ownership evidence.");
  io.stdout("  inspect --repo <key|path>");
  io.stdout("  quarantine --repo <key|path> --expected-evidence <v1-sha256>");
}
