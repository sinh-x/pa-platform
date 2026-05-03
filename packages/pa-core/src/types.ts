// Ported from PA types.ts at frozen PA source on 2026-04-26; runtime adapter fields are additive for pa-platform.

export type RuntimeName = "claude" | "opencode";
export type ProviderName = "anthropic" | "minimax" | "openai" | "deepseek";
export type ModelName = "haiku" | "sonnet" | "opus" | "gpt-5.5";

export interface SkillEntry {
  name: string;
  "inject-as": "global-skill" | "shared-skill" | "reference";
}

export interface DeployMode {
  id: string;
  label: string;
  phone_visible?: boolean;
  objective?: string;
  agents?: string[];
  skills?: SkillEntry[];
  mode_type?: "housekeeping" | "work" | "interactive";
  solo?: boolean;
  model?: ModelName;
  provider?: ProviderName;
  timeout?: number;
  global_docs?: string[];
}

export interface HierarchyMember {
  role?: string;
  participates_in?: "all" | string[];
}

export interface Hierarchy {
  "team-manager"?: HierarchyMember;
  agents?: Array<{ name: string } & HierarchyMember>;
}

export interface Agent {
  name: string;
  role: string;
  instruction?: string;
  skill?: string;
  model?: ModelName;
}

export interface TeamConfig {
  name: string;
  description: string;
  context?: {
    organization?: string;
    notes?: string;
  };
  variables?: Record<string, string>;
  agents: Agent[];
  objective: string;
  model?: ModelName;
  deploy_modes?: DeployMode[];
  default_mode?: string;
  hierarchy?: Hierarchy;
  timeout?: number;
  global_docs?: string[];
  terse_mode?: boolean;
}

export interface Rating {
  source: "agent" | "system" | "user";
  overall: number;
  productivity?: number;
  quality?: number;
  efficiency?: number;
  insight?: number;
}

export interface RegistryEvent {
  deployment_id: string;
  team: string;
  event: "started" | "pid" | "completed" | "crashed" | "amended" | "updated";
  timestamp: string;
  note?: string;
  pid?: number;
  status?: "success" | "partial" | "failed";
  summary?: string;
  log_file?: string;
  primer?: string;
  agents?: string[];
  models?: Record<string, string>;
  error?: string;
  exit_code?: number;
  ticket_id?: string;
  provider?: string;
  rating?: Rating;
  objective?: string;
  repo?: string;
  fallback?: boolean;
  resumed_from_deployment_id?: string;
  runtime?: RuntimeName;
  binary?: string;
  effective_timeout_seconds?: number;
}

export interface DeploymentStatus {
  deploy_id: string;
  team: string;
  status: "running" | "success" | "partial" | "failed" | "crashed" | "dead" | "unknown";
  started_at: string;
  completed_at?: string;
  pid?: number;
  agents: string[];
  summary?: string;
  log_file?: string;
  primer?: string;
  ticket_id?: string;
  objective?: string;
  models?: Record<string, string>;
  provider?: string;
  repo?: string;
  fallback?: boolean;
  resumed_from_deployment_id?: string;
  runtime?: RuntimeName;
  binary?: string;
  effective_timeout_seconds?: number;
}

export interface ProviderModelTier {
  sonnet?: string;
  opus?: string;
  haiku?: string;
}

export interface ProviderDefaults {
  default_provider?: ProviderName;
  default_model?: ModelName;
  providers?: {
    anthropic?: { base_url?: string; models?: ProviderModelTier };
    minimax?: { base_url?: string; models?: ProviderModelTier };
    openai?: { base_url?: string; models?: ProviderModelTier };
    deepseek?: { base_url?: string; models?: ProviderModelTier };
  };
}

export interface PlatformConfig {
  configDir: string;
  dataDir: string;
  homeDir: string;
  teamsDir: string;
  skillsDir: string;
  provider_defaults?: ProviderDefaults;
  defaults?: {
    runtime?: RuntimeName;
    opencode?: { provider?: string; model?: string };
    claudecode?: { model?: string; minimax_via_claude?: boolean };
  };
}
