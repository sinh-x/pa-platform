import type { ActivityEvent, HookConfig, ResumeOpts, RuntimeAdapter, SpawnOpts, SpawnResult, ToolReference } from "@pa-platform/pa-core";

const PHASE_2_TODO = "ClaudeCodeAdapter is a Phase 1 stub; full spawn/resume/activity/hooks land in PAP-051 Phase 2.";

export interface ClaudeCodeAdapterOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly name = "claude" as const;
  readonly defaultModel = "claude-opus-4-7";
  readonly sessionFileName = "session-id-claude.txt";

  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
  }

  spawn(_opts: SpawnOpts): Promise<SpawnResult> {
    throw new Error(PHASE_2_TODO);
  }

  resume(_opts: ResumeOpts): Promise<SpawnResult> {
    throw new Error(PHASE_2_TODO);
  }

  extractActivity(_deployDir: string): ActivityEvent[] {
    return [];
  }

  installHooks(_targetDir: string, _config: HookConfig): void {
    // TODO(PAP-051 Phase 3): install ~/.claude/settings.json PreToolUse/PostToolUse/Stop entries.
  }

  describeTools(): ToolReference {
    return {
      runtime: this.name,
      markdown: [
        "Runtime: Claude Code via `cpa`.",
        "Use `cpa` for PA platform deployment and workflow commands; it invokes the runtime-neutral pa-core command set with Claude Code as the spawn target.",
        "Use `pa-core serve` for Agent API server lifecycle; `cpa` is the Claude Code deployment adapter, not the server owner.",
        "Use Claude-native tools exposed in the current session (Skill, AskUserQuestion, TeamCreate, ScheduleWakeup, Bash, Read, Edit, Write, Grep, Glob).",
        "Supported provider for `cpa deploy`: `anthropic` (default and only). Default model: `claude-opus-4-7` (override via --model or PA_CPA_DEFAULT_MODEL).",
      ].join("\n"),
    };
  }

  getCwd(): string {
    return this.cwd;
  }

  getEnv(): NodeJS.ProcessEnv {
    return this.env;
  }
}
