---
description: [Reporting] Verify that generated platform artifacts have not drifted from their recorded SHA-256 hashes in <folder>/status.json.
argument-hint: [integration-folder]
allowed-tools: Read, Edit, Write, Grep, Glob, Bash
---

Check generated artifact hashes against the baseline recorded in `<integration-folder>/status.json`.

## Steps

1. Resolve the integration folder:
   - If an argument is supplied and resolves to a directory, use it.
   - Else if `.spec2integration/state.json` has `activeIntegration` set and that folder exists, use it.
   - Else look for a single subfolder under `specs/` containing `status.json`. If multiple, list them and ask the user to pick one.
   - Else stop with: "No integration folder found. Run `/implement-<platform>` first, or supply the folder path."
2. Read `<integration-folder>/status.json`. If `artifactHashes` is absent or empty, stop and tell the user:
   > "No artifact hashes recorded in `<integration-folder>/status.json`. Run `/implement-<platform> <integration-folder>` first to establish the baseline."
3. For each entry in `artifactHashes`:
   a. Resolve the file path relative to the project directory.
   b. If the file does not exist, record `FILE_MISSING` (Sev-2).
   c. Compute `SHA-256` of the file contents:
      ```bash
      sha256sum "<file-path>"
      ```
      (On macOS: `shasum -a 256 "<file-path>"`)
   d. Compare to the recorded hash. If different, record `ARTIFACT_DRIFTED` (Sev-2) with the file path.
4. Print summary: `Drift check: N files clean, N drifted, N missing — PASS | BLOCKED`.

## status.json contract

Platform packs record hashes after each `/implement-*` run by merging into `<integration-folder>/status.json`:

```json
{
  "folder": "specs/biztalk/001-biztalk-combined",
  "generatedAt": "...",
  "artifactHashes": {
    "specs/biztalk/001-biztalk-combined/app/OrderIntakeFlow/workflow.json": "e3b0c44298fc1c149afb...",
    "specs/biztalk/001-biztalk-combined/app/OrderRouterFlow/workflow.json": "9f86d081884c7d659a2f...",
    "specs/biztalk/001-biztalk-combined/app/connections.json": "a87ff679a2f3e71d9181...",
    "specs/biztalk/001-biztalk-combined/infra/main.bicep": "c4ca4238a0b923820dcc..."
  },
  "lastImplement": {
    "completedAt": "2026-06-02T12:00:00Z",
    "flowCount": 7,
    "host": "logic-app-standard",
    "verdict": "PASS",
    "artifactCount": 126
  }
}
```

`/implement-*` merges `artifactHashes` and `lastImplement` into the per-integration `status.json`, preserving all other keys. `/drift-check` reads them and never writes to `status.json`.

The global `.spec2integration/state.json` no longer holds `artifactHashes` or `lastImplement` — only `activePlatform` and `activeIntegration`.

## Findings

| Rule ID | Severity | Meaning |
|---|---|---|
| `ARTIFACT_DRIFTED` | Sev-2 | File content changed since last `/implement-*`. Re-run `/implement-*` or revert the file. |
| `FILE_MISSING` | Sev-2 | A previously generated file has been deleted. Re-run `/implement-*`. |

## Output

Printed to stdout only — no file written. If any finding exists, list each drifted/missing file on its own line:

```
DRIFTED  app/OrderIntakeFlow/workflow.json
MISSING  infra/main.bicep
Drift check: 2 files clean, 1 drifted, 1 missing — BLOCKED
```

## Rules

- Do not modify any artifact or `status.json`.
- If `sha256sum` / `shasum` are not available, stop and report `HASHER_MISSING` (Sev-1).
- If the project directory does not exist, stop and ask the user.
