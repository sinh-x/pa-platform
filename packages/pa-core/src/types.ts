// Ported from PA types.ts at frozen PA source on 2026-04-26; runtime adapter fields are additive for pa-platform.

export type RuntimeName = "claude" | "opencode" | "droid" | "pi";
export type ApiRuntimeName = "opencode" | "pi";
export type DeploymentInvocationChannel = "cli" | "agent-api";
export type ProviderName = string;
export type ModelName = string;

export interface SkillEntry {
  name: string;
  "inject-as": "global-skill" | "shared-skill" | "reference";
}

export type AutonomyLevel = "low" | "medium" | "high";

export interface RuntimeOverrides {
  model?: ModelName;
  provider?: ProviderName;
  autonomy?: AutonomyLevel;
  timeout?: number;
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
  project_guides?: Record<string, string[]>;
  require_ticket?: boolean;
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

export type EvaluatorMetricName =
  | "productivity"
  | "quality"
  | "efficiency"
  | "insight"
  | "human_agency"
  | "evidence_grounding"
  | "instruction_compliance"
  | "user_fit"
  | "risk_handling"
  | "outcome_integrity";

export interface EvaluatorRating {
  source: "system" | "user";
  overall: number;
  metrics: Partial<Record<EvaluatorMetricName, number>>;
}

export interface EvaluatorResult {
  target_deployment_id: string;
  evaluator_deployment_id: string;
  summary?: string;
  report_path?: string;
  evidence_refs: string[];
  findings?: string;
  rating: EvaluatorRating;
  created_at: string;
}

export interface RegistryEvent {
  deployment_id: string;
  team: string;
  event: "started" | "pid" | "completed" | "crashed" | "amended" | "updated" | "ticket-associated";
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
  previous_ticket_id?: string | null;
  actor?: string;
  reason?: string;
  provider?: string;
  rating?: Rating;
  objective?: string;
  repo?: string;
  repo_root?: string;
  worktree_root?: string;
  repository_slot?: "orchestrator" | "implement";
  parent_deployment_id?: string;
  builder_authority?: "orchestrator" | "parented-implement" | "standalone-implement";
  treehouse_path?: string;
  treehouse_lease_id?: string;
  treehouse_lease_holder?: string;
  branch_state?: "planned" | "materialized";
  branch_base_sha?: string;
  branch_head_sha?: string;
  ticket_slot_id?: string;
  repository_permit?: 1 | 2 | 3 | 4;
  mode?: string;
  fallback?: boolean;
  resumed_from_deployment_id?: string;
  runtime?: RuntimeName;
  binary?: string;
  effective_timeout_seconds?: number;
  rogue_one?: boolean;
  invocation_channel?: DeploymentInvocationChannel;
}

export type TicketAssociatedRegistryEvent = RegistryEvent & {
  event: "ticket-associated";
  previous_ticket_id: string | null;
  ticket_id: string;
  actor: string;
  reason: string;
};

export interface AssociateDeploymentTicketInput {
  deploymentId: string;
  ticketId: string;
  expectedTicketId: string | null;
  actor: string;
  reason: string;
  timestamp?: string;
}

export interface AssociateDeploymentTicketResult {
  deploymentId: string;
  previousTicketId: string | null;
  requestedTicketId: string;
  currentTicketId: string;
  actor: string;
  reason: string;
  writeOccurred: boolean;
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
  repo_root?: string;
  worktree_root?: string;
  repository_slot?: "orchestrator" | "implement";
  parent_deployment_id?: string;
  builder_authority?: "orchestrator" | "parented-implement" | "standalone-implement";
  treehouse_path?: string;
  treehouse_lease_id?: string;
  treehouse_lease_holder?: string;
  branch_state?: "planned" | "materialized";
  branch_base_sha?: string;
  branch_head_sha?: string;
  ticket_slot_id?: string;
  repository_permit?: 1 | 2 | 3 | 4;
  mode?: string;
  fallback?: boolean;
  resumed_from_deployment_id?: string;
  runtime?: RuntimeName;
  binary?: string;
  effective_timeout_seconds?: number;
  rogue_one?: boolean;
  invocation_channel?: DeploymentInvocationChannel;
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
    "ollama-cloud"?: { base_url?: string; models?: ProviderModelTier };
    factory?: { api_key?: string; base_url?: string };
  };
}

export interface PlatformConfig {
  configDir: string;
  dataDir: string;
  homeDir: string;
  teamsDir: string;
  skillsDir: string;
  repos: Record<string, RepoConfig>;
  provider_defaults?: ProviderDefaults;
  defaults?: {
    runtime?: RuntimeName;
    opencode?: { provider?: string; model?: string };
    claudecode?: { model?: string; minimax_via_claude?: boolean };
    droidcode?: { model?: string; autonomy?: AutonomyLevel };
  };
}

export interface RepoConfig {
  path: string;
  description?: string;
  prefix?: string;
  mainBranch?: string;
  developBranch?: string;
  featureBranchPattern?: string;
  remote_url?: string;
}
