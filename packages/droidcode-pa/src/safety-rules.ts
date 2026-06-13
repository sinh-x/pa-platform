// Shared destructive-command and sensitive-file detection rules.
// Used by both the PreToolUse hook source and the SDK permissionHandler (FR9).

export interface SafetyPatterns {
  destructiveCommands: string[];
  blockedFilePatterns: string[];
}

export const SAFETY_PATTERNS: SafetyPatterns = {
  destructiveCommands: [
    // rm / rm -rf / sudo rm (word-boundary, with flag support)
    String.raw`\brm\b`,
    // rmdir
    String.raw`\brmdir\b`,
    // unlink
    String.raw`\bunlink\b`,
    // shred
    String.raw`\bshred\b`,
    // dd (disk destroyer)
    String.raw`\bdd\b`,
    // truncate
    String.raw`\btruncate\b`,
    // find ... -delete
    String.raw`\bfind\b.*\b-delete\b`,
    // find ... -exec rm
    String.raw`\bfind\b.*\b-exec\b.*\brm\b`,
    // xargs rm
    String.raw`\bxargs\b.*\brm\b`,
    // git clean -f (with optional d/x/n)
    String.raw`\bgit\s+clean\b.*-f`,
    // git push --force
    String.raw`\bgit\s+push\b.*--force`,
    // Redirect overwrite: > file, :> file
    String.raw`[^>]\s*>:?\s*\S`,
  ],

  blockedFilePatterns: [
    String.raw`(^|[\\/])\.env(\.|$)`,
    String.raw`(^|[\\/])\.ssh[\\/]id_`,
    String.raw`credentials`,
    String.raw`secrets?.*\.(json|ya?ml)$`,
    String.raw`[-_]token\.json$`,
    String.raw`[-_]api[-_]?key\.json$`,
    String.raw`(^|[\\/])\.netrc$`,
    String.raw`(^|[\\/])\.npmrc$`,
    String.raw`(^|[\\/])\.pypirc$`,
  ],
};

export function isDestructiveCommand(command: string): boolean {
  if (!command) return false;
  for (const pattern of SAFETY_PATTERNS.destructiveCommands) {
    try {
      if (new RegExp(pattern, "i").test(command)) return true;
    } catch {
      // skip malformed pattern
    }
  }
  return false;
}

export function isBlockedFilePath(filePath: string): boolean {
  if (!filePath) return false;
  for (const pattern of SAFETY_PATTERNS.blockedFilePatterns) {
    try {
      if (new RegExp(pattern, "i").test(filePath)) return true;
    } catch {
      // skip malformed pattern
    }
  }
  return false;
}
