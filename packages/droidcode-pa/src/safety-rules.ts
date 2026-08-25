import { isBlockedFilePath, isDestructiveCommand, PA_SAFETY_PATTERNS, type SafetyPatterns } from "@pa-platform/pa-core";

export { isBlockedFilePath, isDestructiveCommand, PA_SAFETY_PATTERNS };
export type { SafetyPatterns };
export const SAFETY_PATTERNS: SafetyPatterns = PA_SAFETY_PATTERNS;
