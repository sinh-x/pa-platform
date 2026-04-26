import type { RuntimeName } from "../types.js";

export interface ActivityEvent {
  deployId: string;
  timestamp: string;
  kind: "thinking" | "text" | "tool_use" | "tool_result" | "error";
  source: RuntimeName | string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface HookConfig {
  deploymentId: string;
  deploymentDir: string;
  activityLogPath: string;
  sensitivePatternsPath?: string;
  env?: Record<string, string>;
}

export interface ToolReference {
  runtime: RuntimeName;
  markdown: string;
}

export interface SpawnOpts {
  primerPath: string;
  deployId: string;
  mode: "foreground" | "background" | "direct" | "interactive" | "dry-run";
  model?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  logFile?: string;
}

export interface ResumeOpts extends SpawnOpts {
  sessionId: string;
}

export interface SpawnResult {
  sessionId: string;
  exitCode: number;
  logFile?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeAdapter {
  readonly name: RuntimeName;
  readonly defaultModel: string;
  readonly sessionFileName: string;
  spawn(opts: SpawnOpts): Promise<SpawnResult> | SpawnResult;
  resume(opts: ResumeOpts): Promise<SpawnResult> | SpawnResult;
  extractActivity(deployDir: string): Promise<ActivityEvent[]> | ActivityEvent[];
  installHooks(targetDir: string, config: HookConfig): Promise<void> | void;
  describeTools(): ToolReference;
}
