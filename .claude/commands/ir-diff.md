---
description: [Reporting] Compare two integration-ir.yaml files and classify each change as breaking, additive, or cosmetic.
argument-hint: <baseline-ir-path> <changed-ir-path>
allowed-tools: Read, Edit, Write, Grep, Glob
---

Compare two IR files and classify their differences.

## Steps

1. Require exactly two arguments: `<baseline>` and `<changed>` — absolute or repo-relative paths to `integration-ir.yaml` files. If either argument is missing or the file does not exist, stop and tell the user.
2. Read both files.
3. Run the diff classification rules below across all top-level IR sections.
4. Write `ir-diff-report.md` to the same directory as `<changed>`.
5. Print a one-line summary: `N breaking, N additive, N cosmetic changes`.

## Classification rules

### Breaking changes (must bump a major version or coordinate consumers)

| Condition | Example |
|---|---|
| A `channels[]` entry is removed or its `name` is renamed | `orders-http` removed |
| A `channels[]` entry `auth` is narrowed (e.g. `oauth2` → `none`, scopes reduced) | `scopes` list shortened |
| A `messages[]` entry is removed or its `name` is renamed | `Order` removed |
| A `mappings[]` entry is removed or its `name` is renamed | `RawOrderToCanonical` removed |
| A `mappings[]` `source.messageRef` or `target.messageRef` changes | Different source shape |
| A `flows[]` entry is removed or its `name` is renamed | `OrderIntakeFlow` removed |
| A `flows[]` `trigger` changes to a different channel | Trigger channel swapped |
| An `errorHandling` `retry.count` decreases or `dlq.channel` changes | Fewer retries |
| A `dependencies[]` entry is removed or its `timeout` decreases | Downstream timeout tightened |

### Additive changes (backward-compatible; consumers may opt in)

| Condition | Example |
|---|---|
| A new entry is added to `channels[]`, `messages[]`, `mappings[]`, `flows[]`, or `dependencies[]` | New channel added |
| A `channels[]` `auth` is widened (more scopes added) | Extra scope granted |
| A new `flows[]` step is appended at the end of a flow (does not reorder existing steps) | New terminal step |
| `nonFunctionals` values increase (higher SLO, higher RPS limit) | `rps` raised |

### Cosmetic changes (no consumer impact)

| Condition | Example |
|---|---|
| `metadata.description`, `messages[].description`, `mappings[].description` changed | Wording updated |
| Array element order changed without adding/removing entries | Flows reordered |
| `mappings[].rules[]` notes or comments changed | Note clarified |
| `nonFunctionals` values decrease in a way that only widens tolerance | Lower `p95LatencyMs` target |

### Unclassified

Any change that does not match a rule above is reported as `unclassified` (treat as breaking until manually reviewed).

## Report format (`ir-diff-report.md`)

```markdown
# IR Diff Report

Baseline: <baseline-path>
Changed:  <changed-path>
Generated: <ISO-8601>

## Summary
- Breaking: N
- Additive: N
- Cosmetic: N
- Unclassified: N

## Changes

| # | Class | Section | Item | Change |
|---|-------|---------|------|--------|
| 1 | BREAKING | channels | orders-http | removed |
| 2 | ADDITIVE | channels | payments-http | added |
| 3 | COSMETIC | mappings[RawOrderToCanonical] | description | text changed |
```

## Rules

- Do not write any file other than `ir-diff-report.md`.
- Do not suggest fixes; only classify and report.
- If both files are identical, report zero changes and `Verdict: NO DIFF`.
