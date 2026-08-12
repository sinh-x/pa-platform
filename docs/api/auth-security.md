# Auth & Security

> **Source of truth:** `packages/pa-core/src/agent-api/index.ts`, `packages/pa-core/src/agent-api/utils/sandbox.ts`, `packages/pa-core/src/agent-api/routes/` (per-route guards), `packages/pa-core/src/serve-lifecycle.ts`, `packages/pa-core/src/deploy/control.ts`.
> **Last updated:** 2026-08-13

This document covers CORS configuration, allowed HTTP headers, path traversal guards, input sanitization, WebSocket security, and general security considerations for the pa-platform Agent API server.

---

## 1. Security Model Overview

The Agent API is designed for **loopback-only** deployment. The primary access control is network binding: the server defaults to `127.0.0.1:9848`, which restricts access to the local machine. The API has **no authentication, no rate limiting, and no IP allowlisting** — any caller that can reach the bound port has full access to all endpoints.

| Layer | Mechanism | Status |
|-------|----------|--------|
| Network | Loopback binding (`127.0.0.1` default) | Active by default |
| CORS | Opt-in via `--cors` flag | Disabled by default |
| Authentication | None | Not implemented |
| Authorization | None | Not implemented |
| Rate limiting | None (3-session WS cap only) | Not implemented |
| Path traversal | Sandbox validation + per-route guards | Active always |
| Input sanitization | Shell metachar strip for deploy objectives | Active for `POST /api/deploy` |
| Secret redaction | Adapter stream/body sanitization | Active in `opa`/`cpa`/`dpa` adapters |

**Warning:** Binding to `--host 0.0.0.0` exposes the unauthenticated API to the network. Only do this behind a reverse proxy with authentication, or on a trusted private network (e.g., Tailscale).

---

## 2. CORS Configuration

CORS is **opt-in** — disabled by default. Pass `--cors` to `pa-core serve` (or `opa serve`) to enable it.

### 2.1 Enabling CORS

```bash
pa-core serve --cors
opa serve --cors
```

The `--cors` flag propagates through `runServeLifecycle` → `createAgentApiApp({ enableCors: true })` → Hono `cors()` middleware.

### 2.2 CORS Policy

Source: `packages/pa-core/src/agent-api/index.ts:43-49`

```ts
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Av-Pair-Token", "X-Av-Node-Id"],
  exposeHeaders: ["Content-Length", "Content-Type"],
  maxAge: 600,
}));
```

| Directive | Value | Notes |
|-----------|-------|-------|
| `Access-Control-Allow-Origin` | `*` (wildcard) | Allows any origin. Credentials cannot be sent cross-origin with a wildcard origin (CORS spec). |
| `Access-Control-Allow-Methods` | `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS` | All standard methods. |
| `Access-Control-Allow-Headers` | `Content-Type, Authorization, X-Av-Pair-Token, X-Av-Node-Id` | Request headers the browser may send. |
| `Access-Control-Expose-Headers` | `Content-Length, Content-Type` | Response headers the browser can read. |
| `Access-Control-Max-Age` | `600` (10 minutes) | Preflight cache duration. |
| `Access-Control-Allow-Credentials` | Not set (falsy) | Cookies/credentials are not allowed cross-origin. |

### 2.3 Allowed Request Headers

The following request headers are explicitly permitted in preflight responses:

| Header | Purpose |
|--------|---------|
| `Content-Type` | Standard JSON content type for request bodies. |
| `Authorization` | Declared in CORS but **not validated by any handler**. Pass-through only. |
| `X-Av-Pair-Token` | Avodah phone proxy pairing token. Declared in CORS but **not validated by any handler**. Pass-through for upstream contract. |
| `X-Av-Node-Id` | Avodah phone proxy node identifier. Declared in CORS but **not validated by any handler**. Pass-through for upstream contract. |

> **Important:** `Authorization`, `X-Av-Pair-Token`, and `X-Av-Node-Id` are allowed through CORS preflight but **no route handler reads or validates them**. They exist to support the Avodah phone proxy contract. The API does not enforce authentication on any endpoint.

### 2.4 CORS Test Contract

The CORS behavior is verified by a test at `packages/pa-core/src/__tests__/agent-api.test.ts:300-319`:

```ts
test("agent API CORS matches Avodah phone proxy contract", async () => {
  const { app } = createAgentApiApp({ enableCors: true });
  const preflight = await app.request("/api/projects", {
    method: "OPTIONS",
    headers: {
      origin: "https://drgnfly.tail10c2c6.ts.net",
      "access-control-request-method": "GET",
      "access-control-request-headers": "content-type,x-av-pair-token,x-av-node-id",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /OPTIONS/);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /X-Av-Pair-Token/);
  assert.equal(preflight.headers.get("access-control-max-age"), "600");
});
```

---

## 3. Path Traversal Guards

Path traversal protection is the primary application-layer security mechanism. It enforces that all filesystem paths accessed through the API stay within a sandbox root.

### 3.1 Sandbox Root

Source: `packages/pa-core/src/paths.ts:69-70`

```ts
export function getAiUsageDir(): string {
  return expandHome(process.env["PA_AI_USAGE_HOME"] ?? "~/Documents/ai-usage");
}
```

- **Default sandbox root:** `~/Documents/ai-usage`
- **Override:** `PA_AI_USAGE_HOME` environment variable.

### 3.2 Sandbox Helper Utilities

Source: `packages/pa-core/src/agent-api/utils/sandbox.ts`

#### `normalizeSandboxPath(inputPath, sandboxRoot?)`

Normalizes a user-supplied path relative to the sandbox root. Handles three input forms:

| Input prefix | Resolution |
|-------------|------------|
| `~/Documents/ai-usage/` | Strips the prefix, resolves relative to `sandboxRoot`. |
| `~/` | Expands home directory (`expandHome`). |
| `/` (absolute) | Returns as-is (already absolute). |
| (no prefix, relative) | Resolves relative to `sandboxRoot`. |

#### `validateSandboxPath(inputPath, sandboxRoot?)`

Throws if the resolved path is outside the sandbox root:

```ts
const resolved = resolve(inputPath);
if (resolved !== root && !resolved.startsWith(`${root}/`))
  throw new Error(`Path traversal denied: "${inputPath}" is outside sandbox root`);
```

#### `isInsideSandbox(inputPath, sandboxRoot?)`

Returns `true` if `validateSandboxPath` succeeds, `false` otherwise. Used in global middleware.

### 3.3 Global Middleware

Source: `packages/pa-core/src/agent-api/index.ts:50-55`

```ts
app.use("*", async (c, next) => {
  const pathParam = c.req.query("path");
  if (pathParam !== undefined && !isInsideSandbox(normalizeSandboxPath(pathParam)))
    return c.json({ error: "Path traversal denied", code: "SANDBOX_VIOLATION" }, 403);
  if (c.req.path.includes(".."))
    return c.json({ error: "Invalid path", code: "BAD_REQUEST" }, 400);
  await next();
});
```

Two checks run on **every** request:

1. **`?path=` query param validation** — if a `path` query parameter is present, it is normalized and checked against the sandbox root. If outside, the request is rejected with `403 SANDBOX_VIOLATION`.
2. **URL `..` rejection** — if the URL path contains `..`, the request is rejected with `400 BAD_REQUEST`.

### 3.4 Per-Route Sandbox Enforcement

Routes that accept path segments or filenames apply additional validation:

#### Documents & Images (`documents.ts`)

```ts
function safeResolve(path: string) {
  try {
    return { ok: true, path: validateSandboxPath(normalizeSandboxPath(path)) };
  } catch {
    return { ok: false, error: "Path traversal denied", code: "SANDBOX_VIOLATION", status: 403 };
  }
}
```

Used by: `GET /api/documents`, `GET /api/images`, `GET /api/folders/:folderId/files/:fileId/sections`.

#### Actions (`actions.ts`)

| Validator | Purpose |
|-----------|---------|
| `isSafeFilename(name)` | Rejects `..`, `/`, `\`, leading `.` |
| `isSafeMarkdownFilename(name)` | `isSafeFilename` + `.md` extension required |
| `isSafeAttachmentPath(path)` | Rejects absolute paths, `..`, `\`; validates via `validateSandboxPath` |
| `safeJoin(root, ...segments)` | Validates each segment with `isSafeFilename`, then `validateSandboxPath` on the joined result |

Upload restrictions (image attachments):

```ts
const ALLOWED_UPLOAD_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
```

- **Allowed extensions:** `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`
- **Max file size:** 5 MB (rejected with `413 PAYLOAD_TOO_LARGE`)

#### Folders (`folders.ts`)

```ts
function isSafeSegment(segment: string): boolean {
  return !!segment && !segment.includes("..") && !segment.includes("/")
    && !segment.includes("\\") && !segment.startsWith(".");
}
```

Folder path segments are validated with `isSafeSegment` and then the resolved directory is checked with `validateSandboxPath`.

### 3.5 Sandbox Violation Responses

All path traversal rejections use these response shapes:

| Status | Body | Trigger |
|--------|------|---------|
| `403` | `{ "error": "Path traversal denied", "code": "SANDBOX_VIOLATION" }` | `?path=` outside sandbox, `isSafeAttachmentPath` fail, `safeJoin` fail |
| `400` | `{ "error": "Invalid path", "code": "BAD_REQUEST" }` | URL contains `..` |
| `403` | `{ "error": "Invalid filename", "code": "INVALID_PATH" }` | `isSafeFilename` or `isSafeMarkdownFilename` fail |
| `413` | `{ "error": "File too large", "code": "PAYLOAD_TOO_LARGE" }` | Upload exceeds 5 MB |
| `400` | `{ "error": "File extension '<ext>' is not allowed...", "code": "BAD_REQUEST" }` | Upload extension not in allowlist |

### 3.6 Sandbox Violation Tests

Verified at `packages/pa-core/src/__tests__/agent-api.test.ts:381-396`:

```ts
test("agent API document, image, and folder routes reject outside-root paths", async () => {
  const documentResponse = await app.request("/api/documents?path=/tmp/outside.md");
  assert.equal(documentResponse.status, 403);
  assert.equal((await documentResponse.json()).code, "SANDBOX_VIOLATION");

  const imageResponse = await app.request("/api/images?path=/tmp/outside.png");
  assert.equal(imageResponse.status, 403);

  const folderResponse = await app.request("/api/folders/teams/builder/inbox%2Foutside");
  assert.equal(folderResponse.status, 403);
});
```

---

## 4. Input Sanitization

### 4.1 Deploy Objective Sanitization

Source: `packages/pa-core/src/deploy/control.ts:71-78`

```ts
export function sanitizeTextInput(text: string): SanitizeResult {
  const sanitized = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f$\\;&]/g, "");
  return { sanitized, removed: text.length - sanitized.length };
}
```

The `objective` field in `POST /api/deploy` is sanitized to strip:

- Control characters (`\x00`–`\x08`, `\x0b`, `\x0c`, `\x0e`–`\x1f`, `\x7f`)
- Shell metacharacters: `$`, `\`, `;`, `&`

This prevents shell injection via the deploy objective before it is passed to the spawned `opencode` process. The `removed` count indicates how many characters were stripped.

### 4.2 Deploy Request Field Validation

All fields in `POST /api/deploy` are validated against strict regex patterns:

| Field | Validation |
|-------|-----------|
| `team` | `/^[a-zA-Z0-9_-]+$/` |
| `mode` | `/^[a-zA-Z0-9_-]+$/` |
| `objective` | Max 10000 chars + sanitization |
| `repo` | `/^[a-zA-Z0-9_-]+$/` OR `~/.+` OR `/.+` (no `..`) |
| `ticket` | `/^[A-Z][A-Z0-9]+-[0-9]+$/` |
| `timeout` | Integer, 60–7200 seconds |
| `provider` | `/^[a-zA-Z0-9_-]+$/` |
| `model` | `/^[-a-zA-Z0-9_.:\/]+$/` |
| `resume` | `/^[a-zA-Z0-9-]+$/` |
| `autonomy` | Enum: `low`, `medium`, `high` |

Invalid fields return `400 BAD_REQUEST` with a descriptive `error` message.

---

## 5. WebSocket Security

### 5.1 Connection Acceptance

The WebSocket endpoints (`/ws` and `/ws/session`) accept any connection with **no origin check, no authentication, and no token validation**. Any client that can reach the port can connect.

### 5.2 Liveness (Ping/Pong)

Source: `packages/pa-core/src/agent-api/ws/hub.ts:33-34`

```ts
this.pingIntervalMs = opts.pingIntervalMs ?? 30_000;
this.pongTimeoutMs = opts.pongTimeoutMs ?? 60_000;
```

- Ping interval: 30 seconds
- Pong timeout: 60 seconds (connection closed if no pong received within this window)

### 5.3 Session Resource Limits

Source: `packages/pa-core/src/agent-api/ws/session-hub.ts`

| Limit | Default | Override | Purpose |
|-------|---------|----------|---------|
| Max concurrent sessions | 3 | `PA_MAX_SESSIONS` env var | Prevents resource exhaustion |
| Max prompt length | 128 KB (131072 bytes) | — | Prevents oversized prompts |

When at capacity, new session requests are rejected:

```json
{ "ok": false, "error": "Max sessions reached", "limit": 3 }
```

### 5.4 Session Process Spawning

The `/ws/session` endpoint spawns `opencode` child processes with `--dangerously-skip-permissions`:

```ts
const args = ["run", "-m", opts.model ?? session.record.model, "--dangerously-skip-permissions"];
```

This flag is passed to the spawned opencode process to allow autonomous operation. The spawned process inherits no network access beyond what the host has.

---

## 6. Secret Redaction (Adapter Layer)

### 6.1 Stream Body Sanitization

Source: `packages/opencode-pa/src/adapter.ts:17-19, 392-396`

```ts
const STREAM_SECRET_PATTERNS = [
  /(?:\b|_)token(?:\b|_)/i,
  /(?:\b|_)secret(?:\b|_)/i,
  /(?:\b|_)password(?:\b|_)/i,
  /(?:\b|_)key(?:\b|_)/i,
  /bearer\s+\S+/i,
  /sk-\S+/i,
];

function sanitizeStreamBody(value: string): string {
  let result = value;
  for (const pattern of STREAM_SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  return result.length > STREAM_BODY_MAX_CHARS
    ? `${result.slice(0, STREAM_BODY_MAX_CHARS - 3)}...`
    : result;
}
```

- Patterns redacted: `token`, `secret`, `password`, `key`, `bearer <token>`, `sk-<key>`
- Max stream body length: 500 characters (truncated with `...`)
- Applied to: activity log output streamed through the API

This prevents secret leakage through the API's activity endpoints. Similar but not identical patterns are used across `opa` (opencode-pa), `cpa` (claudecode-pa), and `dpa` (droidcode-pa) adapters — each adapter maintains its own list (e.g. `dpa` adds `fk-...` keys and uses case-insensitive global matching; `cpa`/`dpa` match `api_key`/`access_key` variants that `opa` does not).

### 6.2 Bash Command Guarding (Tool Layer)

Source: `packages/opencode-pa/src/plugins/pa-safety-activity.ts`

The opencode adapter installs a safety plugin that guards bash commands executed within spawned agent processes:

**Blocked commands:**

| Pattern | Action |
|---------|--------|
| `rm` / `rmdir` | Throws `BLOCKED: rm/rmdir is not allowed. Use pa trash move instead. Use opa trash move instead.` |
| `find ... -delete` | Throws `BLOCKED: find -delete is not allowed. Use pa trash move instead. Use opa trash move instead.` |
| `xargs ... rm` | Throws `BLOCKED: xargs rm is not allowed. Use pa trash move instead. Use opa trash move instead.` |

**Blocked file patterns:**

```ts
[
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.ssh\/id_/,
  /credentials/i,
  /secrets?.*\.(json|ya?ml)$/i,
  /[-_]token\.json$/i,
  /[-_]api[-_]?key\.json$/i,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
]
```

If a bash command references a file matching any of these patterns, the command is blocked. This is a tool-layer guard (runs inside the spawned opencode process), not an HTTP-layer guard.

---

## 7. Security Headers

The Agent API does **not** set any security response headers. There is no middleware that sets:

- `X-Content-Type-Options`
- `X-Frame-Options`
- `Content-Security-Policy`
- `Strict-Transport-Security`
- `Referrer-Policy`

The only response headers set by the application are:

- `Content-Type` (JSON responses: `application/json`; file responses: inferred)
- `Content-Length` (file download routes)
- CORS headers (only when `--cors` is enabled)

If the server is exposed behind a reverse proxy, security headers should be configured at the proxy layer.

---

## 8. Security Considerations

### 8.1 Loopback Binding (Primary Access Control)

The server defaults to `127.0.0.1:9848`. This is the primary and only network access control. Only processes on the local machine can reach the API.

```bash
# Default (loopback only)
pa-core serve

# Expose to network (NOT recommended without additional auth)
pa-core serve --host 0.0.0.0
```

> **Warning:** The `--host` flag accepts any value with no allowlist validation. Binding to `0.0.0.0` or a public IP exposes the unauthenticated API to the network.

### 8.2 No Authentication

The API has no authentication or authorization mechanism. The `Authorization` header is allowed through CORS but never read by any handler. All endpoints are fully open to any caller that can reach the bound port.

**Implications:**
- Any local process can read/modify tickets, trigger deployments, access documents, and spawn sessions.
- If exposed to a network (via `--host 0.0.0.0` or a reverse proxy), an authentication layer (e.g., API key, OAuth proxy, mTLS) must be added externally.

### 8.3 No Rate Limiting

There is no request rate limiting. The only resource bounds are:

- WebSocket session cap: 3 concurrent sessions (configurable via `PA_MAX_SESSIONS`)
- WebSocket prompt length cap: 128 KB
- Upload size limit: 5 MB (image attachments only)

There is no global request body size limit on the Hono app.

### 8.4 CORS Wildcard Origin

When `--cors` is enabled, the `Access-Control-Allow-Origin` is set to `*` (wildcard). This allows any website to issue requests to the API. However, credentials are not allowed with a wildcard origin (per the CORS spec), so cookies and HTTP authentication cannot be sent cross-origin.

**Implications:**
- Any web page on the local machine (or network, if exposed) can issue read/write API requests.
- For browser-based integrations requiring credentials, configure a reverse proxy with a specific origin allowlist.

### 8.5 No IP Filtering

There is no IP allowlist or denylist. The only network control is the bind address. If finer-grained access control is needed, it must be implemented at the network layer (firewall rules, reverse proxy).

### 8.6 Dev Mode Safety

Dev mode (`--dev` flag or `PA_DEV_MODE` env var) only affects binary resolution for spawned opencode sessions. It does **not**:

- Disable authentication (there is none to disable)
- Disable CORS
- Disable capacity limits
- Change any security behavior

Dev mode is per-process and never persisted.

### 8.7 Recommendations for Network Deployment

If the API must be exposed beyond loopback:

1. **Use a reverse proxy** (nginx, Caddy, Traefik) with:
   - TLS termination
   - Authentication (API key, OAuth2, mTLS)
   - Rate limiting
   - Security response headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, etc.)
   - Request body size limits
2. **Bind to a private interface** (Tailscale, WireGuard) rather than `0.0.0.0`.
3. **Enable CORS** only if browser access is required, and configure a specific origin allowlist at the proxy layer.
4. **Restrict filesystem paths** by setting `PA_AI_USAGE_HOME` to a dedicated directory with appropriate permissions.

### 8.8 Threat Model Summary

| Threat | Mitigation |
|--------|-----------|
| Unauthorized remote access | Loopback binding (default `127.0.0.1`) |
| Path traversal to arbitrary files | Sandbox validation (global + per-route) |
| Shell injection via deploy objective | Control char + metachar sanitization |
| Secret leakage via activity logs | Adapter stream body redaction |
| Destructive commands in agent sessions | Bash command guarding plugin |
| Malicious file uploads | Extension allowlist + 5 MB size limit |
| Resource exhaustion via sessions | 3-session cap + 128 KB prompt limit |
| Cross-origin browser access | CORS disabled by default; wildcard when enabled (no credentials) |
| Network eavesdropping | Loopback only by default; TLS via reverse proxy if exposed |

---

## Cross-References

- [Server Lifecycle](./server-lifecycle.md) — start/stop/restart/status, port, PID file, background mode
- [Configuration](./configuration.md) — environment variables (`PA_AI_USAGE_HOME`, `PA_DEV_MODE`, `PA_MAX_SESSIONS`, etc.)
- [REST API Reference](./rest-api.md) — endpoint-level error codes and request/response schemas
- [Examples & Recipes](./examples.md) — runnable curl and TypeScript examples