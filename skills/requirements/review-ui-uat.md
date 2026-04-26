# Area Skill: UI/UAT Review

You are reviewing the **user interface and user acceptance** quality of a system — CLI UX, component structure, user workflows, and accessibility. Follow this checklist and produce severity-rated findings. All findings use the severity rubric from `review.md`.

> **Note:** v1 is code/component analysis only. No browser automation or Playwright testing. UI/UAT for CLI tools focuses on CLI UX; for web apps, focus on component structure, workflow coverage, and code-level accessibility analysis.

---

## Checklist

### 1. User Workflows

- [ ] Are the primary user workflows clearly defined and supported by the code?
- [ ] Can a new user get started without reading the source code? (Is there a help command, usage guide, or onboarding flow?)
- [ ] Are the most common workflows achievable in ≤3 steps?
- [ ] Are there dead ends — flows that start but have no clear completion or error recovery?
- [ ] Is there feedback for long-running operations? (Progress indicators, status messages)

**What to check:** Read `README.md` usage section. Trace the main command paths in source. Try `--help` flags.

### 2. CLI UX (for CLI tools)

- [ ] Is the CLI command structure consistent and predictable? (`pa <command> [options]`)
- [ ] Are error messages actionable — do they tell the user what went wrong and what to do?
- [ ] Are `--help` / `-h` flags available and up to date?
- [ ] Is output human-readable by default? Is machine-readable output available (--json, --quiet)?
- [ ] Are destructive actions confirmed before executing? (e.g., "Are you sure?")
- [ ] Are exit codes used correctly? (0 = success, non-zero = error)

**What to check:** Read CLI command definitions. Read error message strings. Check exit code patterns.

### 3. Component & Interface Structure (for web/mobile apps)

- [ ] Are UI components well-structured and reusable?
- [ ] Is there separation between data fetching, business logic, and rendering?
- [ ] Are loading and error states handled in the UI?
- [ ] Is state management consistent and predictable?
- [ ] Are there tests for components (unit or integration)?

**What to check:** Read component files in `src/components/`, `lib/widgets/`. Check for loading/error state handling.

### 4. Accessibility (code-level analysis)

- [ ] For web: Are semantic HTML elements used (headings, buttons, labels, lists) rather than generic divs?
- [ ] For web: Are images, icons, and interactive elements labeled (alt text, aria-label)?
- [ ] For CLI: Does the tool work without color for colorblind or monochrome terminal users?
- [ ] Are keyboard shortcuts and navigation patterns documented?
- [ ] Are error messages descriptive enough for screen reader users?

**What to check:** Read component markup. Check for `aria-*` attributes, semantic HTML, color-only information encoding in CLI output.

### 5. User Acceptance Criteria Coverage

- [ ] Do acceptance criteria exist for this system? (In `CLAUDE.md`, README, or issues)
- [ ] Are all documented acceptance criteria actually met by the current implementation?
- [ ] Are there user-facing features that have no corresponding tests or acceptance check?
- [ ] Are there known UX complaints or issues logged (GitHub issues, TODOs mentioning UX)?

**What to check:** Read `CLAUDE.md`, `README.md`. Search GitHub issues if accessible. Check for `TODO` or `FIXME` comments referencing UX.

---

## Finding Guidance

| What you find | Severity |
|---------------|----------|
| Core workflow broken or unreachable | Critical |
| No error messages — user cannot understand failures | Major |
| Missing `--help` or seriously outdated help text | Major |
| Dead-end workflow with no recovery path | Major |
| Accessibility barrier (color-only info, unlabeled button) | Major |
| Inconsistent CLI command structure | Minor |
| Missing progress indicator for operations >3s | Minor |
| Minor wording improvement, style suggestion | Info |
| Best-practice suggestion with no functional impact | Info |

---

## Output

For each finding, write:

```markdown
### [SEVERITY] Finding title

- **Area:** UI-UAT
- **Severity:** Critical / Major / Minor / Info
- **Location:** file_path:line_number (or command/component/workflow)
- **Description:** What was found
- **Evidence:** Code snippet, help output, or observed behavior
- **Recommendation:** What to do about it
- **Effort:** S / M / L
```

After completing the checklist, summarize: "UI/UAT: N findings (X critical, Y major, Z minor, W info)"
