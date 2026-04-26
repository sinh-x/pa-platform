import { resolve } from "node:path";
import { expandHome, getAiUsageDir } from "../../paths.js";

export function normalizeSandboxPath(inputPath: string, sandboxRoot = getAiUsageDir()): string {
  const root = resolve(sandboxRoot);
  const aiUsagePrefix = "~/Documents/ai-usage/";
  if (inputPath.startsWith(aiUsagePrefix)) return resolve(root, inputPath.slice(aiUsagePrefix.length));
  if (inputPath.startsWith("~/")) return resolve(expandHome(inputPath));
  if (inputPath.startsWith("/")) return inputPath;
  return resolve(root, inputPath);
}

export function validateSandboxPath(inputPath: string, sandboxRoot = getAiUsageDir()): string {
  const root = resolve(sandboxRoot);
  const resolved = resolve(inputPath);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new Error(`Path traversal denied: "${inputPath}" is outside sandbox root`);
  return resolved;
}

export function isInsideSandbox(inputPath: string, sandboxRoot = getAiUsageDir()): boolean {
  try {
    validateSandboxPath(inputPath, sandboxRoot);
    return true;
  } catch {
    return false;
  }
}
