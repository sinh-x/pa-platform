import { lstatSync, realpathSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { loadRepoEntry } from "./repos.js";
import { MAX_PROJECT_COMMAND_CATALOGUE_BYTES, parseProjectCommandCatalogue, PROJECT_COMMAND_CATALOGUE_PATH,
  ProjectCatalogueError, type ProjectCommandCatalogue } from "./project-command-catalogue.js";
import { readReviewEvidenceFile } from "./validation/review-contract.js";

function same(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.ctimeMs === right.ctimeMs && left.mtimeMs === right.mtimeMs;
}
/** Existing registered-primary administrative data only. No mkdir, Git/index
 * operations, command probe, approval lookup/issuance or implicit adoption. */
export function inspectLocalProjectCommandCatalogue(repoKey: string, repoRoot: string): ProjectCommandCatalogue | null {
  try {
    if (loadRepoEntry(repoKey)?.path !== repoRoot || realpathSync(repoRoot) !== repoRoot || !lstatSync(repoRoot).isDirectory()) throw new ProjectCatalogueError("CATALOGUE_REPOSITORY");
    const root = lstatSync(repoRoot), file = join(repoRoot, PROJECT_COMMAND_CATALOGUE_PATH), parent = dirname(file);
    const assertRoot = () => {
      const current = lstatSync(repoRoot);
      if (loadRepoEntry(repoKey)?.path !== repoRoot || realpathSync(repoRoot) !== repoRoot || current.dev !== root.dev || current.ino !== root.ino) throw new ProjectCatalogueError("CATALOGUE_REPOSITORY");
    };
    let directory: Stats;
    try { directory = lstatSync(parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { assertRoot(); return null; } throw error; }
    if (!directory.isDirectory() || realpathSync(parent) !== parent) throw new ProjectCatalogueError("CATALOGUE_IO");
    const assertParent = () => {
      assertRoot();
      if (realpathSync(parent) !== parent || !same(directory, lstatSync(parent))) throw new ProjectCatalogueError("CATALOGUE_IO");
    };
    let initial: Stats;
    try { initial = lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { assertParent(); return null; } throw error; }
    if (directory.uid !== process.getuid?.() || (directory.mode & 0o7777) !== 0o700
      || !initial.isFile() || realpathSync(file) !== file || initial.nlink !== 1 || initial.uid !== process.getuid?.()
      || (initial.mode & 0o7777) !== 0o600 || initial.size > MAX_PROJECT_COMMAND_CATALOGUE_BYTES) throw new ProjectCatalogueError("CATALOGUE_IO");
    const bytes = readReviewEvidenceFile(file, MAX_PROJECT_COMMAND_CATALOGUE_BYTES, "local command catalogue");
    const catalogue = parseProjectCommandCatalogue(bytes, { key: repoKey, root: repoRoot });
    assertParent();
    if (!same(initial, lstatSync(file))) throw new ProjectCatalogueError("CATALOGUE_IO");
    return catalogue;
  } catch (error) {
    if (error instanceof ProjectCatalogueError) throw error;
    throw new ProjectCatalogueError("CATALOGUE_IO");
  }
}
