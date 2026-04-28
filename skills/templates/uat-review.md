# Template: UAT Review

> **Template:** uat-review
> **Version:** 1.0
> **Last Updated:** 2026-04-28
> **Used by:** Builder team at review-uat handoff
> **Produces:** UAT review checklist for a ticket in review-uat status
> **Consumed by:** Sinh or assigned UAT reviewer

## Purpose

Checklist for preparing a ticket for UAT review. It records what was built, how to verify it, and known caveats.

## When to Use

- When builder advances a ticket to `review-uat`.
- When preparing final review before a ticket moves to `done`.

## Template

```markdown
# UAT Review: <ticket-id> - <short topic>

> Ticket: <ticket-id>
> Requirements: <requirements doc_ref>
> Implementation: <implementation doc_ref>
> Reviewer: Sinh
> Status: Ready for Review

## What Was Built
<Brief summary of the implementation.>

## Test Scenarios

### TS-1: <AC description>
- **Given:** <precondition>
- **When:** <action>
- **Then:** <expected result>
- **Test Command:** <command to run or steps to follow>
- **Actual Result:** _<to be filled during UAT>_
- **Status:** _<pass / fail / blocked - to be filled during UAT>_

### TS-N: <AC description>
...

## Regression Checks
- [ ] Existing functionality not broken; list key workflows to re-verify.
- [ ] Build passes where relevant.
- [ ] Typecheck or analyzer passes where relevant.
- [ ] Tests pass where relevant.

## Edge Cases
- <edge case>: <how to test or verify>

## Known Caveats
- <caveat or None>

## UAT Sign-Off
- [ ] All test scenarios passed or accepted as known limitations
- [ ] Regression checks passed
- [ ] Edge cases verified or accepted as known limitations
- **Reviewer:** _<name>_
- **Date:** _<date>_
```

## Guidance Notes

- Map one test scenario to each relevant section 10 acceptance criteria item.
- Include regression checks for the affected area.
- Include edge cases from section 9 Risks in the requirements document.
- Keep steps concrete so the reviewer can run them without reading implementation details.
- Known caveats should be visible before test execution begins.

## What the Next Stage Needs

- **Sinh / UAT reviewer** needs clear test scenarios, commands or steps, caveats, and sign-off checkboxes.
- **Builder** needs failures reported on the same ticket with enough detail to reproduce.
