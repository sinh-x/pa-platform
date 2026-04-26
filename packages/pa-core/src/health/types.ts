export type FindingSeverity = "pass" | "warn" | "fail";

export type HealthCategory = "deployments" | "agents" | "tickets" | "compliance" | "schedules" | "infrastructure";

export interface HealthFinding {
  severity: FindingSeverity;
  category: HealthCategory;
  message: string;
  details?: string;
}

export interface CategoryResult {
  name: HealthCategory;
  score: number;
  findings: HealthFinding[];
  stats?: Record<string, number | string | boolean>;
}

export interface HealthWindow {
  since: string;
  until: string;
}

export interface HealthConfig {
  weights: Partial<Record<HealthCategory, number>>;
  thresholds: {
    healthy: number;
    warning: number;
  };
}

export interface HealthReport {
  overallScore: number;
  scoreLabel: "healthy" | "warning" | "unhealthy";
  categories: CategoryResult[];
  window: HealthWindow;
  generatedAt: string;
}

export interface HealthSnapshot {
  id: number;
  timestamp: string;
  overallScore: number;
  windowSince: string;
  windowUntil: string;
  categories: Array<{ name: HealthCategory; score: number; findingsCount: number }>;
}

export interface HealthActivityEvent {
  ts: string;
  deploy_id: string;
  agent: string;
  agent_type?: string;
  event: string;
  data: Record<string, unknown>;
}

export interface ActivityAnalysis {
  deployId: string;
  totalCalls: number;
  failures: number;
  errorRate: number;
  errorLoops: Array<{ agent: string; consecutiveCount: number; firstTs: string }>;
}
