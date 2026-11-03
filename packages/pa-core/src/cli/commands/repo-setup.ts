import { RepoContractAuthority, RepoOperatorError } from "../../repo-contract-authority.js";
import { newOperatorSecret, operatorTerminal, type OperatorTerminal } from "../../operator-terminal.js";
import { resolveRepoExecutionPath } from "../../repos.js";
import { assertUnmanagedOperator } from "../../operator-origin.js";
import type { CliIo } from "../utils.js";

/** Native test/embedding seam only, never parsed from argv or environment. */
export interface RepoOperatorCliHost { authority?: RepoContractAuthority; terminal?: OperatorTerminal; assertOperator?: () => void }
export async function runRepoSetupOperatorCommand(args: string[], io: Required<CliIo>, host: RepoOperatorCliHost = {}): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    io.stdout("repo-setup credential init|rotate|reset\nrepo-setup approve|revoke|status <registered-repository-key>\nOperator terminal only. No password arguments/environment/pipe, --yes, agent approval or execution grants. Reset invalidates all machine-local contract approvals; rotation preserves them."); return 0;
  }
  const credential = args.length === 2 && args[0] === "credential" && ["init", "rotate", "reset"].includes(args[1]!);
  const repository = args.length === 2 && ["approve", "revoke", "status"].includes(args[0]!) && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(args[1]!);
  if (!credential && !repository) { io.stderr("REPO_OPERATOR_ARGUMENTS: use repo-setup --help; password/grant/path overrides are unsupported"); return 1; }
  const authority = host.authority ?? new RepoContractAuthority(), terminal = host.terminal ?? operatorTerminal();
  let secret: Buffer | undefined, old: Buffer | undefined;
  try {
    (host.assertOperator ?? assertUnmanagedOperator)();
    if (credential) {
      terminal.assertAvailable(); const operation = args[1] as "init" | "rotate" | "reset";
      if (operation === "reset" && !await terminal.confirm("Reset invalidates ALL saved repository contract approvals on this machine. Type RESET to continue: ", "RESET")) return 1;
      if (operation === "rotate") old = await terminal.secret("Current operator password: ");
      secret = await newOperatorSecret(terminal); authority.configure(operation, secret, old);
      io.stdout(operation === "reset" ? "Operator credential reset; all prior contract approvals are invalidated. Historical evidence retained." : "Operator credential configured; no execution authority granted."); return 0;
    }
    const resolved = resolveRepoExecutionPath(args[1]), repo = { key: resolved.repoKey, root: resolved.repoRoot };
    if (args[0] === "status") {
      const approved = authority.approved(repo);
      io.stdout(JSON.stringify({ configured: authority.credentialStatus().configured, catalogueApproved: approved !== null, ...(approved ? { catalogueSha256: approved.catalogue.sha256, approvalSha256: approved.approvalSha256 } : {}), executionReady: false })); return 0;
    }
    terminal.assertAvailable();
    if (args[0] === "revoke") {
      terminal.display(`Revoke reusable command catalogue approval for ${repo.key} (${repo.root}). Historical evidence is retained.\n`);
      if (!await terminal.confirm("Type REVOKE to continue: ", "REVOKE")) return 1;
      secret = await terminal.secret("Operator password: "); authority.revoke(repo, secret); io.stdout("Contract approval revoked; no new dependent execution permitted."); return 0;
    }
    const preview = authority.preview(repo);
    terminal.display(`Repository: ${repo.key}\nPhysical root: ${repo.root}\nFile set: .pa/project-commands.json\nExact raw SHA-256: ${preview.catalogue.sha256}\nSupported effects only: project-read, isolated-temp-write\nCatalogue (NOT a task/execution grant):\n${JSON.stringify(preview.catalogue, null, 2)}\nLocal Git exclude effect: ${preview.exclude.appendRequired ? "append exact /.pa/ rule; preserve existing entries" : "retain existing exact /.pa/ rule"}. Actual ignored/untracked status must pass.\nApproval is reusable catalogue membership only; task scope, custody, toolchain and confinement remain mandatory.\n`);
    if (!await terminal.confirm("Type APPROVE to approve these exact bytes and the displayed exclude effect: ", "APPROVE")) return 1;
    secret = await terminal.secret("Operator password: "); const approvalSha256 = authority.approve(preview, secret);
    io.stdout(JSON.stringify({ catalogueApproved: true, catalogueSha256: preview.catalogue.sha256, approvalSha256, executionReady: false })); return 0;
  } catch (error) {
    io.stderr(error instanceof RepoOperatorError ? error.code : "REPO_OPERATOR_REJECTED: terminal, origin, repository or protected evidence is unavailable; preserve existing state"); return 1;
  } finally { secret?.fill(0); old?.fill(0); }
}
