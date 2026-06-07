---
description: [Advanced] Produce domain.yaml for each business domain found in the workspace, grouping integrations, declaring canonical domain events, and setting domain-wide policy.
argument-hint: [domain-name]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Run the domain-architect agent to produce `domain.yaml` artifacts.

Steps:
1. If a `domain-name` argument is provided, filter to integrations whose `metadata.domain` matches. Otherwise process all domains found in the workspace.
2. Verify at least one `specs/*/*/integration-ir.yaml` exists. If none are found, stop and instruct the user to run `/architect` first to produce integration IRs.
3. Invoke `domain-architect`.
4. For each produced `specs/<domain-name>/domain.yaml`, validate it against `schemas/domain-ir.schema.json`. If validation fails, report schema errors and stop.
5. Check that every Integration referenced in `integrations[].path` has `metadata.domain` matching the domain `metadata.name`. Report any mismatches as `DOMAIN_REF_MISMATCH`.
6. Print the summary from the domain-architect: domains produced, integrations registered, canonical events declared, gaps found.
