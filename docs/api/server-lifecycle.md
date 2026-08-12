# Server Lifecycle

> **Source of truth:** `packages/pa-core/src/serve-lifecycle.ts`, `packages/pa-core/src/cli/commands/serve.ts`, `packages/pa-core/src/cli/core-command.ts`, `packages/pa-core/src/agent-api/index.ts`, `packages/pa-core/src/agent-api/ws/session-hub.ts`.
> **Last updated:** 2026-08-13

This document covers the Agent API server lifecycle: start, stop, restart, and status commands, including default port, PID file management, background mode, and dev mode.

---

## 1. Quick Reference

| Action | Command | Description |
|--------|---------|-------------|
| Start (foreground) | `pa-core serve` | Start on `127.0.0.1:9848` |
| Start (background) | `pa-core serve --background` | Fork detached child, log to file |
| Start with CORS | `pa-core serve --cors` | Enable CORS middleware |
| Start with dev mode | `pa-core serve --dev` | Enable dev mode binary resolution |
| Stop | `pa-core serve stop` or `pa-core stop` | Read PID file, send SIGTERM |
| Restart | `pa-core serve restart` or `pa-core restart` | Stop then start |
| Status | `pa-core serve status` or `pa-core serve-status` | Check if running, print PID + port |
| Help | `pa-core serve --help` | Print usage |

> **Note:** `opa serve`, `opa stop`, `opa restart`, `opa serve-status` work identically — `opa` calls the same `runCoreCommand` with opencode adapter hooks. See §6 for details.

---

## 2. Defaults

Source: `packages/pa-core/src/serve-lifecycle.ts:10-11`

```ts
export const DEFAULT_SERVE_HOST = "127.0.0.1";
export const DEFAULT_SERVE_PORT = 9848;
```

| Setting | Default | Override |
|---------|---------|----------|
| Host | `127.0.0.1` (loopback) | `--host <addr>` |
| Port | `9848` | `--port <int 1-65535>` |
| Background mode | Off | `--background` |
| CORS | Off | `--cors` |
| Force restart | Off | `--force` (start only) |
| Dev mode | Off | `--dev` or `PA_DEV_MODE` env var |

> **Security:** The default loopback binding is the primary access control. See [Auth & Security](./auth-security.md) for details.

---

## 3. CLI Flags

Source: `packages/pa-core/src/cli/commands/serve.ts:38-62`

### 3.1 Start Flags

```
Usage: serve [--port <port>] [--host <host>] [--background] [--cors] [--force] [--dev]
```

| Flag | Type | Description |
|------|------|-------------|
| `--port <port>` | Integer 1–65535 | Port to listen on. Default: `9848`. |
| `--host <host>` | String (any) | Host/interface to bind. Default: `127.0.0.1`. No allowlist validation. |
| `--background` | Boolean flag | Fork a detached child process and return immediately. |
| `--cors` | Boolean flag | Enable CORS middleware (`origin: *`). |
| `--force` | Boolean flag | Kill any existing instance before starting. Start only. |
| `--dev` | Boolean flag | Enable dev mode (opencode binary resolution). |
| `--help` / `-h` | — | Print usage and exit. |

### 3.2 Stop / Status Flags

```
Usage: stop
Usage: status
```

`stop` and `status` do not accept `--background`, `--force`, `--cors`, or `--dev`. They only use the PID file to locate the server process. Passing any of these flags returns an error:

```
stop only supports --host and --port options
```

> Note: `--host` and `--port` are accepted by `stop`/`status` but are not actually used — stop and status rely on the PID file exclusively.

### 3.3 Restart Flags

```
Usage: restart [--port <port>] [--host <host>] [--background] [--cors] [--dev]
```

Restart supports `--port`, `--host`, `--background`, `--cors`, and `--dev`. It does **not** support `--force` — `force` is hard-set to `false` during restart.

---

## 4. PID File Management

### 4.1 Location

Source: `packages/pa-core/src/serve-lifecycle.ts:46-52`, `packages/pa-core/src/paths.ts:47-49`

```ts
export function getServePidFilePath(): string {
  return resolve(getDataDir(), "pa-core-serve.pid");
}

export function getDataDir(): string {
  return expandHome(process.env["PA_PLATFORM_DATA"] ?? "~/.local/share/pa-platform");
}
```

| File | Default Path | Override |
|------|-------------|----------|
| PID file | `~/.local/share/pa-platform/pa-core-serve.pid` | `PA_PLATFORM_DATA` env var |
| Log file | `~/.local/share/pa-platform/logs/pa-core-serve.log` | `PA_PLATFORM_DATA` env var |

### 4.2 Format

The PID file contains `<pid>:<port>`, for example:

```
12345:9848
```

Legacy PID files containing only a PID number (no `:port`) are tolerated — the port falls back to `DEFAULT_SERVE_PORT` (9848).

### 4.3 Lifecycle

| Event | Action |
|-------|--------|
| Server starts (inline) | `writeServePidFile(process.pid, port)` writes `<pid>:<port>` |
| Server starts (background parent) | Forks child; child writes its own PID |
| `SIGTERM` received | Remove PID file, `process.exit(0)` |
| `SIGINT` received | Remove PID file, `process.exit(0)` |
| `process.exit` event | Remove PID file, call `api.cleanup()` |
| `stop` command | Read PID, send SIGTERM, remove PID file |
| Stale PID detected (process dead) | Remove PID file |

Source: `packages/pa-core/src/serve-lifecycle.ts:72-84, 125-134`

```ts
function writeServePidFile(pid: number, port: number): void {
  const pidFile = getServePidFilePath();
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, `${pid}:${port}`, "utf8");
}

function removeServePidFile(): void {
  try { unlinkSync(getServePidFilePath()); } catch { /* Already gone. */ }
}
```

---

## 5. Commands

### 5.1 Start

Source: `packages/pa-core/src/serve-lifecycle.ts:95-144`

The start command:

1. **Background fork check** — if `--background` and not already the forked child (`_PA_CORE_SERVE_FORKED=1`), delegate to `startBackgroundProcess`.
2. **Existing instance check** — read PID file:
   - If PID is alive and no `--force`: refuse with exit 1 and print guidance.
   - If PID is alive and `--force`: kill the existing instance, remove PID file.
   - If PID is dead (stale): clean up PID file and proceed.
   - If no PID file: probe the port with `isPortInUse`. If busy, refuse with exit 1.
3. **Write PID file** — `writeServePidFile(process.pid, port)`.
4. **Register signal handlers** — `SIGTERM` and `SIGINT` remove PID file and exit. `exit` event removes PID file and calls `api.cleanup()`.
5. **Create app** — `createAgentApiApp({ enableCors, hooks, enableLiveUpdates: true, devMode })`.
6. **Listen** — `serve({ fetch: api.app.fetch, port, hostname: host })`.
7. **Inject WebSocket** — `api.injectWebSocket(server)`.

Output:

```
[pa-core serve] Starting agent API on http://127.0.0.1:9848
[pa-core serve] Listening on http://127.0.0.1:9848
```

#### Port Already in Use

```
Port 9848 already in use (PID 12345). Use `pa-core serve stop` or `pa-core serve --force`.
```

#### No PID File but Port Busy

```
Port 9848 in use by unknown process (no PID file). Check with: ss -tlnp | grep 9848
```

### 5.2 Stop

Source: `packages/pa-core/src/serve-lifecycle.ts:169-185`

The stop command:

1. Read the PID file.
2. If no PID file: print "No PID file found. Server may not be running." and exit 0.
3. If PID is not alive: print "PID <pid> is not running. Cleaning up stale PID file." and remove it.
4. If PID is alive: send `SIGTERM`, poll every 100ms for up to 5s, escalate to `SIGKILL` if still alive after 5s, remove PID file.

```
Stopping pa-core serve (PID 12345)...
Server stopped.
```

> **Note:** Stop uses the PID file exclusively — it does not take `--port` or `--host`. The `killProcess` function (lines 241-267) sends SIGTERM first, then SIGKILL after 5 seconds.

### 5.3 Restart

Source: `packages/pa-core/src/serve-lifecycle.ts:204-212`

The restart command:

1. Run `serveStopCommand` (stop the existing server).
2. Poll `waitForPortFree` for up to 5 seconds until the port is free.
3. If the port is still in use after 5s: print error and exit 1.
4. Run `serveStartCommand` with `force: false`.

```
Stopping pa-core serve (PID 12345)...
Server stopped.
[pa-core serve] Starting agent API on http://127.0.0.1:9848
[pa-core serve] Listening on http://127.0.0.1:9848
```

> **Note:** Restart hard-sets `force: false` — it relies on stop having cleared the PID file. The `--force` flag is not accepted by restart.

### 5.4 Status

Source: `packages/pa-core/src/serve-lifecycle.ts:187-202`

The status command:

1. Read the PID file.
2. If no PID file: print "Status: stopped (no PID file)" and exit 0.
3. If PID is alive (`process.kill(pid, 0)` succeeds): print status, PID, and port.
4. If PID is not alive: print "Status: stopped (stale PID <pid>)", remove PID file, exit 0.

**Running:**

```
Status: running
PID:    12345
Port:   9848
```

**Stopped (no PID file):**

```
Status: stopped (no PID file)
```

**Stopped (stale PID):**

```
Status: stopped (stale PID 12345)
```

> **Important:** Use `pa-core serve-status` or `pa-core serve status` to check the **server** status. The bare command `pa-core status` (without the `serve-` prefix) routes to the **deployment status** command, not the server status.

---

## 6. Command Dispatch

Source: `packages/pa-core/src/cli/core-command.ts:55`

```ts
if (command === "serve" || command === "stop" || command === "restart" || command === "serve-status")
  return runServeCommand(command, rest, io, opts.hooks ?? {});
```

| CLI Form | Action |
|----------|--------|
| `pa-core serve` | start |
| `pa-core serve stop` | stop |
| `pa-core serve restart` | restart |
| `pa-core serve status` | status |
| `pa-core stop` | stop |
| `pa-core restart` | restart |
| `pa-core serve-status` | status |
| `pa-core status` | **deployment** status (NOT server status) |

### 6.1 `opa` vs `pa-core`

Both `opa` (opencode-pa adapter) and `pa-core` invoke the exact same `runServeCommand` → `runServeLifecycle` code path. Server lifecycle behavior is identical.

```ts
// packages/opencode-pa/src/cli.ts:15
const code = await runCoreCommand(process.argv.slice(2), {
  hooks: createDefaultOpencodeHooks(),
  binaryName: "opa",
});
```

The only difference is the `hooks` value passed to `createAgentApiApp` (used by deploy/session routes, not by the serve lifecycle itself).

The opencode adapter guidance (`packages/opencode-pa/src/adapter.ts:103`) explicitly directs users to `pa-core serve`:

> "Use `pa-core serve` for Agent API server lifecycle; `opa` is the default deployment adapter, not the server owner."

---

## 7. Background Mode

Source: `packages/pa-core/src/serve-lifecycle.ts:146-167`

### 7.1 How It Works

When `--background` is passed:

1. The **parent** process checks for the `_PA_CORE_SERVE_FORKED` env var.
2. If not set (parent), it spawns a **detached child** with the same script and flags, sets `_PA_CORE_SERVE_FORKED=1` in the child env, and redirects stdio to the log file.
3. The parent prints the child PID and exits immediately.
4. The **child** (with `_PA_CORE_SERVE_FORKED=1`) takes the inline-listen branch, writes its own PID to the PID file, and starts serving.

```ts
const child = spawn(opts.executable ?? process.execPath, [script, ...args], {
  detached: true,
  stdio: ["ignore", out, out],
  env: { ...process.env, ...opts.env, [PA_CORE_SERVE_FORKED_ENV]: "1" },
});
child.unref();
opts.io.stdout(`[pa-core serve] Started in background (PID ${child.pid ?? "unknown"}). Log: ${logFile}`);
```

### 7.2 Log File

Background mode redirects stdout and stderr to:

```
~/.local/share/pa-platform/logs/pa-core-serve.log
```

(Override with `PA_PLATFORM_DATA` env var.)

### 7.3 PID File Note

The PID written to the PID file is that of the **child** process (written by the child at step 4), not the `child.pid` reported by the parent at step 3. Both are the same PID in practice.

### 7.4 Detachment

`detached: true` + `child.unref()` allows the parent to exit without waiting for the child. The child survives parent exit and runs independently.

---

## 8. Dev Mode

Source: `packages/pa-core/src/cli/commands/serve.ts:16-36, 75`

### 8.1 Activation

Dev mode is activated by either:

- The `--dev` CLI flag, OR
- The `PA_DEV_MODE` environment variable set to a truthy value: `"1"`, `"true"`, or `"yes"`.

```ts
const devMode = parsed.dev || isDevModeTruthy(process.env[PA_DEV_MODE_ENV]);
```

### 8.2 What Dev Mode Does

Dev mode affects **only one thing**: binary resolution for spawned opencode sessions via the `/ws/session` WebSocket endpoint.

Source: `packages/pa-core/src/agent-api/ws/session-hub.ts:102-114`

```ts
export function resolveBinary(opts: {
  devMode?: boolean;
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  if (opts.explicitPath) return opts.explicitPath;
  if (opts.devMode) {
    const env = opts.env ?? process.env;
    const override = env[PA_OPENCODE_BINARY_ENV];
    if (override && override.trim().length > 0) return override;
  }
  return DEFAULT_BINARY; // "opencode"
}
```

| Mode | Binary Resolution |
|------|-------------------|
| Production (`devMode=false`) | `"opencode"` on PATH (always) |
| Dev (`devMode=true`) | `PA_OPENCODE_BINARY` env var if non-empty, else `"opencode"` on PATH |

### 8.3 What Dev Mode Does NOT Do

Dev mode does **not**:

- Disable authentication (there is none)
- Disable CORS
- Disable capacity limits (session cap, prompt cap)
- Change any security behavior
- Persist across restarts (per-process only)

Source: `packages/pa-core/src/cli/commands/serve.ts:22-24`:

> Dev mode is per-process and never persisted — NFR3. Setting this in production is not supported; dev mode only affects binary resolution and does not disable auth, CORS, or capacity limits.

---

## 9. Graceful Shutdown

### 9.1 Signal Handling

The server registers handlers for `SIGTERM`, `SIGINT`, and the `exit` event:

```ts
const cleanupPid = () => removeServePidFile();
process.once("SIGTERM", () => { cleanupPid(); process.exit(0); });
process.once("SIGINT", () => { cleanupPid(); process.exit(0); });
process.once("exit", cleanupPid);

// ...

process.once("exit", () => api.cleanup());
```

### 9.2 Cleanup

`api.cleanup()` tears down:

1. **File watchers** — stops watching `ai-usage` directories for live updates.
2. **WebSocket hub** — stops ping interval, clears client set.
3. **SessionManager** — terminates any spawned opencode child processes.

### 9.3 No Explicit `server.close()`

There is no explicit `server.close()` call. Node closes the listening socket on `process.exit()`. In-flight requests may be interrupted.

### 9.4 Kill Process (Stop/Force)

Source: `packages/pa-core/src/serve-lifecycle.ts:241-267`

```ts
function killProcess(pid: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolveKill) => {
    try { process.kill(pid, "SIGTERM"); } catch { resolveKill(true); return; }
    const start = Date.now();
    const check = setInterval(() => {
      if (!isProcessAlive(pid)) { clearInterval(check); resolveKill(true); return; }
      if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        try { process.kill(pid, "SIGKILL"); } catch { /* Already stopped. */ }
        resolveKill(true);
      }
    }, 100);
  });
}
```

- SIGTERM sent first.
- Polls every 100ms.
- Escalates to SIGKILL after 5 seconds.

---

## 10. Port Probe

Source: `packages/pa-core/src/serve-lifecycle.ts:214-221`

```ts
function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", (error) => resolvePort(error.code === "EADDRINUSE"));
    server.once("listening", () => server.close(() => resolvePort(false)));
    server.listen(port, host);
  });
}
```

Used when no PID file exists but the port might be busy. Creates a temporary TCP server to probe the port, then closes it immediately.

---

## 11. Dev Shell Wrapper (`dev-pa-serve`)

The Nix flake provides a `dev-pa-serve` dev-shell helper that runs the server under `dtach` with phone/Tailscale-friendly defaults:

```bash
dev-pa-serve           # Start with defaults: --host 0.0.0.0 --port 9848 --cors
dev-pa-serve stop      # Stop the server
dev-pa-serve status     # Show status
dev-pa-serve restart    # Restart with defaults
dev-pa-serve --port 19848  # Override port
```

Defaults:

| Setting | Value |
|---------|-------|
| Host | `0.0.0.0` (all interfaces) |
| Port | `9848` |
| CORS | Enabled |
| dtach socket | `/tmp/pa-platform-serve.dtach` |

> **Note:** `dev-pa-serve` explicitly does NOT change the `pa-core serve` defaults — it just pre-passes the flags. The `pa-core` defaults remain `127.0.0.1` + CORS off. Attach to the running server with `dtach -a /tmp/pa-platform-serve.dtach`.

---

## 12. Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PA_PLATFORM_DATA` | `~/.local/share/pa-platform` | Data directory (PID file + log file root) |
| `PA_DEV_MODE` | (unset) | Activate dev mode (`"1"`, `"true"`, `"yes"`) |
| `PA_OPENCODE_BINARY` | (unset) | Dev-mode opencode binary path override |
| `PA_MAX_SESSIONS` | `3` | Max concurrent WebSocket sessions |
| `_PA_CORE_SERVE_FORKED` | (internal) | Marker for the background-forked child |

See [Configuration](./configuration.md) for the full environment variable reference.

---

## Cross-References

- [Auth & Security](./auth-security.md) — CORS, path traversal guards, security considerations
- [Configuration](./configuration.md) — environment variables and config files
- [CLI Reference](./cli-reference.md) — full CLI command reference
- [Examples & Recipes](./examples.md) — runnable code examples