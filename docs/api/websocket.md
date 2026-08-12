# WebSocket Protocol

The pa-platform Agent API exposes two WebSocket endpoints and one SSE stream endpoint for real-time communication. This document covers the hub event protocol (`/ws`), the interactive session protocol (`/ws/session`), and the SSE stream format (`GET /api/sessions/:id/stream`).

> **Source of truth:** `packages/pa-core/src/agent-api/ws/hub.ts`, `packages/pa-core/src/agent-api/ws/session-hub.ts`, `packages/pa-core/src/agent-api/ws/watchers.ts`, `packages/pa-core/src/agent-api/index.ts`, `packages/pa-core/src/agent-api/routes/sessions.ts`.
> **Base URL:** `ws://127.0.0.1:9848`
> **Last updated:** 2026-08-13

## Table of Contents

- [Overview](#overview)
- [Hub Events (`/ws`)](#hub-events-ws)
  - [Event Types (6)](#event-types-6)
  - [Ping / Pong Behavior](#ping--pong-behavior)
  - [Reconnection Notes](#reconnection-notes)
- [Session Protocol (`/ws/session`)](#session-protocol-wssession)
  - [Client Message Types (3)](#client-message-types-3)
  - [Server Stream Events](#server-stream-events)
  - [Session Lifecycle](#session-lifecycle)
  - [Capacity Limits](#capacity-limits)
- [SSE Stream (`GET /api/sessions/:id/stream`)](#sse-stream-get--apisessionsidstream)
- [Type Definitions](#type-definitions)

---

## Overview

| Endpoint | Protocol | Purpose | Source file |
|----------|----------|---------|-------------|
| `/ws` | WebSocket | Hub event broadcast — file-watch and registry-change notifications pushed to all connected clients. | `ws/hub.ts`, `ws/watchers.ts` |
| `/ws/session` | WebSocket | Interactive opencode session — a client sends `start`/`resume`/`stop` messages and receives a stream of session events over the same socket. | `ws/session-hub.ts`, `agent-api/index.ts` |
| `GET /api/sessions/:id/stream` | SSE (Server-Sent Events) | Read-only live stream of an existing session's JSONL events. | `agent-api/routes/sessions.ts` |

The hub (`/ws`) and the session endpoint (`/ws/session`) are independent: a client may connect to either or both. A single shared `WsHub` instance manages all `/ws` clients; a single shared `SessionManager` instance manages all `/ws/session` connections and registered deploy sessions.

---

## Hub Events (`/ws`)

Connect to `ws://127.0.0.1:9848/ws` to receive push notifications when platform files change. The server broadcasts `WsEvent` JSON messages to every connected client. Clients are expected to respond to `ping` events with a `pong` message (see [Ping / Pong Behavior](#ping--pong-behavior)).

### Connection Lifecycle

1. **Open** — the server registers the client with the hub (`hub.addClient(ws)`). No handshake message is sent.
2. **Messages from client** — the server parses each message as JSON; if the parsed object has `type: "pong"`, the hub records a pong timestamp for that client. All other client messages are ignored (non-JSON messages are silently dropped).
3. **Close** — the server removes the client from the hub (`hub.removeClient(ws)`).
4. **Error** — the server removes the client from the hub.

> Live updates are always enabled in `pa-core serve` — the start command hardcodes `enableLiveUpdates: true` when creating the app (see [server-lifecycle.md §5.1](./server-lifecycle.md#51-start)). There is no flag to toggle live updates. The `/ws` endpoint always starts file-watchers and broadcasts events (along with `ping` heartbeats) to connected clients.

### Event Types (6)

Every event is a JSON object matching the `WsEvent` interface:

```typescript
interface WsEvent {
  type: "new-inbox-item" | "inbox-item-moved" | "deployment-status-change" | "ticket-changed" | "bulletin-update" | "ping";
  data?: Record<string, unknown>;
  timestamp: string; // ISO 8601 UTC
}
```

The six event types, in the order defined by `WsEventType`:

#### 1. `new-inbox-item`

Broadcast when a new `.md` file appears in the Sinh inputs inbox directory (`<sinh-inputs>/inbox/`). Detected by comparing the current directory listing against the previously known set.

```json
{
  "type": "new-inbox-item",
  "data": {
    "filename": "2026-08-13-idea.md",
    "title": "Note to Self"
  },
  "timestamp": "2026-08-13T10:24:01.123Z"
}
```

| `data` field | Type | Description |
|--------------|------|-------------|
| `filename` | `string` | The markdown filename (e.g. `2026-08-13-idea.md`). |
| `title` | `string` | The first `# ` heading of the file, or the filename without the `.md` extension if no heading is present. |

#### 2. `inbox-item-moved`

Broadcast when a previously known inbox `.md` file is no longer present in the inbox directory (moved, renamed, or deleted).

```json
{
  "type": "inbox-item-moved",
  "data": {
    "filename": "2026-08-12-old.md",
    "from": "inbox",
    "to": "unknown"
  },
  "timestamp": "2026-08-13T10:25:00.000Z"
}
```

| `data` field | Type | Description |
|--------------|------|-------------|
| `filename` | `string` | The markdown filename that disappeared. |
| `from` | `string` | Always `"inbox"` (the watched source directory). |
| `to` | `string` | Always `"unknown"` (the destination is not tracked). |

#### 3. `deployment-status-change`

Broadcast when a new row is appended to the deployment registry SQLite database (`registry.db`). The event `data` contains the full latest registry entry (a `RegistryEvent` object — see [Data Models](./data-models.md#registryevent)).

```json
{
  "type": "deployment-status-change",
  "data": {
    "deployment_id": "d-443e6d",
    "team": "builder",
    "event": "completed",
    "timestamp": "2026-08-13T10:30:00.000Z",
    "status": "success",
    "summary": "Phase 3 complete"
  },
  "timestamp": "2026-08-13T10:30:00.001Z"
}
```

| `data` field | Type | Description |
|--------------|------|-------------|
| *(any `RegistryEvent` field)* | *(varies)* | The full latest registry row, spread into `data`. See [`RegistryEvent`](./data-models.md#registryevent) for all fields. |

#### 4. `ticket-changed`

Broadcast when a ticket JSON file in the tickets directory is created or modified (mtime changes). Compares the current file set and mtimes against the previously known snapshot.

```json
{
  "type": "ticket-changed",
  "data": {
    "ticketId": "PAP-132"
  },
  "timestamp": "2026-08-13T10:31:00.000Z"
}
```

| `data` field | Type | Description |
|--------------|------|-------------|
| `ticketId` | `string` | The ticket id — the JSON filename without the `.json` extension. Excludes `counter.json` and `audit.jsonl`. |

#### 5. `bulletin-update`

Broadcast when a markdown file in the active bulletins directory (`<bulletins>/active/`) is created, modified (mtime change), or removed.

```json
{
  "type": "bulletin-update",
  "data": {
    "bulletinId": "B-007"
  },
  "timestamp": "2026-08-13T10:32:00.000Z"
}
```

| `data` field | Type | Description |
|--------------|------|-------------|
| `bulletinId` | `string` | The bulletin id — the markdown filename without the `.md` extension. The same event type is used for create, update, and delete (clients should re-fetch to determine the current state). |

#### 6. `ping`

Server-initiated heartbeat. Sent on a fixed interval to every connected client. A client that does not respond with a `pong` message within the pong timeout is disconnected.

```json
{
  "type": "ping",
  "timestamp": "2026-08-13T10:33:00.000Z"
}
```

| field | Type | Description |
|-------|------|-------------|
| `type` | `"ping"` | Always `"ping"`. |
| `timestamp` | `string` | ISO 8601 UTC — generated at send time via `new Date().toISOString()`. Note: this is the `WsEvent.timestamp`, not a separate field. |

> The `ping` event has no `data` field. See [Ping / Pong Behavior](#ping--pong-behavior) for the full lifecycle.

### Ping / Pong Behavior

The hub maintains a heartbeat loop (`hub.startPing()`) that runs on a fixed interval. This loop is started alongside file-watchers when live updates are enabled.

| Parameter | Default | Configurable via | Description |
|-----------|---------|------------------|-------------|
| `pingIntervalMs` | `30000` (30s) | `WsHubOptions.pingIntervalMs` | How often a `ping` event is sent to each client. |
| `pongTimeoutMs` | `60000` (60s) | `WsHubOptions.pongTimeoutMs` | Maximum elapsed time since the last pong before a client is considered dead. |

**Server-side loop** (every `pingIntervalMs`):

1. For each connected client, compute `now - lastPong`.
2. If `now - lastPong > pongTimeoutMs`, close the client socket and remove it from the hub.
3. Otherwise, send a `{"type":"ping","timestamp":"<ISO>"}` event.

**Client response** — when a client receives a `ping` event, it should send back a JSON message:

```json
{ "type": "pong" }
```

The server's `onMessage` handler parses each incoming message; if `type === "pong"`, it calls `hub.recordPong(ws)`, which updates `lastPong` to `Date.now()`. Non-JSON or non-`pong` messages from the client are ignored (the hub does not echo or process them).

> **Initial state:** When a client connects, `lastPong` is initialized to `Date.now()`, giving the client a full `pongTimeoutMs` window to respond to its first ping.

### Reconnection Notes

The WebSocket hub is a **stateless broadcast** — there is no per-client message queue or replay buffer. Clients that disconnect and reconnect will miss any events broadcast during the disconnection. Recommended client strategy:

1. **Connect** to `ws://127.0.0.1:9848/ws`.
2. **Respond** to every `ping` event with `{"type":"pong"}` within 60 seconds.
3. **On close/error**, reconnect with exponential backoff. Start at ~1s, double up to ~30s, reset on a stable connection.
4. **After reconnecting**, re-fetch the current state via the REST API:
   - `GET /api/tickets` (for `ticket-changed` events)
   - `GET /api/bulletin` (for `bulletin-update` events)
   - `GET /api/deployments` (for `deployment-status-change` events)
   - `GET /api/inbox` or inspect the inbox directory (for `new-inbox-item` / `inbox-item-moved` events)
5. **Treat events as invalidation hints, not diffs.** Each event tells you *what changed* (a ticket id, a bulletin id, a deployment), not *how it changed*. Always re-fetch the resource to get the current state.

> The server does not send a "you missed N events" message on reconnect. There is no event id, sequence number, or cursor.

---

## Session Protocol (`/ws/session`)

Connect to `ws://127.0.0.1:9848/ws/session` to run an interactive opencode session. A client sends one of three message types (`start`, `resume`, `stop`) and receives a stream of session events back over the same socket. Each WebSocket connection tracks exactly one active session id; once a session is started or resumed, the connection cannot start another until the current one stops.

### Connection Lifecycle

1. **Open** — the server creates a per-connection sink that buffers messages until the WebSocket is ready, and initializes `activeSessionId = undefined`.
2. **Messages from client** — parsed as JSON; the `type` field selects the handler (`start` / `resume` / `stop`). See [Client Message Types (3)](#client-message-types-3).
3. **Close / Error** — if `activeSessionId` is set, the server calls `sessionManager.disconnect(activeSessionId)` (SIGTERM → SIGKILL escalation) and clears `activeSessionId`.

> Messages sent by the server before the WebSocket `onOpen` fires are buffered and flushed once the socket is ready. This handles the race where `start` is processed before the upgrade completes.

### Client Message Types (3)

All client messages are JSON objects with a required `type` field.

#### 1. `start`

Start a new opencode session with the given prompt. The server spawns an opencode child process and streams its JSONL output as session events.

```json
{
  "type": "start",
  "prompt": "Read the primer and follow all instructions",
  "model": "ollama-cloud/deepseek-v4-pro"
}
```

| field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"start"` | yes | Message type. |
| `prompt` | `string` | yes | The prompt to send to opencode. Must not be empty. Maximum 131072 bytes (128 KB) — larger prompts are rejected. |
| `model` | `string` | no | Model override. If omitted, the server default (`ollama-cloud/deepseek-v4-pro`) is used. |

**Server responses:**
- On success: a `session-id` event (see [Server Stream Events](#server-stream-events)) with the new session id, then a stream of `event` / `error` / `end` events.
- If a session is already active on this connection: an `error` event with message `"Session already started on this connection"`.
- If `prompt` is missing or empty: an `error` event with message `"Missing prompt"`.
- If the hub is at capacity: an `error` event with message `"Max sessions reached"`.
- If the prompt exceeds 128 KB: an `error` event with message `"Prompt exceeds maximum length (131072 bytes)"`.
- If the opencode binary cannot be spawned (ENOENT): an `error` event with message `"opencode binary not found at \"<path>\" (ENOENT). Set PA_OPENCODE_BINARY or ensure opencode is on PATH."`.

#### 2. `resume`

Resume an existing opencode session by id. Behaves like `start` but passes `--session <sessionId>` to opencode so the session context is restored.

```json
{
  "type": "resume",
  "sessionId": "abc123",
  "prompt": "Continue the previous work",
  "model": "ollama-cloud/deepseek-v4-pro"
}
```

| field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"resume"` | yes | Message type. |
| `sessionId` | `string` | yes | The opencode session id to resume. Must not be empty. |
| `prompt` | `string` | yes | The prompt for the resumed turn. Must not be empty. Maximum 131072 bytes (128 KB). |
| `model` | `string` | no | Model override. If omitted, the server default is used. |

**Server responses:**
- On success: a `session-id` event with the new (server-allocated) session id, then a stream of events. (Note: the server allocates a *new* internal session id even for resumes; the `sessionId` you provide is passed to opencode as `--session`, not used as the internal id.)
- If a session is already active on this connection: an `error` event with message `"Session already started on this connection"`.
- If `sessionId` or `prompt` is missing: an `error` event with message `"Missing sessionId or prompt"`.
- If at capacity: an `error` event with message `"Max sessions reached"`.
- If the prompt exceeds 128 KB: an `error` event with message `"Prompt exceeds maximum length (131072 bytes)"`.

#### 3. `stop`

Stop the active session on this connection. The server sends SIGTERM to the opencode child process (escalating to SIGKILL after the termination timeout), then removes the session.

```json
{
  "type": "stop"
}
```

| field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"stop"` | yes | Message type. |

**Server responses:**
- On success: an `end` event with `data.reason = "stopped"`, then the connection has no active session (a new `start` / `resume` is allowed).
- If no active session: an `error` event with message `"No active session to stop"`.
- If the session was already gone: an `error` event with the error message from `SessionManager.stop`.

**Unknown message types** — if `type` is anything other than `start` / `resume` / `stop` (or is missing), the server sends an `error` event with message `"Unknown message type: <type>"` (or `"Unknown message type: missing"` if `type` is absent). Invalid JSON produces an `error` event with message `"Invalid JSON message"`.

### Server Stream Events

The server sends `SessionStreamEvent` JSON messages to the client via the per-connection sink. All events include an ISO 8601 UTC `timestamp`.

```typescript
type SessionEventKind = "event" | "error" | "session-id" | "end";

interface SessionStreamEvent {
  type: "event" | "error" | "session-id" | "end";
  data?: Record<string, unknown>;
  message?: string;      // present on "error" events
  sessionId?: string;    // present on "session-id" events
  timestamp: string;     // ISO 8601 UTC
}
```

#### `session-id`

Sent once immediately after a successful `start` or `resume`, confirming the internal session id.

```json
{
  "type": "session-id",
  "sessionId": "s1234567890-1",
  "timestamp": "2026-08-13T10:40:00.000Z"
}
```

| field | Type | Description |
|-------|------|-------------|
| `type` | `"session-id"` | Event kind. |
| `sessionId` | `string` | The server-allocated session id (format `s<base36-timestamp>-<base36-counter>`). |
| `timestamp` | `string` | ISO 8601 UTC. |

#### `event`

A streamed opencode output event. The `data` field carries the normalized activity event (see [Data Models — ActivityEvent](./data-models.md#activityevent)) or the raw JSONL line if normalization fails. Non-JSON stdout lines are sent as `data: { "kind": "text", "body": "<line>" }`.

```json
{
  "type": "event",
  "data": {
    "deployId": "session-s1234567890-1",
    "kind": "text",
    "source": "opencode",
    "body": "Reading primer.md..."
  },
  "timestamp": "2026-08-13T10:40:01.000Z"
}
```

| field | Type | Description |
|-------|------|-------------|
| `type` | `"event"` | Event kind. |
| `data` | `object` | Either a normalized `ActivityEvent` (with `deployId`, `kind`, `source`, `body`, optional `partType`, optional `metadata`) or the raw parsed JSON object if normalization throws. |
| `timestamp` | `string` | ISO 8601 UTC. |

#### `error`

An error during the session — spawn failure, child process error, or a protocol error (invalid message, missing field, capacity).

```json
{
  "type": "error",
  "message": "opencode binary not found at \"opencode\" (ENOENT). Set PA_OPENCODE_BINARY or ensure opencode is on PATH.",
  "timestamp": "2026-08-13T10:40:02.000Z"
}
```

| field | Type | Description |
|-------|------|-------------|
| `type` | `"error"` | Event kind. |
| `message` | `string` | Human-readable error message. |
| `timestamp` | `string` | ISO 8601 UTC. |

#### `end`

The session has terminated — either the opencode child process closed, or the client sent `stop`. Sent as the final event for a session. After `end`, the connection accepts a new `start` / `resume`.

```json
{
  "type": "end",
  "data": { "exitCode": 0 },
  "timestamp": "2026-08-13T10:41:00.000Z"
}
```

```json
{
  "type": "end",
  "data": { "reason": "stopped" },
  "timestamp": "2026-08-13T10:41:00.000Z"
}
```

| field | Type | Description |
|-------|------|-------------|
| `type` | `"end"` | Event kind. |
| `data` | `object` | Either `{ "exitCode": number }` (child closed) or `{ "reason": string }` (stopped/disconnected/cleanup). When the child closes after a `stop`, both `exitCode` and `reason` may be present. |
| `timestamp` | `string` | ISO 8601 UTC. |

### Session Lifecycle

```
Client                          Server (SessionManager)
  |                                 |
  |--- start/resume --------------->|  spawn opencode (or resume --session)
  |<-- session-id ------------------|  internal session id allocated
  |<-- event (streamed) ------------|  opencode JSONL stdout → normalized ActivityEvent
  |<-- event ... --------------------|
  |                                 |  child closes (exitCode)
  |<-- end { exitCode } -------------|
  |                                 |
  |  --- OR ---                     |
  |                                 |
  |--- stop ----------------------->|  SIGTERM → wait 5s → SIGKILL
  |<-- end { reason: "stopped" } ----|
```

**Termination sequence** (on `stop`, `disconnect`, or `cleanup`):

1. The session is marked `terminated`; `record.status` is set to `"stopping"`.
2. If the child has no exit code and is not killed, SIGTERM is sent.
3. After `terminationTimeoutMs` (default `5000` ms = 5 seconds), if the child is still alive, SIGKILL is sent.
4. An `end` event is emitted with `{ reason: "stopped" | "disconnect" | "cleanup" }`.
5. The session is removed from the sessions map.

If the child has already exited (`exitCode !== null` or `killed === true`) when termination is requested, no signal is sent and an `end` event is emitted immediately.

### Capacity Limits

| Parameter | Default | Configurable via | Description |
|-----------|---------|------------------|-------------|
| `maxSessions` | `3` | `PA_MAX_SESSIONS` env var, or `SessionManagerOptions.maxSessions` | Maximum concurrent sessions (both spawned and registered deploy sessions count toward this limit). |

- When the limit is reached, `start` and `resume` return `{ ok: false, error: "Max sessions reached", limit: N }`, which the WebSocket handler sends to the client as an `error` event.
- `POST /api/sessions` (deploy session registration) returns `503` with `{ "error": "Max sessions reached", "code": "CAPACITY_REACHED", "limit": N }`.
- The `PA_MAX_SESSIONS` env var is read once at `SessionManager` construction. A non-numeric or non-positive value falls back to the default `3`.
- **Deploy sessions have no TTL or heartbeat** — they persist in memory until an explicit `stop` / `disconnect` / `cleanup` call or server restart. The `maxSessions` cap and server restart are the only automatic bounds.

---

## SSE Stream (`GET /api/sessions/:id/stream`)

A read-only Server-Sent Events stream of an existing session's events. This endpoint allows a second client to observe a session that was started via WebSocket or registered as a deploy session — without sending any messages.

> **Source of truth:** `packages/pa-core/src/agent-api/routes/sessions.ts` (`sessionRoutes`).

### Request

```
GET /api/sessions/:id/stream
Accept: text/event-stream
```

| part | Description |
|------|-------------|
| `:id` | The session id (returned by `POST /api/sessions` or the `session-id` WebSocket event). |

### Response

- **200** — `text/event-stream`. Each SSE message uses the Hono `streamSSE` format:
  ```
  event: <type>
  data: <json>
  ```
  where `<type>` is the `SessionStreamEvent.type` (`event` / `error` / `end`) and `<data>` is the JSON-stringified `SessionStreamEvent`.
- **404** — `{"error":"Session not found","code":"NOT_FOUND"}` if the session id does not exist.
- **404** — `{"error":"Deploy sessions do not support streaming","code":"NOT_FOUND"}` if the session exists but was registered via `POST /api/sessions` (a deploy session with no child process). This distinct message lets clients distinguish "no stream support" from "unknown session".

### Stream Events

On a successful connection, the server sends an initial `ready` event:

```
event: ready
data: {"type":"ready","sessionId":"<id>"}
```

Then, for each event the session produces:

```
event: event
data: {"type":"event","data":{...},"timestamp":"2026-08-13T10:40:01.000Z"}
```

When the session terminates:

```
event: end
data: {"type":"end","data":{"exitCode":0},"timestamp":"2026-08-13T10:41:00.000Z"}
```

On error:

```
event: error
data: {"type":"error","message":"...","timestamp":"2026-08-13T10:41:00.000Z"}
```

### Lifecycle

- The stream closes when either the client disconnects (the `AbortSignal` fires) or the session emits an `end` / `error` event.
- The server unsubscribes the sink on close, so no events are leaked.
- The SSE stream is **read-only** — it cannot start, resume, or stop a session. Use the WebSocket endpoint or the REST endpoints (`POST /api/sessions/:id/stop`) to control the session.

---

## Type Definitions

All WebSocket and SSE types are exported from `packages/pa-core/src/agent-api/ws/`.

### `WsEvent`

```typescript
type WsEventType =
  | "new-inbox-item"
  | "inbox-item-moved"
  | "deployment-status-change"
  | "ticket-changed"
  | "bulletin-update"
  | "ping";

interface WsEvent {
  type: WsEventType;
  data?: Record<string, unknown>;
  timestamp: string; // ISO 8601 UTC
}
```

### `WsClient`

```typescript
interface WsClient {
  readyState: number; // 1 = OPEN
  send(message: string): void;
  close(): void;
}
```

### `WsHubOptions`

```typescript
interface WsHubOptions {
  pingIntervalMs?: number;  // default 30000
  pongTimeoutMs?: number;   // default 60000
  now?: () => number;        // default Date.now (test seam)
}
```

### `SessionRecord`

```typescript
type SessionStatus = "running" | "stopping";

interface SessionRecord {
  id: string;            // format: s<base36-timestamp>-<base36-counter>
  model: string;         // model name passed to opencode -m
  status: SessionStatus;
  startedAt: string;     // ISO 8601 UTC
  deploymentId: string;  // deployment id (for spawned sessions: "session-<id>" unless overridden)
}
```

### `SessionStreamEvent`

```typescript
type SessionEventKind = "event" | "error" | "session-id" | "end";

interface SessionStreamEvent {
  type: SessionEventKind;
  data?: Record<string, unknown>;
  message?: string;    // present on "error"
  sessionId?: string;  // present on "session-id"
  timestamp: string;   // ISO 8601 UTC
}
```

### `SessionSpawnOptions`

```typescript
interface SessionSpawnOptions {
  model?: string;
  prompt: string;
  sessionId?: string;    // for resume: passed to opencode --session
  deploymentId?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}
```

### `SessionManagerOptions`

```typescript
interface SessionManagerOptions {
  maxSessions?: number;              // default 3 (or PA_MAX_SESSIONS env)
  defaultModel?: string;            // default "ollama-cloud/deepseek-v4-pro"
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;            // test seam
  normalizer?: SessionEventNormalizer;
  now?: () => Date;                  // test seam
  terminationTimeoutMs?: number;     // default 5000
  maxPromptLength?: number;          // default 131072 (128 KB)
  devMode?: boolean;                 // default false
  binaryPath?: string;               // explicit opencode binary path
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PA_MAX_SESSIONS` | `3` | Maximum concurrent sessions. Read once at `SessionManager` construction. Non-numeric or non-positive values fall back to the default. |
| `PA_OPENCODE_BINARY` | *(unset)* | When `devMode` is true, the opencode binary path to spawn. Only consulted in dev mode; production always uses `"opencode"` on PATH. Ignored when `binaryPath` is explicitly provided. |