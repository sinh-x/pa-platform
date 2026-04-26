# Area Skill: Security Review

You are reviewing the **security posture** of a system. Follow this checklist to explore the codebase and produce severity-rated findings. All findings use the severity rubric from `review.md`.

---

## Checklist

### 1. Dependency Audit

- [ ] Are dependencies pinned or locked? (`package-lock.json`, `yarn.lock`, `pubspec.lock`, `flake.lock`)
- [ ] Run a dependency audit if tooling supports it: `pnpm audit`, `dart pub outdated`, `nix flake metadata`
- [ ] Are there known-vulnerable packages? Check audit output for severity.
- [ ] Are dev dependencies accidentally bundled into production builds?
- [ ] Are dependencies minimal — no unused or overly broad packages?

**What to check:** Read `package.json`, `pubspec.yaml`, or Nix flake inputs. Run audit commands.

### 2. Secrets & Sensitive Data

- [ ] Are there hardcoded secrets, API keys, tokens, or passwords in source files?
- [ ] Are secrets loaded from environment variables or a secrets manager (not from code)?
- [ ] Is `.env` or secrets file excluded from version control (`.gitignore`)?
- [ ] Are credentials ever logged (in console.log, logger, or print statements)?
- [ ] Are example/template files (`.env.example`) free of real credentials?

**What to check:** `grep` for `secret`, `password`, `token`, `api_key`, `AUTH`, `Bearer` in source files. Check `.gitignore`.

### 3. Input Validation

- [ ] Is user input (CLI args, file paths, environment variables) validated before use?
- [ ] Are file paths sanitized to prevent path traversal (e.g., `../../etc/passwd`)?
- [ ] Are shell commands constructed safely (no string interpolation from user input that could cause injection)?
- [ ] Are JSON/YAML payloads validated against a schema before processing?
- [ ] Are there limits on input size or resource consumption?

**What to check:** Read command handlers, CLI argument parsing, file read/write operations.

### 4. Access Control

- [ ] Does the system write to, or read from, paths outside its expected scope?
- [ ] Do agents or processes have more permissions than needed (principle of least privilege)?
- [ ] Are file permissions set correctly on sensitive config files?
- [ ] Is there any path where user-supplied data controls which file gets written?
- [ ] Are external API calls authenticated? Are tokens scoped appropriately?

**What to check:** Review file I/O operations. Review agent workspace conventions.

### 5. OWASP Top 10 (applicable items)

Focus on what applies to this type of system (CLI tool, API, web app):

- [ ] **A01 Broken Access Control** — see §4 above
- [ ] **A02 Cryptographic Failures** — if data is stored/transmitted, is it encrypted? Are hashes used for passwords (not encryption)?
- [ ] **A03 Injection** — command injection via shell execution? Template injection in generated files?
- [ ] **A05 Security Misconfiguration** — default credentials? Debug modes enabled? Verbose error output in production?
- [ ] **A06 Vulnerable Components** — see §1 above
- [ ] **A09 Logging & Monitoring** — are security events (auth failures, permission errors) logged?

**What to check:** Read shell command execution patterns (`exec`, `spawn`, `Bash tool`). Check for `debug` flags or verbose modes.

---

## Finding Guidance

| What you find | Severity |
|---------------|----------|
| Hardcoded secret, credential, or token in source | Critical |
| Known-vulnerable dependency with high/critical CVE | Critical |
| Command injection or path traversal risk | Critical |
| Missing input validation on external-facing input | Major |
| Secrets logged or exposed in error messages | Major |
| Overly broad permissions or excessive scope | Major |
| Unpinned dependency, minor CVE | Minor |
| Missing `.gitignore` for `.env` files | Minor |
| Missing audit tooling, best-practice suggestion | Info |

---

## Output

For each finding, write:

```markdown
### [SEVERITY] Finding title

- **Area:** Security
- **Severity:** Critical / Major / Minor / Info
- **Location:** file_path:line_number (or component/system)
- **Description:** What was found
- **Evidence:** Code snippet or audit output
- **Recommendation:** What to do about it
- **Effort:** S / M / L
```

After completing the checklist, summarize: "Security: N findings (X critical, Y major, Z minor, W info)"
