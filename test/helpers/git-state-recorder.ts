import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GitStateRecorder {
  binDir: string;
  readCommands(): string[][];
  readOperations(): string[][];
}

interface PlanWithRepositoryAdmission {
  environment: Readonly<Record<string, string | undefined>>;
  repositoryAdmission: {
    readonly access: "read-only" | "exclusive-builder" | "non-locking";
    readonly launchMode: "foreground" | "background" | "dry-run";
    readonly ownershipIntent: "none" | "preview" | "acquire-before-spawn";
    readonly force: boolean;
    readonly gitSnapshot?: unknown;
  };
}

function assertNoInternalLeaseFields(plan: PlanWithRepositoryAdmission, primer?: string): void {
  const internalLeasePrefix = ["PA", "REPOSITORY", "LEASE"].join("_");
  if (Object.keys(plan.environment).some((key) => key.startsWith(internalLeasePrefix))) {
    throw new Error("Unexpected internal repository lease environment");
  }
  if (primer?.includes(internalLeasePrefix)) throw new Error("Unexpected internal repository lease primer field");
}

export function assertNonLockingRepositoryAdmission(plan: PlanWithRepositoryAdmission, primer?: string): void {
  if (plan.repositoryAdmission.access !== "non-locking" || plan.repositoryAdmission.ownershipIntent !== "none" || plan.repositoryAdmission.gitSnapshot !== undefined) {
    throw new Error("Expected explicit non-locking repository admission without ownership or Git status evidence");
  }
  assertNoInternalLeaseFields(plan, primer);
}

export function assertBuilderExclusiveRepositoryAdmission(plan: PlanWithRepositoryAdmission, primer?: string): void {
  if (plan.repositoryAdmission.access !== "exclusive-builder" || plan.repositoryAdmission.ownershipIntent !== "acquire-before-spawn" || plan.repositoryAdmission.gitSnapshot === undefined) {
    throw new Error("Expected builder-exclusive repository admission with pre-spawn Git evidence");
  }
  assertNoInternalLeaseFields(plan, primer);
}

/** Records Git commands that can mutate checkout, branch, or worktree state. */
export function installGitStateRecorder(root: string): GitStateRecorder {
  const executable = (name: "git" | "bash" | "flock") => execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
  const realGit = executable("git"), bash = executable("bash"), flock = executable("flock");
  const word = (value: string) => `$'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/[\u0001-\u001f]/g, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`)}'`;
  const escapes = [["\\", "\\\\"], ['"', '\\"'], ...Array.from({ length: 31 }, (_, index) => [String.fromCharCode(index + 1), `\\u${(index + 1).toString(16).padStart(4, "0")}`])];
  const binDir = join(root, "git-state-recorder-bin");
  const commandLogPath = join(root, "git-state-commands.jsonl");
  const logPath = join(root, "git-state-operations.jsonl");
  const wrapperPath = join(binDir, "git");
  mkdirSync(binDir, { recursive: true });
  // Keep complete JSON argv and real Git execution, without starting a Node VM
  // for every probe. Hundreds of probes before an async yield otherwise make
  // contention fixtures miss their deadlines on a loaded host. The shared fd
  // lock also prevents long concurrent command records from interleaving.
  writeFileSync(wrapperPath, `#!${bash}
record='['
separator=''
for value in "$@"; do
${escapes.map(([from, to]) => `  value=\${value//${word(from!)}/${word(to!)}}`).join("\n")}
  record+="$separator\\\"$value\\\""
  separator=','
done
record+=']'
mutating=false
case "\${1-}" in
  stash|commit|checkout|reset|clean|restore|worktree) mutating=true ;;
  branch)
    for argument in "\${@:2}"; do
      case "$argument" in -d|-D|--delete) mutating=true ;; esac
    done ;;
esac
{
  ${word(flock)} --exclusive 9 || exit 127
  printf '%s\\n' "$record" >&9 || exit 127
  if "$mutating"; then printf '%s\\n' "$record" >> ${word(logPath)} || exit 127; fi
} 9>> ${word(commandLogPath)}
exec ${word(realGit)} "$@"
`, "utf8");
  chmodSync(wrapperPath, 0o755);
  const readLog = (path: string): string[][] => existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
    : [];
  return {
    binDir,
    readCommands: () => readLog(commandLogPath),
    readOperations: () => existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
      : [],
  };
}
