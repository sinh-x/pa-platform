# Area Skill: Code Quality Review

You are reviewing the **code quality** of a system. Follow this checklist to explore the codebase and produce severity-rated findings. All findings use the severity rubric from `review.md`.

---

## Checklist

### 1. Architecture & Structure

- [ ] Is the project structure logical and consistent? (e.g., `src/`, `lib/`, `commands/`, `utils/`)
- [ ] Are responsibilities clearly separated (single-responsibility)? No module doing too many things.
- [ ] Is there circular dependency or tight coupling between modules?
- [ ] Are abstractions at the right level — not too abstract, not too concrete?
- [ ] Is there significant duplication (DRY violations) that warrants consolidation?

**What to check:** Read `package.json` / `pubspec.yaml` / project manifest. Read the main entry points and top-level module structure. Check import graphs.

### 2. Code Smells

- [ ] Are there functions/methods longer than ~60 lines?
- [ ] Are there files longer than ~400 lines?
- [ ] Is there commented-out code or `TODO`/`FIXME` accumulation?
- [ ] Are there magic numbers or hardcoded strings that should be constants?
- [ ] Is error handling consistent, or are errors silently swallowed?
- [ ] Are there any `any` types (TypeScript), unchecked dynamic casts, or `dynamic` usage (Dart) that weaken type safety?

**What to check:** Read source files in `src/` or `lib/`. Use `grep` for `TODO`, `FIXME`, `any`, `// TODO`, commented blocks, magic values.

### 3. Test Coverage

- [ ] Are tests present? Check for `test/`, `__tests__/`, `spec/` directories.
- [ ] Do tests cover the critical paths (core commands, main business logic)?
- [ ] Are there edge case tests, or only happy-path tests?
- [ ] Can the test suite be run? (`pnpm test`, `dart test`, etc.) Does it pass?
- [ ] Is there a significant gap between what's tested and what's in production use?

**What to check:** List test files. Read a sample of tests to gauge coverage quality, not just count. Run the test suite if possible.

### 4. Documentation

- [ ] Does the project have a README covering: what it does, how to install, how to use it?
- [ ] Are non-obvious functions/modules documented (comments or docstrings)?
- [ ] Is the CHANGELOG up to date?
- [ ] Are architectural decisions recorded anywhere (ADRs, CLAUDE.md, notes)?
- [ ] Is there a gap between what's documented and what actually exists (stale docs)?

**What to check:** Read `README.md`, `CLAUDE.md`, `CHANGELOG.md`. Check for missing or outdated sections.

### 5. Naming & Conventions

- [ ] Are names (variables, functions, files, types) descriptive and consistent with project conventions?
- [ ] Does the project follow a consistent style (camelCase, kebab-case, snake_case) appropriate for the language?
- [ ] Are exported vs. internal symbols clearly distinguished?
- [ ] Are configuration/constant files named consistently with the rest of the codebase?

**What to check:** Scan a selection of source files. Compare file naming in `src/` or `lib/`.

---

## Finding Guidance

| What you find | Severity |
|---------------|----------|
| Incorrect logic that produces wrong results | Critical |
| Unhandled error paths in critical flows | Major |
| Large functions, significant duplication, unclear architecture | Major |
| Missing test coverage for core features | Major |
| Minor style inconsistency, small TODOs | Minor |
| Docs gap, naming suggestion | Minor/Info |
| Best-practice suggestion with no functional impact | Info |

---

## Output

For each finding, write:

```markdown
### [SEVERITY] Finding title

- **Area:** Code Quality
- **Severity:** Critical / Major / Minor / Info
- **Location:** file_path:line_number (or module/component)
- **Description:** What was found
- **Evidence:** Code snippet or observation
- **Recommendation:** What to do about it
- **Effort:** S / M / L
```

After completing the checklist, summarize: "Code Quality: N findings (X critical, Y major, Z minor, W info)"
