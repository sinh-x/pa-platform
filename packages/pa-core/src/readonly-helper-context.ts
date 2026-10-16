import { formatBoundedFiveFieldDiagnostic, resolveRepoExecutionPath, type ResolvedRepoExecutionPath } from "./repos.js";

export type HelperFailureClass = "helper-incompatible" | "authority-rejected" | "command-unavailable";
export type ImplementationLaunchState = "launched" | "not-launched" | "unknown";
export type ReadOnlyHelperRole = "orchestrator" | "parented-implement" | "standalone-implement" | "worker-consistency-only" | "review-auto";

/** Reporting only: neither failure class nor launch state implies a lifecycle action. */
export class ReadOnlyHelperFailure extends Error {
  constructor(
    readonly classification: HelperFailureClass,
    readonly implementationLaunchState: ImplementationLaunchState,
    source: string,
    reason: string,
  ) {
    super(formatBoundedFiveFieldDiagnostic({
      condition: `read-only helper ${classification}; implementation ${implementationLaunchState}`,
      source, reason,
      correction: "preserve checkout, authority, feature ticket and approvals; reconcile the blocking helper evidence or command",
      resumeAction: "retry only after fresh matching evidence; session task cancellation is separate and grants no lifecycle action",
    }));
    this.name = "ReadOnlyHelperFailure";
  }
}

export interface ReadOnlyHelperContext extends ResolvedRepoExecutionPath {
  readonly access: "read-only";
  readonly role?: ReadOnlyHelperRole;
  readonly deploymentId?: string;
  readonly ticket?: string;
}
export interface ReadOnlyHelperAuthentication {
  readonly context: ReadOnlyHelperContext;
  /** Must reread every source, reject drift, and perform no authority update. */
  readonly reread: () => void;
}
/** Trusted adapter opt-in, not a binary spelling, CLI flag, or environment claim. */
export interface ReadOnlyHelperCapability {
  readonly authenticate: (cwd: string) => ReadOnlyHelperAuthentication;
}

/** Explicit canonical selectors and canonical CWD retain their existing authority policy. */
export function resolveReadOnlyHelperContext(
  selector: string | undefined,
  cwd = process.cwd(),
  capability?: ReadOnlyHelperCapability,
): ReadOnlyHelperAuthentication {
  if (selector !== undefined) return canonical(selector, cwd);
  let physical: ResolvedRepoExecutionPath;
  try { physical = resolveRepoExecutionPath(undefined, cwd, { allowLinkedWorktreeCwd: true }); }
  catch (error) { throw identityFailure(error, "physical repository identity"); }
  if (physical.worktreeKind === "primary") return canonical(undefined, cwd);
  if (!capability) throw new ReadOnlyHelperFailure("helper-incompatible", "unknown", "adapter helper capability", "this adapter has no authenticated linked-worktree read-only helper capability");
  return capability.authenticate(cwd);
}

/** Synchronous reread immediately before substantive helper access; no async gap. */
export function withReadOnlyHelperContext<T>(authentication: ReadOnlyHelperAuthentication, operation: (context: ReadOnlyHelperContext) => T): T {
  authentication.reread();
  return operation(authentication.context);
}

function identityFailure(error: unknown, source: string): ReadOnlyHelperFailure {
  const unavailable = error instanceof Error && (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return new ReadOnlyHelperFailure(unavailable ? "command-unavailable" : "authority-rejected", "unknown", source,
    unavailable ? "required Git identity executable is unavailable" : "registered physical canonical/linked selector or CWD evidence is missing, malformed or changed");
}

function canonical(selector: string | undefined, cwd: string): ReadOnlyHelperAuthentication {
  const read = () => {
    try { return resolveRepoExecutionPath(selector, cwd); }
    catch (error) { throw identityFailure(error, "canonical helper repository identity"); }
  };
  const initial = read();
  return Object.freeze({ context: Object.freeze({ ...initial, access: "read-only" as const }), reread: () => {
    const current = read();
    if (JSON.stringify(current) !== JSON.stringify(initial)) throw new ReadOnlyHelperFailure("authority-rejected", "unknown", "canonical identity reread", "registered physical repository identity changed");
  } });
}
