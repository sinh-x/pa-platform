/** Established finite owner causes, never exception-text classification or grants. */
export type RepositoryRefCause = "retained-custody" | "active-or-uncertain-writer" | "inventory-changed";
export class RepositoryRefError extends Error {
  constructor(readonly reason: RepositoryRefCause) {
    super({
      "retained-custody": "ref owner overlaps retained repository custody",
      "active-or-uncertain-writer": "repository ref overlaps live or uncertain ticket ownership",
      "inventory-changed": "ref worktree inventory changed",
    }[reason]);
    this.name = "RepositoryRefError";
  }
}
