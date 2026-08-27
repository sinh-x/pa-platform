# Data Models

Field-level type definitions and descriptions for all core data types in the pa-platform Agent API. Every type documented here is derived directly from the TypeScript source in `packages/pa-core/src/` — no fields are invented.

> **Source of truth:** `packages/pa-core/src/types.ts`, `packages/pa-core/src/tickets/types.ts`, `packages/pa-core/src/bulletins/types.ts`, `packages/pa-core/src/registry/index.ts`, `packages/pa-core/src/health/types.ts`, `packages/pa-core/src/signal/types.ts`, `packages/pa-core/src/codectx/types.ts`, `packages/pa-core/src/activity/index.ts`, `packages/pa-core/src/agent-api/ws/session-hub.ts`.
> **Last updated:** 2026-08-13

## Table of Contents

- [Core Enums](#core-enums)
- [Ticket](#ticket)
- [Bulletin](#bulletin)
- [Deployment & Registry](#deployment--registry)
- [Health](#health)
- [Signal](#signal)
- [CodeCtx](#codectx)
- [Activity](#activity)
- [Session](#session)
- [Platform Config](#platform-config)

---

## Core Enums

These enum-like union types appear across multiple data models.

### `TicketStatus`

The lifecycle status of a ticket.

```typescript
type TicketStatus =
  | "idea"
  | "requirement-review"
  | "pending-approval"
  | "pending-implementation"
  | "implementing"
  | "review-uat"
  | "done"
  | "rejected"
  | "cancelled";
```

| Value | Description |
|-------|-------------|
| `idea` | Initial idea — not yet a formal ticket. |
| `requirement-review` | Requirements being analyzed by the requirements team. |
| `pending-approval` | Requirements complete, awaiting Sinh's approval to implement. |
| `pending-implementation` | Approved, queued for the builder team. |
| `implementing` | Actively being implemented by a builder agent. |
| `review-uat` | Implementation complete, awaiting Sinh's UAT review. |
| `done` | Terminal — completed and accepted. |
| `rejected` | Terminal — rejected during review or approval. |
| `cancelled` | Terminal — cancelled (superseded, obsolete, or no longer needed). |

**Terminal statuses:** `done`, `rejected`, `cancelled`.
**Active statuses:** `idea`, `requirement-review`, `pending-approval`, `pending-implementation`, `implementing`, `review-uat`.

### `TicketPriority`

```typescript
type TicketPriority = "critical" | "high" | "medium" | "low";
```

### `TicketType`

```typescript
type TicketType =
  | "feature"
  | "bug"
  | "task"
  | "review-request"
  | "work-report"
  | "fyi"
  | "idea"
  | "question";
```

### `Estimate`

```typescript
type Estimate = "XS" | "S" | "M" | "L" | "XL";
```

### `SubTicketStatus`

```typescript
type SubTicketStatus = "open" | "in-progress" | "done";
```

### `RuntimeName`

The agent runtime that executes a deployment.

```typescript
type RuntimeName = "claude" | "opencode" | "droid";
```

### `AutonomyLevel`

```typescript
type AutonomyLevel = "low" | "medium" | "high";
```

---

## Ticket

The `Ticket` is the central work-item type. Each ticket is a JSON file in the tickets directory, named `<id>.json`.

> **Source:** `packages/pa-core/src/tickets/types.ts`

### `Ticket`

```typescript
interface Ticket {
  id: string;
  project: string;
  title: string;
  summary: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  type: TicketType;
  assignee: string;
  estimate: Estimate;
  from: string;
  to: string;
  tags: string[];
  blockedBy: string[];
  doc_refs: DocRef[];
  linkedBranches: LinkedBranch[];
  linkedCommits: LinkedCommit[];
  comments: Comment[];
  subTickets: SubTicket[];
  nextSubTicketCounter: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Ticket id (e.g. `PAP-132`). Unique within the project. |
| `project` | `string` | yes | Project key from `repos.yaml` (e.g. `pa`, `avodah`). |
| `title` | `string` | yes | Short human-readable title. |
| `summary` | `string` | yes | One-line summary shown in board views. |
| `description` | `string` | yes | Full description / body of the ticket. |
| `status` | [`TicketStatus`](#ticketstatus) | yes | Lifecycle status. |
| `priority` | [`TicketPriority`](#ticketpriority) | yes | Priority level. |
| `type` | [`TicketType`](#tickettype) | yes | Ticket category. |
| `assignee` | `string` | yes | Assignee in `<team>/<agent>` format, or `sinh`, or empty string. |
| `estimate` | [`Estimate`](#estimate) | yes | T-shirt size estimate. |
| `from` | `string` | yes | Origin/source label (free text, often a date or source system). |
| `to` | `string` | yes | Destination/target label (free text). |
| `tags` | `string[]` | yes | Free-form tags for filtering. Empty array if none. |
| `blockedBy` | `string[]` | yes | Ticket ids that block this ticket. Empty array if none. |
| `doc_refs` | [`DocRef[]`](#docref) | yes | Document references (requirements, plans, session logs, etc.). Empty array if none. |
| `linkedBranches` | [`LinkedBranch[]`](#linkedbranch) | yes | Git branches linked to this ticket. Empty array if none. |
| `linkedCommits` | [`LinkedCommit[]`](#linkedcommit) | yes | Git commits linked to this ticket. Empty array if none. |
| `comments` | [`Comment[]`](#comment) | yes | Discussion comments in chronological order. Empty array if none. |
| `subTickets` | [`SubTicket[]`](#subticket) | yes | Child work items. Empty array if none. |
| `nextSubTicketCounter` | `number` | yes | Counter for generating the next sub-ticket id. |
| `createdAt` | `string` | yes | ISO 8601 timestamp of creation. |
| `updatedAt` | `string` | yes | ISO 8601 timestamp of last update. |
| `resolvedAt` | `string \| null` | yes | ISO 8601 timestamp when the ticket reached a terminal status, or `null` if not resolved. |

### `DocRef`

A reference to an external document (requirements doc, plan, session log, URL, attachment).

```typescript
interface DocRef {
  type: string;
  path: string;
  primary: boolean;
  addedAt: string;
  addedBy: string;
  title?: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | yes | Reference type. Standard types: `req`, `uat`, `impl`, `orch`, `plan`, `spike`, `session`, `log`, `url`, `attachment`. Also accepts `requirements`, `implementation`, `review`, `review-report` (mapped to display badges). |
| `path` | `string` | yes | Path or URL to the document. |
| `primary` | `boolean` | yes | Whether this is the primary doc-ref for the ticket. |
| `addedAt` | `string` | yes | ISO 8601 timestamp when the reference was added. |
| `addedBy` | `string` | yes | Who added the reference (actor name). |
| `title` | `string` | no | Optional human-readable title for the document. |

**Doc-ref badge display order:** `req`, `plan`, `spike`, `impl`, `uat`, `orch`, `session`, `log`, `url`, `attachment`.

**Doc-ref type → display badge:**

| `type` | Badge |
|--------|-------|
| `req` / `requirements` | REQ |
| `uat` | UAT |
| `impl` / `implementation` | IMPL |
| `orch` | ORCH |
| `plan` | PLAN |
| `spike` | SPIKE |
| `session` | SESSION |
| `log` | LOG |
| `url` | URL |
| `attachment` | ATTACHMENT |
| `review` / `review-report` | REVIEW |

### `LinkedBranch`

A git branch linked to a ticket for traceability.

```typescript
interface LinkedBranch {
  repo: string;
  branch: string;
  sha: string;
  linkedAt: string;
  linkedBy: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repo` | `string` | yes | Repository key (e.g. `pa`). |
| `branch` | `string` | yes | Branch name (e.g. `feature/PAP-132-api-documentation`). |
| `sha` | `string` | yes | Commit SHA the branch points at when linked. |
| `linkedAt` | `string` | yes | ISO 8601 timestamp when the link was added. |
| `linkedBy` | `string` | yes | Who linked the branch. |

### `LinkedCommit`

A git commit linked to a ticket.

```typescript
interface LinkedCommit {
  repo: string;
  sha: string;
  message: string;
  author: string;
  timestamp: string;
  linkedAt: string;
  linkedBy: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repo` | `string` | yes | Repository key. |
| `sha` | `string` | yes | Full commit SHA. |
| `message` | `string` | yes | Commit message (subject line). |
| `author` | `string` | yes | Commit author name. |
| `timestamp` | `string` | yes | ISO 8601 timestamp of the commit (`%aI` from `git log`). |
| `linkedAt` | `string` | yes | ISO 8601 timestamp when the link was added. |
| `linkedBy` | `string` | yes | Who linked the commit. |

### `Comment`

A discussion comment on a ticket.

```typescript
interface Comment {
  id: string;
  author: string;
  content: string;
  timestamp: string;
  editedAt?: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Comment id (unique within the ticket). |
| `author` | `string` | yes | Author name (e.g. `builder/team-manager`, `sinh`). |
| `content` | `string` | yes | Comment body (markdown). |
| `timestamp` | `string` | yes | ISO 8601 timestamp when the comment was created. |
| `editedAt` | `string` | no | ISO 8601 timestamp when the comment was last edited. |

### `SubTicket`

A child work item of a ticket.

```typescript
interface SubTicket {
  id: string;
  title: string;
  summary: string;
  status: SubTicketStatus;
  assignee: string;
  priority: TicketPriority;
  estimate: Estimate;
  createdAt: string;
  updatedAt: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Sub-ticket id (generated from the parent's `nextSubTicketCounter`). |
| `title` | `string` | yes | Short title. |
| `summary` | `string` | yes | One-line summary. |
| `status` | [`SubTicketStatus`](#subticketstatus) | yes | `open`, `in-progress`, or `done`. |
| `assignee` | `string` | yes | Assignee. |
| `priority` | [`TicketPriority`](#ticketpriority) | yes | Priority level. |
| `estimate` | [`Estimate`](#estimate) | yes | T-shirt size. |
| `createdAt` | `string` | yes | ISO 8601 timestamp. |
| `updatedAt` | `string` | yes | ISO 8601 timestamp. |

### `AuditEntry`

An audit-log entry recording a change to a ticket.

```typescript
interface AuditEntry {
  ticket_id: string;
  action:
    | "created"
    | "updated"
    | "commented"
    | "attached"
    | "doc_ref_added"
    | "doc_ref_removed"
    | "branch_link_added"
    | "branch_link_removed"
    | "commit_link_added"
    | "commit_link_removed"
    | "deleted"
    | "archived"
    | "unarchived";
  actor: string;
  timestamp: string;
  changes: Record<string, [unknown, unknown]>;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ticket_id` | `string` | yes | The ticket id the audit entry belongs to. |
| `action` | `string` | yes | The action performed (see union above). |
| `actor` | `string` | yes | Who performed the action. |
| `timestamp` | `string` | yes | ISO 8601 timestamp. |
| `changes` | `Record<string, [unknown, unknown]>` | yes | Map of field → `[oldValue, newValue]` for fields that changed. |

---

## Bulletin

Bulletins are blocking notices that can pause one or more teams. A bulletin is a markdown file with YAML frontmatter in the bulletins directory.

> **Source:** `packages/pa-core/src/bulletins/types.ts`

### `Bulletin`

```typescript
type BulletinBlock = "all" | string[];

interface Bulletin {
  id: string;
  title: string;
  status: "active" | "resolved";
  block: BulletinBlock;
  except: string[];
  created: string;
  body: string;
  filename: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Bulletin id (e.g. `B-007`). |
| `title` | `string` | yes | Short title. |
| `status` | `"active" \| "resolved"` | yes | Whether the bulletin is currently blocking. |
| `block` | `"all" \| string[]` | yes | Which teams to block. `"all"` blocks every team; an array lists specific team names. |
| `except` | `string[]` | yes | Teams exempt from the block (still allowed to run). Empty array if none. |
| `created` | `string` | yes | ISO 8601 timestamp of creation. |
| `body` | `string` | yes | The markdown body (after the frontmatter). |
| `filename` | `string` | yes | The markdown filename (e.g. `B-007.md`). |

---

## Deployment & Registry

The registry tracks every deployment's lifecycle as a sequence of `RegistryEvent` rows in a SQLite database. A computed `DeploymentStatus` view aggregates those events into a single status per deployment.

> **Source:** `packages/pa-core/src/types.ts`, `packages/pa-core/src/registry/index.ts`

### `RegistryEvent`

A single event in a deployment's lifecycle, appended to the `registry_events` table.

```typescript
interface RegistryEvent {
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
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `deployment_id` | `string` | yes | The deployment id (e.g. `d-443e6d`). |
| `team` | `string` | yes | Team name (e.g. `builder`). |
| `event` | `string` | yes | Event kind: `started`, `pid`, `completed`, `crashed`, `amended`, `updated`. |
| `timestamp` | `string` | yes | ISO 8601 timestamp of the event. |
| `note` | `string` | no | Free-text note (used by `amended`/`updated` events). |
| `pid` | `number` | no | Process id (sent with the `pid` event). |
| `status` | `"success" \| "partial" \| "failed"` | no | Final status (sent with `completed`). |
| `summary` | `string` | no | Completion summary (sent with `completed`). |
| `log_file` | `string` | no | Path to the session log file. |
| `primer` | `string` | no | Path to the primer file. |
| `agents` | `string[]` | no | Agent names participating in the deployment. |
| `models` | `Record<string, string>` | no | Map of agent → model. |
| `error` | `string` | no | Error message (sent with `crashed`). |
| `exit_code` | `number` | no | Process exit code. |
| `ticket_id` | `string` | no | Associated ticket id. |
| `provider` | `string` | no | Model provider used. |
| `rating` | [`Rating`](#rating) | no | Session rating (agent/system/user). |
| `objective` | `string` | no | Deployment objective text. |
| `repo` | `string` | no | Repository path. |
| `fallback` | `boolean` | no | Whether the completion marker was a fallback. |
| `resumed_from_deployment_id` | `string` | no | If this deployment resumed a prior one, the prior deployment id. |
| `runtime` | [`RuntimeName`](#runtimename) | no | Runtime that executed the deployment. |
| `binary` | `string` | no | Binary path that was spawned. |
| `effective_timeout_seconds` | `number` | no | Resolved timeout in seconds. |

### `DeploymentStatus`

The computed status of a deployment, aggregated from its `RegistryEvent` sequence. Stored in the `deployments` table.

```typescript
interface DeploymentStatus {
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
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `deploy_id` | `string` | yes | The deployment id. |
| `team` | `string` | yes | Team name. |
| `status` | `string` | yes | Computed status: `running`, `success`, `partial`, `failed`, `crashed`, `dead`, `unknown`. |
| `started_at` | `string` | yes | ISO 8601 timestamp of the `started` event. |
| `completed_at` | `string` | no | ISO 8601 timestamp of `completed`/`crashed`. |
| `pid` | `number` | no | Process id (from the `pid` event). |
| `agents` | `string[]` | yes | Agent names (from the `started` event). Empty array if unknown. |
| `summary` | `string` | no | Completion summary. |
| `log_file` | `string` | no | Session log file path. |
| `primer` | `string` | no | Primer file path. |
| `ticket_id` | `string` | no | Associated ticket id. |
| `objective` | `string` | no | Deployment objective text. |
| `models` | `Record<string, string>` | no | Agent → model map. |
| `provider` | `string` | no | Model provider. |
| `repo` | `string` | no | Repository path. |
| `fallback` | `boolean` | no | Whether the completion was a fallback. |
| `resumed_from_deployment_id` | `string` | no | Prior deployment id if resumed. |
| `runtime` | [`RuntimeName`](#runtimename) | no | Runtime. |
| `binary` | `string` | no | Binary path. |
| `effective_timeout_seconds` | `number` | no | Resolved timeout in seconds. |

### `Rating`

A session rating assigned by an agent, the system, or the user.

```typescript
interface Rating {
  source: "agent" | "system" | "user";
  overall: number;
  productivity?: number;
  quality?: number;
  efficiency?: number;
  insight?: number;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | `"agent" \| "system" \| "user"` | yes | Who produced the rating. |
| `overall` | `number` | yes | Overall rating (0–5). |
| `productivity` | `number` | no | Productivity sub-score (0–5). |
| `quality` | `number` | no | Quality sub-score (0–5). |
| `efficiency` | `number` | no | Efficiency sub-score (0–5). |
| `insight` | `number` | no | Insight sub-score (0–5). |

### `EvaluatorRating` / `EvaluatorResult`

The evaluator system produces structured ratings for deployments.

```typescript
type EvaluatorMetricName =
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

interface EvaluatorRating {
  source: "system" | "user";
  overall: number;
  metrics: Partial<Record<EvaluatorMetricName, number>>;
}

interface EvaluatorResult {
  target_deployment_id: string;
  evaluator_deployment_id: string;
  summary?: string;
  report_path?: string;
  evidence_refs: string[];
  findings?: string;
  rating: EvaluatorRating;
  created_at: string;
}
```

| `EvaluatorResult` field | Type | Required | Description |
|-------------------------|------|----------|-------------|
| `target_deployment_id` | `string` | yes | The deployment being evaluated. |
| `evaluator_deployment_id` | `string` | yes | The deployment that ran the evaluation. |
| `summary` | `string` | no | Evaluation summary. |
| `report_path` | `string` | no | Path to the full report. |
| `evidence_refs` | `string[]` | yes | Evidence references. Empty array if none. |
| `findings` | `string` | no | Free-text findings. |
| `rating` | [`EvaluatorRating`](#evaluatorrating--evaluatorresult) | yes | The structured rating. |
| `created_at` | `string` | yes | ISO 8601 timestamp. |

---

## Health

The health system computes a weighted score across six categories and records snapshots for trend analysis.

> **Source:** `packages/pa-core/src/health/types.ts`

### `HealthReport`

The top-level health report returned by `GET /api/health`.

```typescript
interface HealthReport {
  overallScore: number;
  scoreLabel: "healthy" | "warning" | "unhealthy";
  categories: CategoryResult[];
  window: HealthWindow;
  generatedAt: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `overallScore` | `number` | yes | Weighted overall score (0–100). |
| `scoreLabel` | `"healthy" \| "warning" \| "unhealthy"` | yes | Label derived from `overallScore` vs. thresholds. |
| `categories` | [`CategoryResult[]`](#categoryresult) | yes | Per-category results. |
| `window` | [`HealthWindow`](#healthwindow) | yes | The time window the report covers. |
| `generatedAt` | `string` | yes | ISO 8601 timestamp of report generation. |

### `CategoryResult`

```typescript
type FindingSeverity = "pass" | "warn" | "fail";
type HealthCategory = "deployments" | "agents" | "tickets" | "compliance" | "schedules" | "infrastructure";

interface HealthFinding {
  severity: FindingSeverity;
  category: HealthCategory;
  message: string;
  details?: string;
}

interface CategoryResult {
  name: HealthCategory;
  score: number;
  findings: HealthFinding[];
  stats?: Record<string, number | string | boolean>;
}
```

| `HealthFinding` field | Type | Required | Description |
|------------------------|------|----------|-------------|
| `severity` | `"pass" \| "warn" \| "fail"` | yes | Severity of the finding. |
| `category` | [`HealthCategory`](#categoryresult) | yes | The category this finding belongs to. |
| `message` | `string` | yes | Short message. |
| `details` | `string` | no | Longer details. |

| `CategoryResult` field | Type | Required | Description |
|-------------------------|------|----------|-------------|
| `name` | `"deployments" \| "agents" \| "tickets" \| "compliance" \| "schedules" \| "infrastructure"` | yes | Category name. |
| `score` | `number` | yes | Category score (0–100). |
| `findings` | [`HealthFinding[]`](#categoryresult) | yes | Findings for this category. |
| `stats` | `Record<string, number \| string \| boolean>` | no | Additional category statistics. |

### `HealthWindow`

```typescript
interface HealthWindow {
  since: string;
  until: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `since` | `string` | yes | ISO 8601 timestamp — start of the window. |
| `until` | `string` | yes | ISO 8601 timestamp — end of the window. |

### `HealthConfig`

```typescript
interface HealthConfig {
  weights: Partial<Record<HealthCategory, number>>;
  thresholds: {
    healthy: number;
    warning: number;
  };
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `weights` | `Partial<Record<HealthCategory, number>>` | yes | Per-category weights for the overall score. |
| `thresholds.healthy` | `number` | yes | Minimum `overallScore` for `healthy`. |
| `thresholds.warning` | `number` | yes | Minimum `overallScore` for `warning` (below this = `unhealthy`). |

### `HealthSnapshot`

A persisted point-in-time snapshot of a health report, stored for trend analysis.

```typescript
interface HealthSnapshot {
  id: number;
  timestamp: string;
  overallScore: number;
  windowSince: string;
  windowUntil: string;
  categories: Array<{ name: HealthCategory; score: number; findingsCount: number }>;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `number` | yes | Snapshot id (auto-increment). |
| `timestamp` | `string` | yes | ISO 8601 timestamp when the snapshot was recorded. |
| `overallScore` | `number` | yes | Overall score at snapshot time. |
| `windowSince` | `string` | yes | Window start. |
| `windowUntil` | `string` | yes | Window end. |
| `categories` | `Array<{ name: HealthCategory; score: number; findingsCount: number }>` | yes | Per-category summary (name, score, findings count). |

### `HealthActivityEvent` / `ActivityAnalysis`

Activity-log analysis types used by the agents health category.

```typescript
interface HealthActivityEvent {
  ts: string;
  deploy_id: string;
  agent: string;
  agent_type?: string;
  event: string;
  data: Record<string, unknown>;
}

interface ActivityAnalysis {
  deployId: string;
  totalCalls: number;
  failures: number;
  errorRate: number;
  errorLoops: Array<{ agent: string; consecutiveCount: number; firstTs: string }>;
}
```

| `HealthActivityEvent` field | Type | Required | Description |
|------------------------------|------|----------|-------------|
| `ts` | `string` | yes | ISO 8601 timestamp. |
| `deploy_id` | `string` | yes | Deployment id. |
| `agent` | `string` | yes | Agent name. |
| `agent_type` | `string` | no | Agent type (e.g. `team-manager`). |
| `event` | `string` | yes | Event name. |
| `data` | `Record<string, unknown>` | yes | Event payload. |

| `ActivityAnalysis` field | Type | Required | Description |
|--------------------------|------|----------|-------------|
| `deployId` | `string` | yes | Deployment id. |
| `totalCalls` | `number` | yes | Total tool calls. |
| `failures` | `number` | yes | Number of failed calls. |
| `errorRate` | `number` | yes | `failures / totalCalls`. |
| `errorLoops` | `Array<{ agent: string; consecutiveCount: number; firstTs: string }>` | yes | Detected consecutive-error loops per agent. |

---

## Signal

Signal Desktop integration types for extracting "Note to Self" messages and routing them to PA destinations.

> **Source:** `packages/pa-core/src/signal/types.ts`

### `SignalConversation`

```typescript
interface SignalConversation {
  id: string;
  type: string;
  name: string | null;
  profileName: string | null;
  profileFullName: string | null;
  e164: string | null;
  serviceId: string | null;
  active_at: number | null;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Conversation id. |
| `type` | `string` | yes | Conversation type (e.g. `private`, `group`). |
| `name` | `string \| null` | yes | Conversation name (nullable). |
| `profileName` | `string \| null` | yes | Profile name (nullable). |
| `profileFullName` | `string \| null` | yes | Full profile name (nullable). |
| `e164` | `string \| null` | yes | E.164 phone number (nullable). |
| `serviceId` | `string \| null` | yes | Service id (nullable). |
| `active_at` | `number \| null` | yes | Active-at timestamp (epoch ms, nullable). |

### `SignalMessage`

```typescript
interface SignalMessage {
  id: string;
  conversationId: string;
  sent_at: number;
  received_at: number;
  type: string;
  body: string | null;
  hasAttachments: number;
  hasFileAttachments: number;
  hasVisualMediaAttachments: number;
  sourceServiceId: string | null;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Message id. |
| `conversationId` | `string` | yes | Conversation id. |
| `sent_at` | `number` | yes | Sent-at timestamp (epoch ms). |
| `received_at` | `number` | yes | Received-at timestamp (epoch ms). |
| `type` | `string` | yes | Message type. |
| `body` | `string \| null` | yes | Message body (nullable). |
| `hasAttachments` | `number` | yes | 1 if the message has any attachment, 0 otherwise. |
| `hasFileAttachments` | `number` | yes | 1 if the message has file attachments, 0 otherwise. |
| `hasVisualMediaAttachments` | `number` | yes | 1 if the message has visual media, 0 otherwise. |
| `sourceServiceId` | `string \| null` | yes | Source service id (nullable). |

### `AttachmentMeta`

```typescript
interface AttachmentMeta {
  messageId: string;
  contentType: string;
  path: string | null;
  fileName: string | null;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  attachmentType: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `messageId` | `string` | yes | The message the attachment belongs to. |
| `contentType` | `string` | yes | MIME type. |
| `path` | `string \| null` | yes | File path on disk (nullable). |
| `fileName` | `string \| null` | yes | Original filename (nullable). |
| `size` | `number` | yes | Size in bytes. |
| `width` | `number \| null` | yes | Pixel width (for images/video, nullable). |
| `height` | `number \| null` | yes | Pixel height (for images/video, nullable). |
| `duration` | `number \| null` | yes | Duration in seconds (for audio/video, nullable). |
| `attachmentType` | `string` | yes | Attachment category. |

### `SignalAccountIdentity`

```typescript
interface SignalAccountIdentity {
  e164: string;
  uuid: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `e164` | `string` | yes | E.164 phone number of the local account. |
| `uuid` | `string` | yes | UUID of the local account. |

### `NoteToSelfMessage`

```typescript
interface NoteToSelfMessage {
  id: string;
  conversationId: string;
  sentAt: number;
  body: string | null;
  attachments: AttachmentMeta[];
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Message id. |
| `conversationId` | `string` | yes | The Note to Self conversation id. |
| `sentAt` | `number` | yes | Sent-at timestamp (epoch ms). |
| `body` | `string \| null` | yes | Message body (nullable). |
| `attachments` | [`AttachmentMeta[]`](#attachmentmeta) | yes | Attachments. Empty array if none. |

### `SignalCollectorState`

```typescript
interface SignalCollectorState {
  lastProcessedAt: number;
  lastRunAt: string | null;
  totalProcessed: number;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `lastProcessedAt` | `number` | yes | Timestamp of the last processed message (epoch ms). |
| `lastRunAt` | `string \| null` | yes | ISO 8601 timestamp of the last collector run (nullable). |
| `totalProcessed` | `number` | yes | Total messages processed. |

### `PrefixTag` / `RouteDestination` / `RoutingResult`

Routing types used to dispatch Note to Self messages to PA destinations.

```typescript
type PrefixTag = "idea" | "task" | "learn" | "yt" | "buy" | "link" | "secret";

type RouteDestination =
  | "ticket-idea"
  | "ticket-task"
  | "ticket-buy"
  | "youtube-queue"
  | "spike-queue"
  | "bookmark"
  | "sensitive"
  | "daily-log"
  | "attachment-only";

interface RoutingResult {
  destination: RouteDestination;
  content: string;
  tag: PrefixTag | null;
  detectedUrl: string | null;
  sensitiveDetected: boolean;
  attachmentOnly: boolean;
  attachmentPaths: string[];
}
```

| `RoutingResult` field | Type | Required | Description |
|----------------------|------|----------|-------------|
| `destination` | [`RouteDestination`](#prefixtag--routedestination--routingresult) | yes | Where the message was routed. |
| `content` | `string` | yes | The routed content. |
| `tag` | [`PrefixTag`](#prefixtag--routedestination--routingresult) \| `null` | yes | Detected prefix tag, or `null`. |
| `detectedUrl` | `string \| null` | yes | First URL found in the body, or `null`. |
| `sensitiveDetected` | `boolean` | yes | Whether sensitive content was detected. |
| `attachmentOnly` | `boolean` | yes | Whether the message is attachment-only (no body). |
| `attachmentPaths` | `string[]` | yes | Paths to saved attachments. Empty array if none. |

### `ParsedSignalNote`

```typescript
interface ParsedSignalNote {
  frontmatter: Record<string, string>;
  body: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `frontmatter` | `Record<string, string>` | yes | Parsed YAML frontmatter (string-valued). |
| `body` | `string` | yes | Markdown body after the frontmatter. |

---

## CodeCtx

The CodeCtx system parses a repository's source code into a graph of nodes (files, functions, classes, etc.) and edges (imports, calls, extends, etc.) for code-context retrieval.

> **Source:** `packages/pa-core/src/codectx/types.ts` — `SCHEMA_VERSION = "1.0.0"`

### `CodeGraph`

The top-level graph object.

```typescript
const SCHEMA_VERSION = "1.0.0";

interface CodeGraph {
  schemaVersion: string;
  repo: string;
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
  nodes: Record<string, GraphNode>;
  edges: Record<string, GraphEdge>;
  fileIndex: Record<string, string[]>;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | `string` | yes | Schema version — currently `"1.0.0"`. |
| `repo` | `string` | yes | Repository path or name. |
| `generatedAt` | `string` | yes | ISO 8601 timestamp of generation. |
| `nodeCount` | `number` | yes | Number of nodes in `nodes`. |
| `edgeCount` | `number` | yes | Number of edges in `edges`. |
| `nodes` | `Record<string, GraphNode>` | yes | Map of node id → [`GraphNode`](#graphnode). |
| `edges` | `Record<string, GraphEdge>` | yes | Map of edge id → [`GraphEdge`](#graphedge). |
| `fileIndex` | `Record<string, string[]>` | yes | Map of file path → array of node ids in that file. |

### `GraphNode`

```typescript
interface GraphNode {
  id: string;
  type: "file" | "function" | "class" | "method" | "interface" | "type" | "enum";
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  exports?: string[];
  imports?: string[];
  children?: string[];
  metadata?: Record<string, unknown>;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Unique node id. |
| `type` | `"file" \| "function" \| "class" \| "method" \| "interface" \| "type" \| "enum"` | yes | Node kind. |
| `name` | `string` | yes | Symbol name. |
| `file` | `string` | yes | Source file path. |
| `startLine` | `number` | yes | First line (1-indexed). |
| `endLine` | `number` | yes | Last line (1-indexed). |
| `exports` | `string[]` | no | Exported symbol names. |
| `imports` | `string[]` | no | Imported symbol names / paths. |
| `children` | `string[]` | no | Child node ids (for classes/files). |
| `metadata` | `Record<string, unknown>` | no | Extra metadata. |

### `GraphEdge`

```typescript
interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: "imports" | "calls" | "extends" | "implements" | "member-of";
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Unique edge id. |
| `source` | `string` | yes | Source node id. |
| `target` | `string` | yes | Target node id. |
| `type` | `"imports" \| "calls" \| "extends" \| "implements" \| "member-of"` | yes | Edge kind. |

### `ParseResult`

```typescript
interface ParseResult {
  file: string;
  success: boolean;
  error?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | yes | Parsed file path. |
| `success` | `boolean` | yes | Whether parsing succeeded. |
| `error` | `string` | no | Error message (when `success` is false). |
| `nodes` | [`GraphNode[]`](#graphnode) | yes | Nodes extracted from the file. |
| `edges` | [`GraphEdge[]`](#graphedge) | yes | Edges extracted from the file. |

### `GraphStats`

```typescript
interface GraphStats {
  files: number;
  functions: number;
  classes: number;
  methods: number;
  interfaces: number;
  types: number;
  enums: number;
  edges: number;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `files` | `number` | yes | Total file nodes. |
| `functions` | `number` | yes | Total function nodes. |
| `classes` | `number` | yes | Total class nodes. |
| `methods` | `number` | yes | Total method nodes. |
| `interfaces` | `number` | yes | Total interface nodes. |
| `types` | `number` | yes | Total type nodes. |
| `enums` | `number` | yes | Total enum nodes. |
| `edges` | `number` | yes | Total edges. |

---

## Activity

The activity log records every event produced by a running deployment as JSONL (`activity.jsonl` in the deployment directory).

> **Source:** `packages/pa-core/src/activity/index.ts`

### `ActivityEvent`

```typescript
type ActivityKind = "thinking" | "text" | "tool_use" | "tool_result" | "error";

interface ActivityEvent {
  deployId: string;
  timestamp: string;
  kind: ActivityKind;
  source: RuntimeName | string;
  body: string;
  partType?: string;
  metadata?: Record<string, unknown>;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `deployId` | `string` | yes | Deployment id. |
| `timestamp` | `string` | yes | ISO 8601 UTC timestamp. |
| `kind` | `"thinking" \| "text" \| "tool_use" \| "tool_result" \| "error"` | yes | Activity kind. |
| `source` | [`RuntimeName`](#runtimename) \| `string` | yes | Source runtime or agent name. |
| `body` | `string` | yes | Event body (truncated to 500 chars, secrets masked). |
| `partType` | `string` | no | Message part type (e.g. `text`, `thinking`, `tool_use`). |
| `metadata` | `Record<string, unknown>` | no | Extra event metadata. |

### `ActivitySummary`

```typescript
interface ActivitySummary {
  deployId: string;
  total: number;
  byKind: Record<ActivityKind, number>;
  bySource: Record<string, number>;
  firstTimestamp?: string;
  lastTimestamp?: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `deployId` | `string` | yes | Deployment id. |
| `total` | `number` | yes | Total events. |
| `byKind` | `Record<ActivityKind, number>` | yes | Count per kind (all five kinds always present, zero if none). |
| `bySource` | `Record<string, number>` | yes | Count per source. |
| `firstTimestamp` | `string` | no | Earliest event timestamp. |
| `lastTimestamp` | `string` | no | Latest event timestamp. |

---

## Session

Session types for interactive opencode sessions and deploy sessions managed by the Agent API.

> **Source:** `packages/pa-core/src/agent-api/ws/session-hub.ts`

### `SessionRecord`

```typescript
type SessionStatus = "running" | "stopping";

interface SessionRecord {
  id: string;
  model: string;
  status: SessionStatus;
  startedAt: string;
  deploymentId: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Server-allocated session id (format `s<base36-timestamp>-<base36-counter>`). |
| `model` | `string` | yes | Model name passed to opencode (`-m`). |
| `status` | `"running" \| "stopping"` | yes | Current session status. |
| `startedAt` | `string` | yes | ISO 8601 UTC timestamp. |
| `deploymentId` | `string` | yes | Deployment id. For spawned sessions defaults to `session-<id>` unless overridden; for deploy sessions, the deployment id passed to `register`. |

### `SessionStreamEvent`

```typescript
type SessionEventKind = "event" | "error" | "session-id" | "end";

interface SessionStreamEvent {
  type: SessionEventKind;
  data?: Record<string, unknown>;
  message?: string;
  sessionId?: string;
  timestamp: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"event" \| "error" \| "session-id" \| "end"` | yes | Event kind. |
| `data` | `Record<string, unknown>` | no | Event payload (present on `event` and `end`). |
| `message` | `string` | no | Error message (present on `error`). |
| `sessionId` | `string` | no | Session id (present on `session-id`). |
| `timestamp` | `string` | yes | ISO 8601 UTC timestamp. |

---

## Platform Config

Types for platform configuration, teams, and deploy modes.

> **Source:** `packages/pa-core/src/types.ts`

### `PlatformConfig`

```typescript
interface PlatformConfig {
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
    droidcode?: { model?: string; autonomy?: AutonomyLevel };
  };
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `configDir` | `string` | yes | Config directory path. |
| `dataDir` | `string` | yes | Data directory path. |
| `homeDir` | `string` | yes | Home directory path. |
| `teamsDir` | `string` | yes | Teams directory path. |
| `skillsDir` | `string` | yes | Skills directory path. |
| `provider_defaults` | [`ProviderDefaults`](#providerdefaults) | no | Provider/model defaults. |
| `defaults.runtime` | [`RuntimeName`](#runtimename) | no | Default runtime. |
| `defaults.opencode` | `{ provider?: string; model?: string }` | no | opencode defaults. |
| `defaults.claudecode` | `{ model?: string; minimax_via_claude?: boolean }` | no | claudecode defaults. |
| `defaults.droidcode` | `{ model?: string; autonomy?: AutonomyLevel }` | no | droidcode defaults. |

### `ProviderDefaults`

```typescript
interface ProviderDefaults {
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
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `default_provider` | `string` | no | Default provider name. |
| `default_model` | `string` | no | Default model name. |
| `providers` | `object` | no | Per-provider config (anthropic, minimax, openai, deepseek, ollama-cloud, factory). |
| `providers.*.base_url` | `string` | no | Provider base URL. |
| `providers.*.models` | [`ProviderModelTier`](#providermodeltier) | no | Model tier mapping. |
| `providers.factory.api_key` | `string` | no | Factory API key. |

### `ProviderModelTier`

```typescript
interface ProviderModelTier {
  sonnet?: string;
  opus?: string;
  haiku?: string;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sonnet` | `string` | no | Sonnet-tier model name. |
| `opus` | `string` | no | Opus-tier model name. |
| `haiku` | `string` | no | Haiku-tier model name. |

### `TeamConfig`

```typescript
interface TeamConfig {
  name: string;
  description: string;
  context?: { organization?: string; notes?: string };
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
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Team name. |
| `description` | `string` | yes | Team description. |
| `context` | `{ organization?: string; notes?: string }` | no | Team context. |
| `variables` | `Record<string, string>` | no | Team variables. |
| `agents` | [`Agent[]`](#agent) | yes | Agents on the team. |
| `objective` | `string` | yes | Default deployment objective. |
| `model` | `string` | no | Team-level model override. |
| `deploy_modes` | [`DeployMode[]`](#deploymode) | no | Available deploy modes. |
| `default_mode` | `string` | no | Default mode id. |
| `hierarchy` | [`Hierarchy`](#hierarchy) | no | Team hierarchy. |
| `timeout` | `number` | no | Team timeout (seconds). |
| `global_docs` | `string[]` | no | Global doc paths injected into primers. |
| `terse_mode` | `boolean` | no | Enable terse mode for the team. |

### `Agent`

```typescript
interface Agent {
  name: string;
  role: string;
  instruction?: string;
  skill?: string;
  model?: ModelName;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Agent name. |
| `role` | `string` | yes | Agent role description. |
| `instruction` | `string` | no | Custom instruction text. |
| `skill` | `string` | no | Skill file path. |
| `model` | `string` | no | Agent-level model override. |

### `DeployMode`

```typescript
interface DeployMode {
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
  require_ticket?: boolean;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Mode id. |
| `label` | `string` | yes | Display label. |
| `phone_visible` | `boolean` | no | Whether the mode is visible in the phone app. |
| `objective` | `string` | no | Mode-specific objective. |
| `agents` | `string[]` | no | Agents to deploy. |
| `skills` | [`SkillEntry[]`](#skillentry) | no | Skills to inject. |
| `mode_type` | `"housekeeping" \| "work" \| "interactive"` | no | Mode category. |
| `solo` | `boolean` | no | Whether the mode runs a single agent. |
| `model` | `string` | no | Flat mode model; required together with `provider` when either is set. |
| `provider` | `string` | no | Flat mode provider; required together with `model` when either is set. |
| `timeout` | `number` | no | Timeout (seconds). |
| `global_docs` | `string[]` | no | Global doc paths. |
| `require_ticket` | `boolean` | no | Whether a ticket id is required to deploy. |

### `SkillEntry`

```typescript
interface SkillEntry {
  name: string;
  "inject-as": "global-skill" | "shared-skill" | "reference";
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Skill name. |
| `inject-as` | `"global-skill" \| "shared-skill" \| "reference"` | yes | How the skill is injected into the primer. |

### `Hierarchy`

```typescript
interface HierarchyMember {
  role?: string;
  participates_in?: "all" | string[];
}

interface Hierarchy {
  "team-manager"?: HierarchyMember;
  agents?: Array<{ name: string } & HierarchyMember>;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `team-manager` | [`HierarchyMember`](#hierarchy) | no | Team manager config. |
| `agents` | `Array<{ name: string } & HierarchyMember>` | no | Per-agent hierarchy entries. |

| `HierarchyMember` field | Type | Required | Description |
|-------------------------|------|----------|-------------|
| `role` | `string` | no | Member role. |
| `participates_in` | `"all" \| string[]` | no | Which phases the member participates in. |

### Flat provider/model contract

`DeployMode.provider` and `DeployMode.model` are flat, runtime-neutral fields.
They must both be present or both be absent. An absent pair delegates to the
selected adapter default. Team-level and mode-level runtime maps are removed;
`parseTeamYaml` rejects them and reports the YAML path.