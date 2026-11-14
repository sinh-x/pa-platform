import { execFileSync } from "node:child_process";
import { AutoWaitlistError, LOCAL_GIT_CONTROL_FLAGS } from "@pa-platform/pa-core";
import { trustedNativeExecutable } from "./native-execution-evidence.js";
/** Fixed native metadata read; no inherited GIT_* overrides, shell or effects. */
export function autoGitCommitSha(root: string, ref: string): string {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "LANG", "LC_ALL", "TZ"]) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  const value = execFileSync(trustedNativeExecutable("git"), ["--no-replace-objects", "--no-optional-locks", ...LOCAL_GIT_CONTROL_FLAGS, "-C", root, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { env, encoding: "utf8", timeout: 10_000, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (!/^[a-f0-9]{40}$/.test(value)) throw new AutoWaitlistError("AUTO_SOURCE"); return value;
}
