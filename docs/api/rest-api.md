# REST API Reference

Complete reference for all 68 REST endpoints exposed by the pa-platform Agent API. Endpoints are grouped by domain. Each entry documents the HTTP method, path, query parameters, request body schema (where applicable), response schema, and error codes.

> **Source of truth:** `packages/pa-core/src/agent-api/routes/`
> **Base URL:** `http://127.0.0.1:9848`
> **Content-Type:** `application/json` (unless noted otherwise — e.g. SSE streams, image responses, multipart uploads)
> **Last updated:** 2026-08-13

## Table of Contents

- [Conventions](#conventions)
- [Error Response Shape](#error-response-shape)
- [Health (1)](#health)
- [Tickets (6)](#tickets)
- [Board & Projects (2)](#board--projects)
- [Bulletins (3)](#bulletins)
- [Focus (1)](#focus)
- [Teams (4)](#teams)
- [Documents & Images (3)](#documents--images)
- [Folders (1)](#folders)
- [Configuration (1)](#configuration)
- [Repos — Git Summary & Info (2)](#repos--git-summary--info)
- [Repos — Branches & Commits (2)](#repos--branches--commits)
- [Repos — Git Extension (3)](#repos--git-extension)
- [Repos — Deployments (1)](#repos--deployments)
- [Deployments (3)](#deployments)
- [Deploy Routing (1)](#deploy-routing)
- [Deploy Control (3)](#deploy-control)
- [Deploy Status (7)](#deploy-status)
- [Timers (1)](#timers)
- [Actions & Inbox (9)](#actions--inbox)
- [Skills (1)](#skills)
- [Knowledge (2)](#knowledge)
- [Dashboard (7)](#dashboard)
- [Sessions (4)](#sessions)
- [Endpoint Count Summary](#endpoint-count-summary)

---

## Conventions

- All endpoints are served under the base path `/api` (the `/dashboard` HTML page is the only non-`/api` route and is not part of the REST API surface).
- Path parameters use the `:name` convention (e.g. `:id`, `:key`, `:folder`, `:filename`, `:commentId`, `:folderId`, `:fileId`).
- Query parameters are optional unless marked **required**.
- Request bodies are JSON unless documented otherwise (`POST /api/tickets/:id/attachments/upload` uses `multipart/form-data`).
- All responses use JSON. The `GET /api/sessions/:id/stream` endpoint is an SSE stream (`text/event-stream`).
- A global middleware rejects any request whose `path` query parameter resolves outside the sandbox, or whose URL contains `..`, with `403` / `400` respectively. An unhandled error produces `500` with `{ "error": "<message>", "code": "INTERNAL_ERROR" }`.
- The `/dashboard` HTML page (`GET /dashboard`) is intentionally excluded from this reference — it is a server-rendered HTML view, not a REST API endpoint.

## Error Response Shape

All non-2xx responses share a common shape:

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_CODE"
}
```

Some error responses include additional fields (e.g. `validProjects` on `INVALID_PROJECT`, `limit` on `CAPACITY_REACHED`). Each endpoint below lists the error codes it can return with the relevant HTTP status.

---

## Health

### 1. GET /api/health

Health probe. Returns a fixed status object.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{ "status": "ok" }
```

**Error codes:** none (always 200 unless an unhandled error triggers the global `500 INTERNAL_ERROR`).

**Source:** `packages/pa-core/src/agent-api/index.ts:57`

---

## Tickets

### 2. GET /api/tickets

List tickets with optional filters.

**Query parameters:**

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `project` | string | no | Filter by project key |
| `status` | string | no | Filter by ticket status |
| `assignee` | string | no | Filter by assignee |
| `priority` | string | no | Filter by priority (`critical` \| `high` \| `medium` \| `low`) |
| `type` | string | no | Filter by ticket type (`feature` \| `bug` \| `task` \| `review-request` \| `work-report` \| `fyi` \| `idea` \| `question`) |
| `tags` | string | no | Comma-separated list of tags to include |
| `excludeTags` | string | no | Comma-separated list of tags to exclude |
| `search` | string | no | Full-text search term |

**Request body:** none
**Response schema (200):**

```json
{
  "tickets": [Ticket],
  "count": number
}
```

Each `Ticket.doc_refs[].title` is derived via `deriveDocRefTitle`.

**Error codes:** none specific (global `500 INTERNAL_ERROR` on unexpected failure).

**Source:** `packages/pa-core/src/agent-api/routes/tickets.ts:19`

### 3. POST /api/tickets

Create a new ticket.

**Query parameters:** none
**Request body (`CreateTicketInput` + optional `actor`/`team`):**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | yes | |
| `project` | string | yes | |
| `status` | string | no | |
| `priority` | string | no | `critical` \| `high` \| `medium` \| `low` |
| `type` | string | no | |
| `assignee` | string | yes | `team` is deprecated; if `assignee` is absent and `team` is set, `assignee` is filled from `team` |
| `summary` | string | no | |
| `description` | string | no | |
| `tags` | string[] | no | |
| `blockedBy` | string[] | no | |
| `doc_refs` | object[] | no | |
| `estimate` | string | no | `XS` \| `S` \| `M` \| `L` \| `XL` |
| `from` | string | no | |
| `to` | string | no | |
| `actor` | string | no | Audit actor; defaults to `"api"` |

**Response schema (201):**

```json
{ "ticket": Ticket }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid JSON body |
| 400 | `BAD_REQUEST` | `assignee` is missing |
| 400 | `CREATE_FAILED` | Validation error (e.g. invalid assignee) |

**Source:** `packages/pa-core/src/agent-api/routes/tickets.ts:41`

### 4. GET /api/tickets/:id/review

Fetch a ticket together with its `doc_refs` enriched with resolved URLs and titles for review purposes.

**Query parameters:** none
**Request body:** none
**Path parameters:** `:id` — ticket id
**Response schema (200):**

```json
{
  "ticket": Ticket,
  "doc_refs": [{ "path": string, "type"?: string, "url": string, "title": string }]
}
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 404 | `NOT_FOUND` | Ticket not found |

**Source:** `packages/pa-core/src/agent-api/routes/tickets.ts:60`

### 5. GET /api/tickets/:id

Fetch a single ticket with related deployments. Supports HTML rendering of markdown fields.

**Query parameters:**

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `render` | string | no | When set to `"html"`, the `summary`, `description`, and each comment `content` are rendered to HTML via `marked`. |

**Request body:** none
**Path parameters:** `:id` — ticket id
**Response schema (200):**

```json
{
  "ticket": Ticket,
  "deployments": [DeploymentStatus]
}
```

`Ticket.doc_refs[].title` is enriched. When `render=html`, string markdown fields are HTML strings.

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 404 | `NOT_FOUND` | Ticket not found |

**Source:** `packages/pa-core/src/agent-api/routes/tickets.ts:67`

### 6. PATCH /api/tickets/:id

Update ticket fields. Supports adding a linked branch (with optional branch-name validation warning).

**Query parameters:** none
**Path parameters:** `:id` — ticket id
**Request body (`UpdateTicketInput` + optional `actor`):**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `status` | string | no | |
| `priority` | string | no | |
| `assignee` | string | no | Validated against allowed assignees |
| `title` | string | no | |
| `summary` | string | no | |
| `description` | string | no | |
| `tags` | string[] | no | |
| `blockedBy` | string[] | no | |
| `doc_refs` | object[] | no | |
| `add_linked_branch` | `{ repo: string, branch: string, sha?: string, linkedBy?: string }` | no | Triggers branch-name pattern validation; a `warning` field is added to the response when validation fails or the repo is unknown |
| `remove_linked_branch` | string | no | `"<repo>:<branch>"` to remove |
| `add_linked_commit` | `{ repo: string, sha: string, message?: string, author?: string, timestamp?: string, linkedBy?: string }` | no | Appends to `linkedCommits` |
| `remove_linked_commit` | string | no | SHA to remove from `linkedCommits` |
| `add_doc_ref` | `{ type?: string, path: string, primary?: boolean, addedBy?: string }` | no | Appends to `doc_refs` |
| `remove_doc_ref` | string | no | Path to remove from `doc_refs` |
| `linkedCommits` | `LinkedCommit[]` | no | Direct replacement (camelCase); mutation helpers above are preferred |
| `actor` | string | no | Audit actor; defaults to `"api"` |

**Response schema (200):**

```json
{
  "ticket": Ticket,
  "warning"?: string
}
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid JSON body or invalid `assignee` |
| 404 | `NOT_FOUND` | Ticket not found |
| 400 | `UPDATE_FAILED` | Other update failure |

**Source:** `packages/pa-core/src/agent-api/routes/tickets.ts:77`

### 7. POST /api/tickets/:id/comments

Add a comment to a ticket.

**Query parameters:** none
**Path parameters:** `:id` — ticket id
**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `author` | string | yes | Validated via `validateAuthor` |
| `content` | string | yes | |

**Response schema (201):**

```json
{
  "ticket": Ticket,
  "comment": Comment
}
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid JSON body, or missing `author`/`content`, or invalid author |
| 404 | `NOT_FOUND` | Ticket not found |
| 400 | `COMMENT_FAILED` | Other comment failure |

**Source:** `packages/pa-core/src/agent-api/routes/tickets.ts:110`

---

## Board & Projects

### 8. GET /api/board

Build a kanban-style board view grouped by status.

**Query parameters:**

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `project` | string | no | Project key; resolved via `resolveProject` |
| `assignee` | string | no | Filter by assignee |
| `excludeTags` | string | no | Comma-separated tags to exclude. Defaults to `backlog,archived`. |
| `excludeTypes` | string | no | Comma-separated ticket types to exclude. Defaults to `fyi,work-report`. |

**Request body:** none
**Response schema (200):**

```json
{ "board": BoardView }
```

`BoardView` includes `project`, `columns`, `total`, and `assigneeCounts`.

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BOARD_FAILED` | Project resolution or board build failure |

**Source:** `packages/pa-core/src/agent-api/routes/tickets.ts:124`

### 9. GET /api/projects

List all configured projects (repos with a ticket prefix) with their active ticket counts.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{
  "projects": [
    { "key": string, "prefix": string, "description": string, "path": string, "activeTicketCount": number }
  ]
}
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 500 | `PROJECTS_FAILED` | Failure listing repos or counting tickets |

**Source:** `packages/pa-core/src/agent-api/routes/tickets.ts:139`

---

## Bulletins

### 10. GET /api/bulletin

List all active bulletins.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{
  "bulletins": [Bulletin],
  "count": number
}
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/bulletin.ts:7`

### 11. POST /api/bulletin

Create a new bulletin.

**Query parameters:** none
**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | yes | |
| `block` | `BulletinBlock` | yes | Block target (e.g. team name or `"all"`) |
| `except` | string[] | no | Teams to exempt |
| `message` | string | no | Body text (alias for `body`) |

**Response schema (201):**

```json
{ "bulletin": Bulletin }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid JSON body, or missing `title`/`block` |

**Source:** `packages/pa-core/src/agent-api/routes/bulletin.ts:11`

### 12. PATCH /api/bulletin/:id

Resolve a bulletin. Only `status=resolved` is supported.

**Query parameters:** none
**Path parameters:** `:id` — bulletin id
**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `status` | string | yes | Must be `"resolved"` |

**Response schema (200):**

```json
{ "success": true, "id": string }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid JSON body or unsupported status |
| 404 | `NOT_FOUND` | Bulletin not found |

**Source:** `packages/pa-core/src/agent-api/routes/bulletin.ts:18`

---

## Focus

### 13. GET /api/focus

Return the current focus list and work-in-progress summary.

**Query parameters:**

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `project` | string | no | Project filter |
| `assignee` | string | no | Assignee filter |
| `all` | string | no | When `"true"`, includes all items regardless of focus cutoff |
| `enrich` | string | no | When `"true"`, adds `suggestions` and `report_age_minutes` fields (currently empty/null placeholders) |

**Request body:** none
**Response schema (200):**

```json
{
  "focus": [FocusItem],
  "wip": { "byStatus": object, "byProject": object, "total": number },
  "suggestions"?: array,
  "report_age_minutes"?: number | null
}
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/focus.ts:6`

---

## Teams

### 14. GET /api/teams

List agent-team workspaces with folder counts.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{
  "teams": [
    {
      "name": string,
      "path": string,
      "folders": string[],
      "inbox_count": number,
      "ongoing_count": number,
      "wfr_count": number,
      "waiting_for_response_count": number
    }
  ]
}
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/teams.ts:7`

### 15. GET /api/pa-teams

List PA team configurations (from `teams/*.yaml`), excluding the `filePath` field.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{
  "teams": [TeamConfig]
}
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/teams.ts:8`

### 16. GET /api/pa-repos

List configured repos (from `repos.yaml`).

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{
  "repos": [
    { "name": string, "path": string, "description"?: string, "prefix"?: string }
  ]
}
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/teams.ts:9`

### 17. GET /api/agent-teams

List agent-team workspaces with inbox existence flag and folder counts.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{
  "teams": [
    {
      "name": string,
      "inbox_exists": boolean,
      "folders": string[],
      "inbox_count": number,
      "ongoing_count": number,
      "wfr_count": number,
      "waiting_for_response_count": number
    }
  ]
}
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/teams.ts:10`

---

## Documents & Images

### 18. GET /api/documents

Read a markdown document or list markdown files in a directory. The `path` query parameter is validated by the sandbox guard.

**Query parameters:**

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `path` | string | yes | Sandbox-relative path. Resolved via `normalizeSandboxPath` + `validateSandboxPath`. |

**Request body:** none
**Response schema (200) — file:**

```json
{
  "path": string,
  "content": string,
  "metadata": object
}
```

**Response schema (200) — directory:**

```json
{
  "path": string,
  "items": string[],
  "total": number
}
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Missing `path` query param |
| 403 | `SANDBOX_VIOLATION` | Path traversal denied |
| 404 | `NOT_FOUND` | Path does not exist |

**Source:** `packages/pa-core/src/agent-api/routes/documents.ts:9`

### 19. GET /api/images

Read an image file and return it with the correct `Content-Type`. The `path` query parameter is sandbox-validated.

**Query parameters:**

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `path` | string | yes | Sandbox-relative image path |

**Request body:** none
**Response (200):** Binary image body with `Content-Type` set to the detected image MIME type and `Content-Length` set to the file size.

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Missing `path` |
| 403 | `SANDBOX_VIOLATION` | Path traversal denied |
| 404 | `NOT_FOUND` | File not found |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Unsupported image format |

**Source:** `packages/pa-core/src/agent-api/routes/documents.ts:19`

### 20. POST /api/folders/:folderId/files/:fileId/sections

Insert a section into an existing markdown document addressed by `folderId/fileId`.

**Path parameters:** `:folderId`, `:fileId`
**Query parameters:** none
**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string \| null | yes | Section heading |
| `content` | string | yes | Section body |
| `location` | number | no | Insert location hint |
| `lineText` | string | no | Anchor line text |

**Response schema (200):**

```json
{
  "path": string,
  "content": string,
  "status": string,
  "insertedAt": object,
  "lineNumber": number,
  "metadata": object
}
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid JSON body, or insert failure |
| 403 | `SANDBOX_VIOLATION` | Path traversal denied |
| 404 | `NOT_FOUND` | File not found |

**Source:** `packages/pa-core/src/agent-api/routes/documents.ts:31`

---

## Folders

### 21. GET /api/folders/*

List or read markdown files from curated source folders: `teams/<name>/<folder>`, `inbox`, `for-later`, or `sinh-inputs/<subfolder>` (subfolders: `approved`, `rejected`, `deferred`, `done`, `ideas`, `for-later`).

**Path segments (after `/api/folders/`):** `source/[folder]/[filename]`
**Query parameters:** none
**Request body:** none
**Response schema (200) — directory listing:**

```json
{
  "source": string,
  "folder": string,
  "items": string[],
  "total": number,
  "hasMore": false
}
```

**Response schema (200) — file:**

```json
{
  "id": string,
  "source": string,
  "folder": string,
  "content": string,
  ...metadata
}
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Missing source, or team/folder required |
| 403 | `SANDBOX_VIOLATION` | Invalid path segment or path traversal denied |
| 404 | `NOT_FOUND` | Unknown source/folder, or file not found |

**Source:** `packages/pa-core/src/agent-api/routes/folders.ts:12`

---

## Configuration

### 22. GET /api/config/feedback-chips

Read the configured feedback chips (from `~/Documents/ai-usage/feedback-chips.yaml`). If the file does not exist, it is created with default chips and the defaults are returned.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{ "chips": string[] }
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/config.ts:10`

---

## Repos — Git Summary & Info

### 23. GET /api/repos/git-summary

Return a lightweight git summary for every configured repo: current branch, dirty flag, feature branch count, and `develop` ahead of `main` count.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{
  "repos": [
    {
      "key": string,
      "path": string,
      "prefix"?: string,
      "current_branch": string,
      "is_dirty": boolean,
      "feature_branch_count": number,
      "develop_ahead_of_main": number,
      "error"?: string
    }
  ]
}
```

**Error codes:** none specific (per-repo errors are captured in the `error` field).

**Source:** `packages/pa-core/src/agent-api/routes/repos.ts:28`

### 24. GET /api/repos/:key/git-info

Return detailed git info for a single repo: current branch, main/develop branch info, ahead/behind counts, unmerged feature branches, and working directory status.

**Path parameters:** `:key` — repo key (matches `^[a-zA-Z0-9-]+$`)
**Query parameters:**

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `main` | string | no | Override main branch name (defaults to repo config or `main`) |
| `develop` | string | no | Override develop branch name (defaults to repo config or `develop`). Set to `none` to skip develop checks. |

**Request body:** none
**Response schema (200):**

```json
{
  "repo": { "key": string, "path": string, "description"?: string, "prefix"?: string },
  "current_branch": string,
  "main_branch": { "name": string, "exists": boolean, "latestCommit"?: { "hash": string, "hash_short"?: string, "message": string, "date": string } },
  "develop_branch": { "name": string, "exists": boolean, "latestCommit"?: object },
  "main_vs_develop": { "main_ahead": number, "develop_ahead": number, "diverged": boolean },
  "feature_branches": [{ "name": string, "latestCommit": { "hash_short": string, "message": string, "date": string } }],
  "working_directory": { "clean": boolean, "uncommitted_count": number },
  "errors"?: { "main"?: string, "develop"?: string, "featureBranches"?: string, "workingDirectory"?: string }
}
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Missing/invalid repo key or branch name |
| 400 | `PATH_NOT_FOUND` | Repo path does not exist on disk |
| 400 | `NOT_GIT_REPO` | Path is not a git repository |
| 404 | `NOT_FOUND` | Repo key not found in `repos.yaml` |

**Source:** `packages/pa-core/src/agent-api/routes/repos.ts:55`

---

## Repos — Branches & Commits

### 25. GET /api/repos/:key/branches

List local branches for a repo with current-branch flag and latest commit info.

**Path parameters:** `:key` — repo key
**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{
  "repo": { "key": string, "path": string },
  "branches": [
    {
      "name": string,
      "is_current": boolean,
      "latest_commit": { "hash_short": string, "message": string, "date": string, "author": string }
    }
  ]
}
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid repo key |
| 400 | `PATH_NOT_FOUND` | Repo path does not exist |
| 400 | `NOT_GIT_REPO` | Not a git repository |
| 404 | `NOT_FOUND` | Repo key not found |

**Source:** `packages/pa-core/src/agent-api/routes/repo-commits.ts:12`

### 26. GET /api/repos/:key/commits

Paginated commit history for a branch.

**Path parameters:** `:key` — repo key
**Query parameters:**

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `branch` | string | no | Branch or `HEAD` (default). Must match `^[a-zA-Z0-9._\-/]+$`. |
| `limit` | number | no | Page size (1–200, default 50) |
| `offset` | number | no | Skip count (default 0) |

**Request body:** none
**Response schema (200):**

```json
{
  "repo": { "key": string, "path": string },
  "branch": string,
  "commits": [
    {
      "hash": string,
      "hash_short": string,
      "author_name": string,
      "author_email": string,
      "date": string,
      "message": string,
      "diff_summary": { "files_changed": number, "insertions": number, "deletions": number }
    }
  ],
  "meta": { "branch": string, "total": number, "limit": number, "offset": number }
}
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid repo key or branch name |
| 400 | `PATH_NOT_FOUND` | Repo path does not exist |
| 400 | `NOT_GIT_REPO` | Not a git repository |
| 404 | `NOT_FOUND` | Repo key not found |

**Source:** `packages/pa-core/src/agent-api/routes/repo-commits.ts:19`

---

## Repos — Git Extension

### 27. GET /api/repos/:key/diff

Return the unified diff for a single commit SHA.

**Path parameters:** `:key` — repo key
**Query parameters:**

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `commit` | string | yes | 40-character hex SHA |

**Request body:** none
**Response schema (200):**

```json
{
  "repo": { "key": string, "path": string },
  "commit": string,
  "diff_entries": [
    {
      "old_path": string,
      "new_path": string,
      "change_type": "added" | "deleted" | "modified" | "renamed",
      "binary": boolean,
      "hunks": [{ "old_start": number, "old_lines": number, "new_start": number, "new_lines": number, "lines": [{ "type": "add" | "del" | "context", "content": string }] }]
    }
  ],
  "meta": { "commit": string, "files_changed": number, "insertions": number, "deletions": number }
}
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid repo key, missing `commit`, or invalid SHA format |
| 404 | `NOT_FOUND` | Repo key or commit SHA not found |
| 400 | `PATH_NOT_FOUND` | Repo path does not exist |
| 400 | `NOT_GIT_REPO` | Not a git repository |

**Source:** `packages/pa-core/src/agent-api/routes/repo-git-ext.ts:13`

### 28. GET /api/repos/:key/branches/remote

List remote-tracking branches for a repo.

**Path parameters:** `:key` — repo key
**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{
  "repo": { "key": string, "path": string },
  "remote_branches": [
    { "name": string, "tracking_local": null, "latest_commit": { "hash_short": string, "message": string, "date": string, "author": string } }
  ]
}
```

**Error codes:** same as `GET /api/repos/:key/diff` (without the commit-specific codes).

**Source:** `packages/pa-core/src/agent-api/routes/repo-git-ext.ts:23`

### 29. GET /api/repos/:key/compare

Compare two refs (branches or tags) and return the paginated list of commits between them.

**Path parameters:** `:key` — repo key
**Query parameters:**

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `from` | string | yes | Base ref (must match `^[a-zA-Z0-9._\-/]+$`) |
| `to` | string | yes | Target ref |
| `limit` | number | no | Page size (1–200, default 50) |
| `offset` | number | no | Skip count (default 0) |

**Request body:** none
**Response schema (200):**

```json
{
  "repo": { "key": string, "path": string },
  "from": string,
  "to": string,
  "commits": [{ "hash": string, "hash_short": string, "author_name": string, "author_email": string, "date": string, "message": string }],
  "count": number,
  "meta": { "from": string, "to": string, "total": number, "limit": number, "offset": number }
}
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid repo key, missing `from`/`to`, or invalid ref names |
| 404 | `NOT_FOUND` | Repo key not found |
| 400 | `PATH_NOT_FOUND` | Repo path does not exist |
| 400 | `NOT_GIT_REPO` | Not a git repository |

**Source:** `packages/pa-core/src/agent-api/routes/repo-git-ext.ts:29`

---

## Repos — Deployments

### 30. GET /api/repos/:key/deployments

List deployments for a specific repo, filtered by status and date.

**Path parameters:** `:key` — repo key (matches `^[a-zA-Z0-9-]+$`)
**Query parameters:**

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `status` | string | no | `all` (default) \| `running` \| `finished` (terminal: `success`/`partial`/`failed`/`crashed`/`dead`) |
| `since` | string | no | `YYYY-MM-DD` date filter. Defaults to today. |
| `all` | string | no | When `"true"`, ignores `since` and returns all. |
| `limit` | number | no | Max results (default 50, max 200) |

**Request body:** none
**Response schema (200):**

```json
{
  "repo": { "key": string, "path": string, "description"?: string, "prefix"?: string },
  "deployments": [DeploymentStatus],
  "total": number,
  "filter": { "status": string, "limit": number, "since": string | undefined }
}
```

Running deployments whose PID is no longer alive are marked `"dead"`.

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid repo key or invalid `since` date |
| 404 | `NOT_FOUND` | Repo key not found |

**Source:** `packages/pa-core/src/agent-api/routes/repo-deployments.ts:12`

---

## Deployments

### 31. GET /api/deployments

List deployments across all repos, filtered by date or ticket id.

**Query parameters:**

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `since` | string | no | `YYYY-MM-DD` date. Defaults to 48 hours ago (ISO). |
| `all` | string | no | When `"true"`, ignores `since` and returns all. |
| `limit` | number | no | Max results (default 50, max 200) |
| `ticket_id` | string | no | Filter by ticket id |

**Request body:** none
**Response schema (200):**

```json
{
  "deployments": [DeploymentStatus],
  "total": number,
  "filter": { "since": string | undefined, "limit": number, "status": "all", "ticket_id": string | null }
}
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid `since` date format |

**Source:** `packages/pa-core/src/agent-api/routes/deployments.ts:31`

### 32. GET /api/deployments/:id

Fetch deployment detail including primer path, error, exit code, rating, and evaluator results.

**Path parameters:** `:id` — deployment id (matches `^[a-zA-Z0-9-]+$`)
**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{
  "deploy_id": string,
  "team": string,
  "status": string,
  "started_at": string,
  "agents": array,
  "completed_at"?: string,
  "summary"?: string,
  "error"?: string,
  "exit_code"?: number,
  "log_file"?: string,
  "rating"?: unknown,
  "primer"?: string,
  "primer_path"?: string,
  "provider"?: string,
  "pid"?: number,
  "ticket_id"?: string,
  "objective"?: string,
  "repo"?: string,
  "runtime"?: string,
  "binary"?: string,
  "effective_timeout_seconds"?: number,
  "evaluator_results"?: [EvaluatorResult]
}
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid deployment id format |
| 404 | `NOT_FOUND` | Deployment not found |

**Source:** `packages/pa-core/src/agent-api/routes/deployments.ts:42`

### 33. GET /api/deployments/:id/activity

Return activity events for a deployment. Prefers structured activity logs; falls back to registry events when no activity log exists.

**Path parameters:** `:id` — deployment id
**Query parameters:**

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `since` | string | no | ISO timestamp filter |

**Request body:** none
**Response schema (200):**

```json
{
  "activity_events": [
    { "ts": string, "deploy_id": string, "agent": string, "event": string, "data": object }
  ]
}
```

Event names (phone-format): `thinking`, `tool_use_detail`, `task_failed`, `text`, `deployment_started`, `deployment_completed`, plus raw registry event names.

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid deployment id format |

**Source:** `packages/pa-core/src/agent-api/routes/deployments.ts:50`

---

## Deploy Routing

### 34. GET /api/deploy-routing

Return deploy routing metadata: available teams with their phone-visible deploy modes, default provider/model, and the list of configured repos.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{
  "teams": [
    {
      "name": string,
      "description": string,
      "default_provider": string | null,
      "default_model": string | null,
      "modes": [{ "id": string, "label": string, "modeType": string | null }]
    }
  ],
  "repos": [{ "name": string, "path": string, "description"?: string }]
}
```

Modes where `phone_visible === false` or `mode_type === "interactive"` are excluded.

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/deploy-routing.ts:16`

---

## Deploy Control

### 35. POST /api/deploy

Trigger a deployment. Returns `202` on accepted/failed per the phone contract (never `500`).

**Query parameters:** none
**Request body (`DeployRequest`):**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `team` | string | yes | Team name |
| `mode` | string | no | Deploy mode id |
| `objective` | string | no | Free-text objective (max 10000 chars) |
| `evaluateDeployment` | string | no | Deployment id to evaluate (`d-xxxxxx`) |
| `repo` | string | no | Repo key or path |
| `ticket` | string | no | Ticket id (`^[A-Z][A-Z0-9]+-[0-9]+$`) |
| `provider` | string | no | Provider name |
| `model` | string | no | Model override |
| `teamModel` | string | no | Team model override |
| `agentModel` | string | no | Agent model override |
| `runtime` | string | no | Runtime adapter: `pi` or `opencode`; omitted defaults to OpenCode. |
| `resume` | string | no | Deployment id to resume |
| `autonomy` | string | no | `low`, `medium`, or `high` |
| `timeout` | number | no | Seconds; resolved via `withResolvedDeployTimeout` |
| `dryRun` | boolean | no | Mutually exclusive with `background` |
| `background` | boolean | no | Defaults to `true`; mutually exclusive with `dryRun` |
| `listModes` | boolean | no | List available modes for the team instead of deploying |
| `validate` | boolean | no | Validate the request without deploying |

**Response schema (202):**

```json
{
  "team": string,
  "mode"?: string | null,
  "status": "success" | "pending" | "failed",
  "deployment_id"?: string,
  "reason"?: string
}
```

On success/pending with a `deploymentId`, the deploy session is registered with the `SessionManager` (best-effort).

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid JSON body or failed field validation |
| 501 | `NOT_IMPLEMENTED` | No adapter `deploy` hook configured |

**Source:** `packages/pa-core/src/agent-api/routes/deploy-control.ts:9`

An unsupported `runtime` value returns `400 BAD_REQUEST` before any runtime process is spawned. Select Pi explicitly with:

```bash
curl -X POST http://127.0.0.1:9848/api/deploy \
  -H 'content-type: application/json' \
  -d '{"team":"builder","mode":"implement","runtime":"pi","background":true}'
```

Omit `runtime` to retain the existing OpenCode behavior:

```bash
curl -X POST http://127.0.0.1:9848/api/deploy \
  -H 'content-type: application/json' \
  -d '{"team":"builder","mode":"implement","background":true}'
```

### 36. POST /api/self-update

Trigger a self-update of the running adapter. Requires the adapter to provide a `selfUpdate` hook.

**Query parameters:** none
**Request body:** none
**Response schema (202):** Adapter-defined result object.

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 501 | `NOT_IMPLEMENTED` | No `selfUpdate` hook configured |

**Source:** `packages/pa-core/src/agent-api/routes/deploy-control.ts:33`

### 37. GET /api/self-update/status

Return the current self-update status. Requires the adapter to provide a `getSelfUpdateStatus` hook.

**Query parameters:** none
**Request body:** none
**Response schema (200):** Adapter-defined status object.

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 501 | `NOT_IMPLEMENTED` | No `getSelfUpdateStatus` hook configured |

**Source:** `packages/pa-core/src/agent-api/routes/deploy-control.ts:39`

---

## Deploy Status

### 38. GET /api/deploy/status/:id

Query the status of a deployment.

**Path parameters:** `:id` — deployment id
**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{ "status": DeploymentStatus }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 404 | `NOT_FOUND` | Deployment not found |

**Source:** `packages/pa-core/src/agent-api/routes/deploy-status.ts:56`

### 39. GET /api/deploy/events/:id

Return the raw registry event log for a deployment.

**Path parameters:** `:id` — deployment id
**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{ "events": [RegistryEvent] }
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/deploy-status.ts:64`

### 40. POST /api/deploy/start

Emit a `started` registry event for a deployment. Used by adapter CLIs to record deployment start.

**Query parameters:** none
**Request body (`StartDeployBody`):**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `deploymentId` | string | yes | |
| `team` | string | yes | |
| `primer` | string | no | |
| `agents` | string[] | no | |
| `models` | object | no | |
| `ticketId` | string | no | |
| `objective` | string | no | |
| `provider` | string | no | |
| `repo` | string | no | |
| `runtime` | string | no | |
| `binary` | string | no | |
| `resumedFromDeploymentId` | string | no | |

**Response schema (200):**

```json
{ "ok": true, "event": "started" }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Missing `deploymentId` or `team` |

**Source:** `packages/pa-core/src/agent-api/routes/deploy-status.ts:71`

### 41. POST /api/deploy/pid

Emit a `pid` registry event associating a PID with a deployment.

**Query parameters:** none
**Request body (`PidBody`):**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `deploymentId` | string | yes | |
| `team` | string | yes | |
| `pid` | number | yes | |

**Response schema (200):**

```json
{ "ok": true, "event": "pid" }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Missing `deploymentId`, `team`, or `pid` |

**Source:** `packages/pa-core/src/agent-api/routes/deploy-status.ts:94`

### 42. POST /api/deploy/complete

Emit a `completed` registry event.

**Query parameters:** none
**Request body (`CompleteBody`):**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `deploymentId` | string | yes | |
| `team` | string | yes | |
| `status` | `"success"` \| `"partial"` \| `"failed"` | no | |
| `summary` | string | no | |
| `logFile` | string | no | |
| `exitCode` | number | no | |
| `fallback` | boolean | no | |

**Response schema (200):**

```json
{ "ok": true, "event": "completed" }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Missing `deploymentId` or `team` |

**Source:** `packages/pa-core/src/agent-api/routes/deploy-status.ts:104`

### 43. POST /api/deploy/crash

Emit a `crashed` registry event.

**Query parameters:** none
**Request body (`CrashBody`):**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `deploymentId` | string | yes | |
| `team` | string | yes | |
| `error` | string | no | |
| `exitCode` | number | no | |

**Response schema (200):**

```json
{ "ok": true, "event": "crashed" }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Missing `deploymentId` or `team` |

**Source:** `packages/pa-core/src/agent-api/routes/deploy-status.ts:122`

### 44. POST /api/deploy/amend

Emit an `amended` registry event to update a completed deployment's status/summary.

**Query parameters:** none
**Request body (`AmendedBody`):**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `deploymentId` | string | yes | |
| `team` | string | yes | |
| `note` | string | no | |
| `status` | `"success"` \| `"partial"` \| `"failed"` | no | |
| `summary` | string | no | |

**Response schema (200):**

```json
{ "ok": true, "event": "amended" }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Missing `deploymentId` or `team` |

**Source:** `packages/pa-core/src/agent-api/routes/deploy-status.ts:132`

---

## Timers

### 45. GET /api/timers

List systemd timers (output of `systemctl list-timers` parsed by `listSystemdTimers`).

**Query parameters:** none
**Request body:** none
**Response schema (200):** The parsed timer list returned by `listSystemdTimers()`.

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 500 | `INTERNAL_ERROR` | Failed to list timers |

**Source:** `packages/pa-core/src/agent-api/routes/timers.ts:7`

---

## Actions & Inbox

### 46. GET /api/inbox

List inbox items (markdown files in `sinh-inputs/inbox`) with type counts.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{
  "items": [
    { "id": string, "type": string, "size": number, "modified": string, "title": string, "date"?: string }
  ],
  "count_by_type": { [type: string]: number }
}
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/actions.ts:20`

### 47. POST /api/inbox/:id/action

Perform an action on an inbox item. Moves the file to the appropriate folder and optionally annotates feedback.

**Path parameters:** `:id` — markdown filename (must be a safe `.md` filename)
**Query parameters:** none
**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `action` | string | yes | One of: `approve`, `reject`, `defer`, `acknowledge`, `save-for-later`, `append-section` |
| `title` | string | required for `append-section` | Section heading |
| `content` | string | no | Section body for `append-section` |
| `note` | string | no | Feedback note (approve/acknowledge/defer) |
| `chips` | string[] | no | Feedback chips |
| `what_is_wrong` | string | required for `reject` (unless `pending: true`) | |
| `what_to_fix` | string | required for `reject` (unless `pending: true`) | |
| `priority` | string | no | Reject priority |
| `reason` | string | no | Defer reason |
| `requeue_after` | string | no | Defer requeue date |
| `pending` | boolean | no | When `true` with `reject`, marks pending-reject-feedback without moving |

**Response schema (200):** Varies by action, e.g.:

```json
{ "status": "approved" | "rejected" | "pending-reject-feedback" | "deferred" | "acknowledged" | "saved-for-later" | "section-appended", "file": string, "title"?: string }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid JSON body, missing `action`, unknown action, missing required fields |
| 403 | `INVALID_PATH` | Invalid filename |
| 403 | `SANDBOX_VIOLATION` | Path traversal denied |
| 404 | `NOT_FOUND` | File not found |

**Source:** `packages/pa-core/src/agent-api/routes/actions.ts:27`

### 48. POST /api/sinh-inputs/:folder/:filename/action

Perform an action on a sinh-inputs item in `approved`, `rejected`, `deferred`, `done`, or `ideas` folders.

**Path parameters:** `:folder` — one of `approved`, `rejected`, `deferred`, `done`, `ideas`; `:filename` — safe `.md` filename
**Query parameters:** none
**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `action` | string | yes | One of: `requeue`, `archive`, `save-for-later`, `append-section` |
| `title` | string | required for `append-section` | |
| `content` | string | no | Section body for `append-section` |

**Response schema (200):**

```json
{ "status": "requeued" | "archived" | "saved-for-later" | "section-appended", "file": string, "from": string, "title"?: string }
```

`save-for-later` is only available for `approved` items.

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid JSON body, missing/unknown action, or invalid `save-for-later` source |
| 403 | `INVALID_PATH` | Invalid filename |
| 403 | `SANDBOX_VIOLATION` | Path traversal denied |
| 404 | `NOT_FOUND` | Unknown folder or file not found |

**Source:** `packages/pa-core/src/agent-api/routes/actions.ts:57`

### 49. POST /api/ideas

Create a new idea ticket from a title and optional fields.

**Query parameters:** none
**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | yes | |
| `what` / `content` | string | no | Defaults to `title` |
| `why` | string | no | Added under `## Why` |
| `notes` | string | no | Added under `## Notes` |
| `tags` | string[] \| string | no | Array or space-separated string |
| `project` | string | no | Defaults to first repo with a prefix |
| `priority` | string | no | `critical` \| `high` \| `medium` (default) \| `low` |
| `assignee` | string | no | Defaults to `requirements` |
| `effort` | string | no | `XS` \| `S` \| `M` (default) \| `L` \| `XL` |
| `from` | string | no | Defaults to `api` |
| `to` | string | no | Defaults to `requirements` |
| `actor` | string | no | Audit actor; defaults to `api` |

**Response schema (201):**

```json
{ "status": "created", "ticket": Ticket, "file": null }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid JSON body or missing `title` |

**Source:** `packages/pa-core/src/agent-api/routes/actions.ts:90`

### 50. PATCH /api/tickets/:id/comments/:commentId

Edit a comment's content.

**Path parameters:** `:id` — ticket id; `:commentId` — comment id
**Query parameters:** none
**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `content` | string | yes | |
| `actor` | string | no | Audit actor; defaults to `api` |

**Response schema (200):**

```json
{ "ticket": Ticket, "comment": Comment }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid JSON body or missing `content` |
| 404 | `NOT_FOUND` | Ticket or comment not found |
| 400 | `EDIT_FAILED` | Other edit failure |

**Source:** `packages/pa-core/src/agent-api/routes/actions.ts:119`

### 51. DELETE /api/tickets/:id/comments/:commentId

Delete a comment.

**Path parameters:** `:id` — ticket id; `:commentId` — comment id
**Query parameters:**

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `actor` | string | no | Audit actor; defaults to `api` |

**Request body:** none
**Response schema (204):** No body.

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 404 | `NOT_FOUND` | Ticket or comment not found |
| 400 | `DELETE_FAILED` | Other delete failure |

**Source:** `packages/pa-core/src/agent-api/routes/actions.ts:133`

### 52. POST /api/tickets/:id/attachments

Attach an existing sandbox-relative path to a ticket.

**Path parameters:** `:id` — ticket id
**Query parameters:** none
**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | string | yes | Sandbox-relative path (must not start with `/` or contain `..`/`\\`) |
| `actor` | string | no | Audit actor; defaults to `api` |

**Response schema (200):**

```json
{ "ticket": Ticket }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid JSON body or missing `path` |
| 403 | `SANDBOX_VIOLATION` | Invalid attachment path |
| 404 | `NOT_FOUND` | Ticket not found |
| 400 | `ATTACH_FAILED` | Other attach failure |

**Source:** `packages/pa-core/src/agent-api/routes/actions.ts:143`

### 53. POST /api/tickets/:id/attachments/upload

Upload an image file (multipart form) and attach it to a ticket. Stored under `attachments/<ticketId>/<timestamp>-<sanitized-name>`.

**Path parameters:** `:id` — ticket id
**Query parameters:** none
**Request body:** `multipart/form-data` with field `file` of type `File`. Allowed extensions: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`. Max size: 5 MB.

**Response schema (201):**

```json
{ "docRef": string }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Body parse failure, missing `file`, or disallowed extension |
| 403 | `INVALID_PATH` | Invalid sanitized filename |
| 404 | `NOT_FOUND` | Ticket not found |
| 413 | `PAYLOAD_TOO_LARGE` | File exceeds 5 MB |
| 500 | `UPLOAD_FAILED` | Storage failure |

**Source:** `packages/pa-core/src/agent-api/routes/actions.ts:158`

### 54. POST /api/tickets/:id/move

Move a ticket to a different project.

**Path parameters:** `:id` — ticket id
**Query parameters:** none
**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `project` | string | yes | Target project key (must be a repo with a prefix) |
| `actor` | string | no | Audit actor; defaults to `api` |

**Response schema (200):**

```json
{ "ticket": Ticket }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid JSON body or missing `project` |
| 400 | `SAME_PROJECT` | Ticket is already in the target project |
| 400 | `INVALID_PROJECT` | Unknown project (response includes `validProjects` as a comma-joined string) |
| 404 | `NOT_FOUND` | Ticket not found |
| 400 | `MOVE_FAILED` | Other move failure |

**Source:** `packages/pa-core/src/agent-api/routes/actions.ts:191`

---

## Skills

### 55. GET /api/skills

Return the full skill registry report: inventory, scanned roots, validation issues, and OpenCode visibility metadata.

**Query parameters:** none
**Request body:** none
**Response schema (200):** The object returned by `buildSkillRegistryReport()` — includes `generatedAt`, `scannedRoots`, `inventory`, `issues`, and `openCodeVisibility`.

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/skills.ts:6`

---

## Knowledge

### 56. GET /api/knowledge-boundaries

List knowledge boundaries (item types and their storage locations).

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{ "boundaries": [KnowledgeBoundary] }
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/knowledge.ts:6`

### 57. GET /api/improvement-candidates

List improvement candidates aggregated from session logs and other sources.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{ "candidates": [ImprovementCandidate] }
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/knowledge.ts:7`

---

## Dashboard

All dashboard endpoints are **read-only** and include a `readOnly: true` flag in their response. Limits: deployments 200, tickets 500, skills 250, improvement candidates 500.

### 58. GET /api/dashboard/overview

Return aggregate counts for the dashboard.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{
  "readOnly": true,
  "mutationRoutes": [],
  "limits": { "deployments": 200, "tickets": 500, "skills": 250, "improvementCandidates": 500 },
  "counts": { "deployments": number, "tickets": number, "skills": number, "knowledgeAreas": number, "improvementCandidates": number }
}
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/dashboard.ts:18`

### 59. GET /api/dashboard/views/deployments

Return up to 200 deployment status records.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{ "deployments": [DeploymentStatus], "count": number, "readOnly": true }
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/dashboard.ts:43`

### 60. GET /api/dashboard/views/tickets

Return up to 500 tickets.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{ "tickets": [Ticket], "count": number, "readOnly": true }
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/dashboard.ts:48`

### 61. GET /api/dashboard/views/skills

Return up to 250 skill inventory entries plus scan metadata.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{
  "generatedAt": string,
  "scannedRoots": string[],
  "inventory": [SkillEntry],
  "count": number,
  "readOnly": true
}
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/dashboard.ts:53`

### 62. GET /api/dashboard/views/knowledge-memory

Return knowledge boundaries.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{ "boundaries": [KnowledgeBoundary], "count": number, "readOnly": true }
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/dashboard.ts:64`

### 63. GET /api/dashboard/views/improvement-candidates

Return up to 500 improvement candidates.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{ "candidates": [ImprovementCandidate], "count": number, "readOnly": true }
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/dashboard.ts:69`

### 64. GET /api/dashboard/views/opencode-integration

Return OpenCode integration metadata: runtime owner, deployment contexts (filtered to `opencode`/`opa`), memory-doc sources, skill injection info, and OpenCode-safe validation warnings.

**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{
  "runtimeOwner": string,
  "deploymentContexts": [{ "deployId": string, "runtime": string, "binary": string, "ticketId": string | null }],
  "memoryDocSources": string[],
  "skillInjection": { "source": string, "primerSummaryBudgetChars": number, "primerSkillSummary": string, "scannedRoots": string[] },
  "opencodeSafeValidationWarnings": string[],
  "readOnly": true
}
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/dashboard.ts:74`

---

## Sessions

### 65. GET /api/sessions

List all active sessions registered with the `SessionManager`.

**Query parameters:** none
**Request body:** none
**Response schema (200):** JSON array of session records:

```json
[
  { "id": string, "deploymentId"?: string, "model"?: string, "status": string, ... }
]
```

**Error codes:** none specific.

**Source:** `packages/pa-core/src/agent-api/routes/sessions.ts:20`

### 66. POST /api/sessions

Register a deploy session (used by `opa deploy` CLI).

**Query parameters:** none
**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `deploymentId` | string | yes | |
| `model` | string | no | |

**Response schema (201):**

```json
{ "sessionId": string, "deploymentId": string, "model"?: string, "status": string }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `BAD_REQUEST` | Invalid JSON body or missing `deploymentId` |
| 503 | `CAPACITY_REACHED` | Hub is at capacity (response includes `limit`) |

**Source:** `packages/pa-core/src/agent-api/routes/sessions.ts:28`

### 67. POST /api/sessions/:id/stop

Terminate a session by id.

**Path parameters:** `:id` — session id
**Query parameters:** none
**Request body:** none
**Response schema (200):**

```json
{ "status": "stopped" }
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 404 | `NOT_FOUND` | Session not found |

**Source:** `packages/pa-core/src/agent-api/routes/sessions.ts:54`

### 68. GET /api/sessions/:id/stream

SSE stream of a session's events (read-only). Deploy sessions return `404` with a distinct message because they have no child process to stream.

**Path parameters:** `:id` — session id
**Query parameters:** none
**Request body:** none
**Response (200):** `text/event-stream` — emits `ready`, session event types (`thinking`, `tool_use`, `tool_result`, `text`, `error`, `end`), and closes on session end or client disconnect.

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 404 | `NOT_FOUND` | Session not found, or deploy session (no stream support) |

**Source:** `packages/pa-core/src/agent-api/routes/sessions.ts:64`

---

## Endpoint Count Summary

| Domain | Count | Endpoints |
|--------|-------|-----------|
| Health | 1 | `GET /api/health` |
| Tickets | 6 | `GET/POST /api/tickets`, `GET /api/tickets/:id`, `GET /api/tickets/:id/review`, `PATCH /api/tickets/:id`, `POST /api/tickets/:id/comments` |
| Board & Projects | 2 | `GET /api/board`, `GET /api/projects` |
| Bulletins | 3 | `GET/POST /api/bulletin`, `PATCH /api/bulletin/:id` |
| Focus | 1 | `GET /api/focus` |
| Teams | 4 | `GET /api/teams`, `/api/pa-teams`, `/api/pa-repos`, `/api/agent-teams` |
| Documents & Images | 3 | `GET /api/documents`, `GET /api/images`, `POST /api/folders/:folderId/files/:fileId/sections` |
| Folders | 1 | `GET /api/folders/*` |
| Configuration | 1 | `GET /api/config/feedback-chips` |
| Repos — Git Summary & Info | 2 | `GET /api/repos/git-summary`, `GET /api/repos/:key/git-info` |
| Repos — Branches & Commits | 2 | `GET /api/repos/:key/branches`, `GET /api/repos/:key/commits` |
| Repos — Git Extension | 3 | `GET /api/repos/:key/diff`, `/branches/remote`, `/compare` |
| Repos — Deployments | 1 | `GET /api/repos/:key/deployments` |
| Deployments | 3 | `GET /api/deployments`, `GET /api/deployments/:id`, `GET /api/deployments/:id/activity` |
| Deploy Routing | 1 | `GET /api/deploy-routing` |
| Deploy Control | 3 | `POST /api/deploy`, `POST /api/self-update`, `GET /api/self-update/status` |
| Deploy Status | 7 | `GET /api/deploy/status/:id`, `GET /api/deploy/events/:id`, `POST /api/deploy/start`, `/pid`, `/complete`, `/crash`, `/amend` |
| Timers | 1 | `GET /api/timers` |
| Actions & Inbox | 9 | `GET /api/inbox`, `POST /api/inbox/:id/action`, `POST /api/sinh-inputs/:folder/:filename/action`, `POST /api/ideas`, `PATCH /api/tickets/:id/comments/:commentId`, `DELETE /api/tickets/:id/comments/:commentId`, `POST /api/tickets/:id/attachments`, `POST /api/tickets/:id/attachments/upload`, `POST /api/tickets/:id/move` |
| Skills | 1 | `GET /api/skills` |
| Knowledge | 2 | `GET /api/knowledge-boundaries`, `GET /api/improvement-candidates` |
| Dashboard | 7 | `GET /api/dashboard/overview`, `/views/deployments`, `/views/tickets`, `/views/skills`, `/views/knowledge-memory`, `/views/improvement-candidates`, `/views/opencode-integration` |
| Sessions | 4 | `GET /api/sessions`, `POST /api/sessions`, `POST /api/sessions/:id/stop`, `GET /api/sessions/:id/stream` |
| **Total** | **68** | |

All 68 endpoints are derived from `packages/pa-core/src/agent-api/routes/` and the `GET /api/health` route defined in `packages/pa-core/src/agent-api/index.ts`. The `GET /dashboard` HTML page is intentionally excluded — it is a server-rendered HTML view, not a JSON REST endpoint.
