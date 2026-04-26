# Area Skill: Ops Review

You are reviewing the **operational quality** of a system — build pipeline, reliability, monitoring, error handling, and deployment. Follow this checklist and produce severity-rated findings. All findings use the severity rubric from `review.md`.

---

## Checklist

### 1. Build Pipeline

- [ ] Can the project be built cleanly from scratch? (`pnpm build`, `dart compile`, `nix build`, etc.)
- [ ] Are build artifacts reproducible? Is the build deterministic?
- [ ] Are build steps documented and automatable (scripts, Makefile, Nix, CI)?
- [ ] Does `pnpm typecheck` (or equivalent) pass with no errors?
- [ ] Is there a linting step? Does it pass?
- [ ] Are build artifacts excluded from version control? (`.gitignore` covers `dist/`, `build/`, `.dart_tool/`)

**What to check:** Run `pnpm build`, `pnpm typecheck`, `dart analyze`. Read `package.json` scripts. Read `flake.nix` if present.

### 2. CI/CD

- [ ] Is there a CI pipeline? (GitHub Actions, GitLab CI, etc.)
- [ ] Does CI run on every PR/push?
- [ ] Does CI run tests, type checks, and linting?
- [ ] Is there a deployment step in CI, or is deployment manual?
- [ ] Are CI secrets managed safely (not hardcoded in workflow files)?

**What to check:** Check `.github/workflows/`, `.gitlab-ci.yml`, or similar. Note if no CI exists.

### 3. Error Handling & Reliability

- [ ] Are errors surfaced to the user with useful messages? (No silent failures)
- [ ] Are critical error paths handled gracefully — cleanup, rollback, user notification?
- [ ] Are async operations (promises, futures) properly awaited and errors caught?
- [ ] Are external calls (API, filesystem, shell commands) wrapped with error handling?
- [ ] Are timeouts in place for long-running operations?
- [ ] On failure, does the system leave things in a consistent state? (No partial writes, no orphaned processes)

**What to check:** Read command handlers and main entry points. Search for `try/catch`, `.catch()`, error handling patterns. Check for `Promise` chains without `.catch`.

### 4. Logging & Observability

- [ ] Are important events logged (start, completion, errors, key state transitions)?
- [ ] Is log verbosity appropriate for production? (No debug noise by default)
- [ ] Are logs structured (JSON) or at minimum parseable?
- [ ] Are there progress indicators for long-running operations?
- [ ] Can the system be debugged when something goes wrong? Is there enough context in logs?

**What to check:** Review logging patterns in source. Check for debug vs. info vs. error log levels.

### 5. Deployment & Operations

- [ ] Is there a deployment procedure documented (README, runbook, script)?
- [ ] Is the deployment process repeatable and automatable?
- [ ] Are configuration files validated before use? (Bad config = clear error, not crash)
- [ ] Are there version management practices? (Semantic versioning, changelog, version bump scripts)
- [ ] Is there a rollback/recovery procedure if deployment fails?
- [ ] Are environment differences handled? (dev vs. prod config, local vs. CI paths)

**What to check:** Read `README.md`, `CLAUDE.md`, `scripts/` directory. Review `package.json` for version scripts. Check for config validation in startup code.

---

## Finding Guidance

| What you find | Severity |
|---------------|----------|
| Build is broken (cannot build from clean) | Critical |
| Critical error paths have no error handling (silent failure) | Critical |
| No CI pipeline and no documented deployment procedure | Major |
| Async errors not caught, potential unhandled rejections | Major |
| Insufficient logging — cannot diagnose failures | Major |
| Build is slow or non-deterministic | Minor |
| Missing lint step, minor CI gaps | Minor |
| Documentation gap, deployment could be more automated | Info |

---

## Output

For each finding, write:

```markdown
### [SEVERITY] Finding title

- **Area:** Ops
- **Severity:** Critical / Major / Minor / Info
- **Location:** file_path:line_number (or script/pipeline step)
- **Description:** What was found
- **Evidence:** Command output, code snippet, or observation
- **Recommendation:** What to do about it
- **Effort:** S / M / L
```

After completing the checklist, summarize: "Ops: N findings (X critical, Y major, Z minor, W info)"
