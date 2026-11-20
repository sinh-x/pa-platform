import { getBranchPattern, loadRepoEntry } from "../repos.js";
import { validateBranchNameForTicket } from "../tickets/git-validation.js";
import { documentReject } from "./package-contract.js";

/** Current registered policy admission, never used by history parsers/digests.
 * The handoff profile retains exact-ticket/kebab-topic and develop boundaries.
 * Templates are escaped literals, not regexes or a prefix/layout allowlist. */
export function assertRegisteredHandoffPolicy(key: string, root: string, ticket: string, branch: string): void {
  const repo = loadRepoEntry(key);
  if (!repo || repo.path !== root || (repo.developBranch ?? "develop") !== "develop") documentReject("DOCUMENT_AUTHORITY");
  // Only omission selects the registered default. Invalid present policy must
  // not inherit it, including null values retained by config normalization.
  if (repo.featureBranchPattern !== undefined && typeof repo.featureBranchPattern !== "string") documentReject("DOCUMENT_AUTHORITY");
  const pattern = getBranchPattern(repo);
  if (!pattern || pattern.length > 256 || pattern.split("<ticket>").length !== 2 || pattern.split("<topic>").length !== 2
    || /[<>]/.test(pattern.replace("<ticket>", "").replace("<topic>", ""))
    || !validateBranchNameForTicket(branch, ticket, pattern, true)) documentReject("DOCUMENT_AUTHORITY");
}
