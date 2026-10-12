# Isolated v1 producer fixture

> Ticket: FIX-237
> Repository Key: fixture-repo
> Repository Root: /fixture/canonical
> Approved Base SHA: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> Feature Branch: feature/FIX-237-isolated-review
> Matrix Authority SHA-256: 0e463e4251f0c51c982dc9b6f05b2c7718f8418ce8c4a802ad7b1a122e5a940d
> Matrix Approval Evidence: FIX-237 comment c-20000101000000000 by sinh names the exact Matrix Source and digest

### Full Validation Matrix

Matrix Source: requirements:agent-teams/requirements/artifacts/fixture-mvm-179-migrated.md

Non-ASCII boundary fixture: café — unchanged bytes.

```json
{
  "schemaVersion": "pa-review-matrix/v1",
  "source": "requirements:agent-teams/requirements/artifacts/fixture-mvm-179-migrated.md",
  "repository": {
    "key": "fixture-repo",
    "root": "/fixture/canonical",
    "baseSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "branch": "feature/FIX-237-isolated-review"
  },
  "profile": "npm-subprojects/v1",
  "prerequisites": [
    {
      "kind": "platform",
      "os": "linux",
      "arch": "x64"
    },
    {
      "kind": "tool",
      "name": "node",
      "version": "v22.23.2"
    },
    {
      "kind": "tool",
      "name": "npm",
      "version": "10.9.4"
    },
    {
      "kind": "dependency",
      "root": "frontend",
      "name": "typescript",
      "version": "5.9.3"
    },
    {
      "kind": "operatorGate",
      "id": "paired-runtime-ready",
      "ticket": "FIX-237"
    }
  ],
  "environment": {
    "PA_REPO": {
      "binding": "worktreeRoot"
    },
    "PA_TICKET_ID": {
      "literal": "FIX-237"
    },
    "PA_FEATURE_SHA": {
      "binding": "featureSha"
    },
    "PA_MATRIX_SOURCE": {
      "binding": "matrixSource"
    },
    "PA_MATRIX_AUTHORITY_SHA256": {
      "binding": "matrixAuthoritySha256"
    },
    "PA_MATRIX_APPROVAL_EVIDENCE": {
      "binding": "matrixApprovalEvidence"
    },
    "CI": {
      "literal": "1"
    },
    "HOME": {
      "literal": "/fixture/home"
    },
    "LANG": {
      "literal": "C.UTF-8"
    },
    "TZ": {
      "literal": "UTC"
    },
    "PATH": {
      "binding": "trustedPath"
    }
  },
  "commands": [
    {
      "id": "command-01",
      "command": "PA_PHASE5_CONFIG_ROOT=/fixture/config printf \"fixture only\\n\"",
      "cwd": ".",
      "timeoutSeconds": 1800,
      "maxOutputBytes": 1073741824
    }
  ],
  "commandCount": 1,
  "outputs": [
    "command-01: fixture marker only; never execute during parsing"
  ],
  "passCriteria": {
    "completionPercent": 100,
    "exitCode": 0,
    "critical": 0,
    "major": 0,
    "minorRationaleRequired": true
  }
}
```

Policy: parser success is not authorization.

## After Matrix

Not hashed.
