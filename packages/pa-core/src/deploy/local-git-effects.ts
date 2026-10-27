import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { executionFailure, workflowDigest } from "./prepared-workflow.js";

// Metadata display/cache and automatic maintenance are not part of the source
// command grant. Never suppress requested quality hooks or commit signing.
export const LOCAL_GIT_CONTROL_FLAGS: readonly string[] = Object.freeze(["-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0"]);
type Git = (args: readonly string[], cwd: string) => string | Buffer;
interface GitEffects { action: "materialize" | "stage" | "commit" | "inspect"; paths?: readonly string[]; source?: string }
const unsupported = () => executionFailure("EXECUTION_GIT_EFFECTS_UNSUPPORTED");
const stale = () => executionFailure("EXECUTION_CHECKED_CONTENT_UNPROVEN");
const bytes = (value: string | Buffer) => Buffer.from(value);
function config(git: Git, cwd: string, key: string, path = false): string | null {
  try {
    const value = bytes(git(["config", "--null", ...(path ? ["--path"] : []), "--get", key], cwd)).toString("utf8");
    if (!value.endsWith("\0") || value.slice(0, -1).includes("\0")) throw unsupported();
    return value.slice(0, -1);
  } catch (error) {
    // Only the native config query's not-found exit is absence, never prose.
    if ((error as { status?: unknown }).status === 1) return null;
    throw unsupported();
  }
}
/** Reject executable repository extensions, not bypass them. These are native
 * observations under existing repository custody, not a new permission ledger. */
export function assertSupportedLocalGitEffects(cwd: string, git: Git, input: GitEffects): void {
  try { inspectLocalGitEffects(cwd, git, input); } catch { throw unsupported(); }
}
function inspectLocalGitEffects(cwd: string, git: Git, input: GitEffects): void {
  const hooks = input.action === "materialize" ? ["reference-transaction", "post-checkout", "post-index-change"]
    : input.action === "stage" ? ["post-index-change"]
    : input.action === "inspect" ? [] : ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-rewrite", "reference-transaction", "post-index-change", "pre-auto-gc"];
  if (input.action !== "inspect") {
    const configured = config(git, cwd, "core.hooksPath", true);
    const common = bytes(git(["rev-parse", "--git-common-dir"], cwd)).toString("utf8").trim();
    const directory = configured === null ? resolve(cwd, common, "hooks") : resolve(cwd, configured);
    if (directory !== "/dev/null") {
      try {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) throw unsupported();
        for (const name of hooks) {
          try {
            const hook = lstatSync(join(directory, name));
            if (hook.isSymbolicLink() || !hook.isFile() || (hook.mode & 0o111)) throw unsupported();
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unsupported(); }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unsupported(); }
    }
  }
  if (input.action === "commit") {
    const signing = config(git, cwd, "commit.gpgSign");
    if (signing !== null && !["false", "no", "off", "0"].includes(signing.toLowerCase())) throw unsupported();
    if (config(git, cwd, "gc.recentObjectsHook") !== null) throw unsupported();
  }
  let paths = input.paths ?? [];
  if (!input.paths && input.source) {
    const raw = bytes(git(["ls-tree", "-r", "--name-only", "-z", input.source], cwd)), text = raw.toString("utf8");
    if (!raw.equals(Buffer.from(text)) || (text.length && !text.endsWith("\0"))) throw unsupported();
    paths = text.split("\0").filter(Boolean);
  }
  if (paths.length) {
    const fields = bytes(git(["check-attr", "-z", ...(input.source ? [`--source=${input.source}`] : []), "filter", "--", ...paths], cwd)).toString("utf8").split("\0");
    if (fields.pop() !== "" || fields.length !== paths.length * 3) throw unsupported();
    for (let i = 0; i < fields.length; i += 3) {
      const driver = fields[i + 2]!;
      if (["unspecified", "unset"].includes(driver)) continue;
      if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(driver)) throw unsupported();
      if (config(git, cwd, `filter.${driver}.clean`) !== null || config(git, cwd, `filter.${driver}.process`) !== null
        || (input.action === "materialize" && config(git, cwd, `filter.${driver}.smudge`) !== null)) throw unsupported();
    }
  }
}
/** Git status itself can invoke clean/process filters. Refuse affected opaque
 * drivers before metadata inspection rather than running code under a read grant. */
export function assertSupportedGitMetadataRead(cwd: string, git: Git): void {
  try {
    let configured: Buffer;
    try { configured = bytes(git(["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process)$"], cwd)); }
    catch (error) { if ((error as { status?: unknown }).status === 1) return; throw error; }
    if (!configured.length) return;
    const raw = bytes(git(["ls-files", "-z"], cwd)), text = raw.toString("utf8");
    if (!raw.equals(Buffer.from(text)) || (text.length && !text.endsWith("\0"))) throw unsupported();
    assertSupportedLocalGitEffects(cwd, git, { action: "inspect", paths: text.split("\0").filter(Boolean) });
  } catch { throw unsupported(); }
}
interface Entry { mode: string; oid: string; pathBase64: string }
function entries(raw: string | Buffer, tree: boolean): Entry[] {
  const data = bytes(raw), rows: Entry[] = [];
  for (let start = 0; start < data.length;) {
    const end = data.indexOf(0, start), tab = data.indexOf(9, start);
    if (end < 0 || tab < start || tab >= end || tab + 1 === end) throw stale();
    const header = data.subarray(start, tab).toString("ascii");
    const match = (tree ? /^(\d{6}) (?:blob|commit) ([0-9a-f]{40})$/ : /^(\d{6}) ([0-9a-f]{40}) 0$/).exec(header);
    if (!match) throw stale();
    rows.push({ mode: match[1]!, oid: match[2]!, pathBase64: data.subarray(tab + 1, end).toString("base64") }); start = end + 1;
  }
  return rows.sort((a, b) => Buffer.compare(Buffer.from(a.pathBase64, "base64"), Buffer.from(b.pathBase64, "base64")));
}
export function localGitIndexFingerprint(cwd: string, git: Git): string {
  return workflowDigest(JSON.stringify(entries(git(["ls-files", "--stage", "-z"], cwd), false)));
}
export function localGitTreeFingerprint(cwd: string, git: Git, commit: string): string {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw stale();
  return workflowDigest(JSON.stringify(entries(git(["ls-tree", "-r", "--full-tree", "-z", commit], cwd), true)));
}
/** Native pre-commit attestation: no filter/normalization/index substitution may
 * silently replace the actual checked working bytes/mode of an affected path. */
export function assertLocalGitIndexMatchesWorking(cwd: string, git: Git, paths: readonly string[]): void {
  const index = new Map(entries(git(["ls-files", "--stage", "-z"], cwd), false).map((row) => [row.pathBase64, row]));
  for (const path of paths) {
    if (isAbsolute(path) || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw stale();
    try {
      const full = join(cwd, path), stat = lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(full) !== full) throw stale();
      const oid = bytes(git(["hash-object", "--no-filters", "--", path], cwd)).toString("utf8").trim();
      const row = index.get(Buffer.from(path).toString("base64"));
      if (!row || row.oid !== oid || row.mode !== ((stat.mode & 0o111) ? "100755" : "100644")) throw stale();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || index.has(Buffer.from(path).toString("base64"))) throw stale(); }
  }
}
