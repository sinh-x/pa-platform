# Examples & Recipes

> **Prerequisites:** Server running on `http://127.0.0.1:9848` (start with `pa-core serve` or `opa serve`).
> **Last updated:** 2026-08-13

Runnable `curl` and TypeScript code examples for common workflows against the pa-platform Agent API. All examples use the default local server at `http://127.0.0.1:9848`.

---

## Prerequisites

### Start the Server

```bash
# Start the Agent API server (loopback, port 9848)
pa-core serve

# Or with CORS enabled for browser access
pa-core serve --cors

# Or in background mode
pa-core serve --background

# Check server status
pa-core serve-status
```

### Base URL

All examples use:

```
http://127.0.0.1:9848
```

---

## 1. Deploy a Team

Deploy an agent team in background mode and receive a deployment ID for tracking.

### curl

```bash
# Deploy the builder team in implement mode with an objective
curl -s -X POST http://127.0.0.1:9848/api/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "team": "builder",
    "mode": "implement",
    "objective": "Fix the login bug in the auth module",
    "repo": "pa",
    "ticket": "PAP-132",
    "timeout": 1800
  }' | jq .
```

**Response (202 Accepted):**

```json
{
  "team": "builder",
  "mode": "implement",
  "status": "pending",
  "deployment_id": "d-a1b2c3"
}
```

**Dry-run validation (no deployment triggered):**

```bash
curl -s -X POST http://127.0.0.1:9848/api/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "team": "builder",
    "mode": "implement",
    "objective": "Fix the login bug",
    "dryRun": true
  }' | jq .
```

### TypeScript

```typescript
const response = await fetch("http://127.0.0.1:9848/api/deploy", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    team: "builder",
    mode: "implement",
    objective: "Fix the login bug in the auth module",
    repo: "pa",
    ticket: "PAP-132",
    timeout: 1800,
  }),
});

const result = await response.json();
console.log(result);
// { team: "builder", mode: "implement", status: "pending", deployment_id: "d-a1b2c3" }
```

### Notes

- `POST /api/deploy` always returns HTTP `202` (even on adapter failure — never `500`). Check the `status` field in the response body: `"pending"` (success), `"success"`, or `"failed"`.
- `background` defaults to `true` when omitted. Use `"dryRun": true` for validation without deployment (mutually exclusive with `background`).
- The `objective` field is sanitized — control characters and shell metacharacters (`$`, `\`, `;`, `&`) are stripped.
- The `deployment_id` from the response is used to track deployment status (see Example 3).

---

## 2. List Tickets

Query tickets filtered by project, status, assignee, priority, type, tags, or search text.

### curl

```bash
# List all tickets for the pa-platform project
curl -s "http://127.0.0.1:9848/api/tickets?project=pa-platform" | jq .

# List tickets with status filter
curl -s "http://127.0.0.1:9848/api/tickets?project=pa-platform&status=implementing" | jq .

# List tickets assigned to a specific agent
curl -s "http://127.0.0.1:9848/api/tickets?assignee=builder/team-manager&status=pending-implementation" | jq .

# List high-priority bugs
curl -s "http://127.0.0.1:9848/api/tickets?priority=high&type=bug" | jq .

# Search tickets by text
curl -s "http://127.0.0.1:9848/api/tickets?search=api+documentation" | jq .

# Filter by tags (comma-separated, ticket must include ALL tags)
curl -s "http://127.0.0.1:9848/api/tickets?tags=api,documentation" | jq .

# Exclude tickets with certain tags
curl -s "http://127.0.0.1:9848/api/tickets?excludeTags=failed,archived" | jq .
```

**Response (200 OK):**

```json
{
  "tickets": [
    {
      "id": "PAP-132",
      "project": "pa-platform",
      "title": "API Documentation",
      "summary": "Comprehensive API documentation for pa-platform",
      "description": "",
      "status": "implementing",
      "priority": "high",
      "type": "feature",
      "assignee": "builder/team-manager",
      "estimate": "M",
      "from": "",
      "to": "",
      "tags": [],
      "blockedBy": [],
      "doc_refs": [],
      "linkedBranches": [],
      "linkedCommits": [],
      "comments": [],
      "subTickets": [],
      "nextSubTicketCounter": 1,
      "createdAt": "2026-08-13T00:55:11.000Z",
      "updatedAt": "2026-08-13T01:35:18.000Z",
      "resolvedAt": null
    }
  ],
  "count": 1
}
```

### TypeScript

```typescript
const params = new URLSearchParams({
  project: "pa-platform",
  status: "implementing",
});

const response = await fetch(
  `http://127.0.0.1:9848/api/tickets?${params.toString()}`
);

const { tickets, count } = await response.json();
console.log(`Found ${count} ticket(s):`);
for (const ticket of tickets) {
  console.log(`  ${ticket.id} [${ticket.status}] ${ticket.title}`);
}
```

### Notes

- `GET /api/tickets` has **no pagination** — all matching tickets are returned, sorted by `updatedAt` descending.
- Query parameters are all optional. Unknown `status`/`priority`/`type` values simply return an empty array (`count: 0`).
- The `tags` parameter is comma-separated; the ticket must include **all** listed tags to match.
- The `search` parameter does a case-insensitive substring match across `id`, `title`, `summary`, and `description`.

---

## 3. Check Deployment Status

Check the status of a deployment by its ID.

### curl

```bash
# Check status of deployment d-a1b2c3
curl -s "http://127.0.0.1:9848/api/deploy/status/d-a1b2c3" | jq .
```

**Response — running (200 OK):**

```json
{
  "status": {
    "deploy_id": "d-a1b2c3",
    "team": "builder",
    "status": "running",
    "started_at": "2026-08-13T10:00:00.000Z",
    "pid": 12345,
    "agents": ["builder-agent"],
    "ticket_id": "PAP-132",
    "objective": "Fix the login bug in the auth module"
  }
}
```

**Response — completed (200 OK):**

```json
{
  "status": {
    "deploy_id": "d-a1b2c3",
    "team": "builder",
    "status": "success",
    "started_at": "2026-08-13T10:00:00.000Z",
    "completed_at": "2026-08-13T10:15:00.000Z",
    "pid": 12345,
    "agents": ["builder-agent"],
    "summary": "Implementation complete. All phases verified.",
    "ticket_id": "PAP-132"
  }
}
```

**Response — not found (404):**

```json
{
  "error": "Deployment not found",
  "code": "NOT_FOUND"
}
```

### TypeScript

```typescript
async function checkDeploymentStatus(deployId: string): Promise<void> {
  const response = await fetch(
    `http://127.0.0.1:9848/api/deploy/status/${deployId}`
  );

  if (response.status === 404) {
    console.log(`Deployment ${deployId} not found.`);
    return;
  }

  const { status } = await response.json();
  console.log(`Deployment ${status.deploy_id}: ${status.status}`);
  console.log(`  Team:    ${status.team}`);
  console.log(`  Started: ${status.started_at}`);

  if (status.completed_at) {
    console.log(`  Ended:   ${status.completed_at}`);
  }

  if (status.summary) {
    console.log(`  Summary: ${status.summary}`);
  }
}

// Poll until complete
async function waitForDeployment(deployId: string, intervalMs = 5000): Promise<void> {
  while (true) {
    const response = await fetch(
      `http://127.0.0.1:9848/api/deploy/status/${deployId}`
    );
    if (!response.ok) throw new Error(`Status check failed: ${response.status}`);

    const { status } = await response.json();
    console.log(`[${new Date().toISOString()}] ${status.status}`);

    if (["success", "partial", "failed", "crashed", "dead"].includes(status.status)) {
      console.log("Deployment finished:", status.summary ?? "(no summary)");
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

await waitForDeployment("d-a1b2c3");
```

### Notes

- `GET /api/deploy/status/:id` returns the full `DeploymentStatus` object.
- The `status` field can be: `"running"`, `"success"`, `"partial"`, `"failed"`, `"crashed"`, `"dead"`, or `"unknown"`.
- Terminal states: `success`, `partial`, `failed`, `crashed`, `dead`. Non-terminal: `running`, `unknown`.
- The endpoint does not validate the ID format — an unknown ID simply returns `404`.

---

## 4. Health Check

Verify the server is running and responsive.

### curl

```bash
curl -s http://127.0.0.1:9848/api/health | jq .
```

**Response (200 OK):**

```json
{
  "status": "ok"
}
```

### TypeScript

```typescript
const response = await fetch("http://127.0.0.1:9848/api/health");
const { status } = await response.json();
console.log(`Server health: ${status}`);
// Server health: ok
```

---

## 5. List Projects

List all registered repositories (projects) in the platform.

### curl

```bash
curl -s http://127.0.0.1:9848/api/projects | jq .
```

**Response (200 OK):**

```json
{
  "projects": [
    {
      "key": "pa",
      "prefix": "PAP",
      "description": "PA platform runtime and tooling",
      "path": "/home/sinh/git-repos/sinh-x/tools/pa-platform",
      "activeTicketCount": 3
    },
    {
      "key": "avodah",
      "prefix": "AVO",
      "description": "Avodah task and time tracking",
      "path": "/home/sinh/git-repos/sinh-x/tools/avodah",
      "activeTicketCount": 1
    }
  ]
}
```

### TypeScript

```typescript
const response = await fetch("http://127.0.0.1:9848/api/projects");
const { projects } = await response.json();

for (const project of projects) {
  console.log(`${project.key} (${project.prefix}): ${project.description} — ${project.activeTicketCount} active tickets @ ${project.path}`);
}
```

---

## 6. Create a Ticket

Create a new ticket via the API.

### curl

```bash
curl -s -X POST http://127.0.0.1:9848/api/tickets \
  -H "Content-Type: application/json" \
  -d '{
    "project": "pa",
    "title": "Add WebSocket reconnection tests",
    "type": "feature",
    "priority": "medium",
    "estimate": "S",
    "assignee": "builder/team-manager",
    "summary": "Add tests for WebSocket client reconnection scenarios"
  }' | jq .
```

**Response (201 Created):**

```json
{
  "ticket": {
    "id": "PAP-133",
    "project": "pa",
    "title": "Add WebSocket reconnection tests",
    "summary": "Add tests for WebSocket client reconnection scenarios",
    "description": "",
    "status": "idea",
    "priority": "medium",
    "type": "feature",
    "assignee": "builder/team-manager",
    "estimate": "S",
    "from": "",
    "to": "",
    "tags": [],
    "blockedBy": [],
    "doc_refs": [],
    "linkedBranches": [],
    "linkedCommits": [],
    "comments": [],
    "subTickets": [],
    "nextSubTicketCounter": 1,
    "createdAt": "2026-08-13T12:00:00.000Z",
    "updatedAt": "2026-08-13T12:00:00.000Z",
    "resolvedAt": null
  }
}
```

### TypeScript

```typescript
const response = await fetch("http://127.0.0.1:9848/api/tickets", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    project: "pa",
    title: "Add WebSocket reconnection tests",
    type: "feature",
    priority: "medium",
    estimate: "S",
    assignee: "builder/team-manager",
    summary: "Add tests for WebSocket client reconnection scenarios",
  }),
});

const { ticket } = await response.json();
console.log(`Created ticket: ${ticket.id} — ${ticket.title}`);
```

---

## 7. Subscribe to WebSocket Events

Connect to the WebSocket hub to receive real-time platform events.

### JavaScript (Browser)

```javascript
const ws = new WebSocket("ws://127.0.0.1:9848/ws");

ws.onopen = () => console.log("Connected to PA hub");

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(`[${data.type}]`, data);

  // Event types: new-inbox-item, inbox-item-moved, deployment-status-change,
  //              ticket-changed, bulletin-update, ping
};

ws.onclose = () => console.log("Disconnected from PA hub");
ws.onerror = (err) => console.error("WebSocket error:", err);
```

### Node.js (ws library)

```typescript
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:9848/ws");

ws.on("open", () => console.log("Connected to PA hub"));

ws.on("message", (data: Buffer) => {
  const event = JSON.parse(data.toString());
  console.log(`[${event.type}]`, event);
});

ws.on("close", () => console.log("Disconnected from PA hub"));
ws.on("error", (err: Error) => console.error("WebSocket error:", err));
```

### Event Types

| Type | Payload | Trigger |
|------|---------|---------|
| `new-inbox-item` | `{ filename, title }` | New `.md` file in `sinh-inputs/inbox` |
| `inbox-item-moved` | `{ filename, from, to }` | Previously known inbox `.md` no longer present |
| `deployment-status-change` | spread registry entry | New row appended to the deployment registry |
| `ticket-changed` | `{ ticketId }` | Ticket JSON file created or modified |
| `bulletin-update` | `{ bulletinId }` | Active bulletin `.md` created, modified, or removed |
| `ping` | *(none)* | Server ping (30s interval) |

---

## 8. Complete Deploy + Monitor Workflow

End-to-end workflow: deploy a team, then poll for completion.

### TypeScript

```typescript
const API_BASE = "http://127.0.0.1:9848";

async function deployAndMonitor(): Promise<void> {
  // Step 1: Deploy
  console.log("Deploying builder team...");
  const deployResp = await fetch(`${API_BASE}/api/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      team: "builder",
      mode: "implement",
      objective: "Update API documentation examples section",
      repo: "pa",
      timeout: 1800,
    }),
  });

  const deployResult = await deployResp.json();

  if (deployResult.status === "failed") {
    console.error("Deployment failed immediately:", deployResult.reason);
    return;
  }

  const deployId = deployResult.deployment_id;
  console.log(`Deployment started: ${deployId}`);

  // Step 2: Poll for completion
  const terminalStates = ["success", "partial", "failed", "crashed", "dead"];
  let lastStatus = "";

  while (true) {
    const statusResp = await fetch(`${API_BASE}/api/deploy/status/${deployId}`);
    const { status } = await statusResp.json();

    if (status.status !== lastStatus) {
      console.log(`[${new Date().toISOString()}] ${status.status}`);
      lastStatus = status.status;
    }

    if (terminalStates.includes(status.status)) {
      console.log("\nDeployment complete!");
      console.log(`  Status:  ${status.status}`);
      console.log(`  Started: ${status.started_at}`);
      console.log(`  Ended:   ${status.completed_at ?? "(still running)"}`);
      console.log(`  Summary: ${status.summary ?? "(no summary)"}`);
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

await deployAndMonitor();
```

---

## 9. List Active Bulletins

Check for active blocking bulletins before starting work.

### curl

```bash
curl -s http://127.0.0.1:9848/api/bulletin | jq .
```

**Response (200 OK):**

```json
{
  "bulletins": [
    {
      "id": "B-007",
      "title": "Schema migration in progress",
      "status": "active",
      "block": "all",
      "except": ["maintenance"],
      "created": "2026-08-13T09:00:00.000Z",
      "body": "Wait for PA-100 to complete before deploying.",
      "filename": "B-007-schema-migration.md"
    }
  ],
  "count": 1
}
```

### TypeScript

```typescript
const response = await fetch("http://127.0.0.1:9848/api/bulletin");
const { bulletins, count } = await response.json();

if (count === 0) {
  console.log("No active bulletins.");
} else {
  for (const bulletin of bulletins) {
    console.log(`[${bulletin.id}] ${bulletin.title}`);
    console.log(`  Blocks: ${bulletin.block}`);
    console.log(`  Body: ${bulletin.body}`);
  }
}
```

---

## Cross-References

- [REST API Reference](./rest-api.md) — full endpoint documentation (all 68 endpoints)
- [Data Models](./data-models.md) — type definitions for all response objects
- [Auth & Security](./auth-security.md) — CORS, path traversal, security considerations
- [WebSocket Protocol](./websocket.md) — WebSocket hub events and session protocol
- [CLI Reference](./cli-reference.md) — CLI commands as an alternative to the API