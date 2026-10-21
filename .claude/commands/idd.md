---
description: [Reporting] Generate or refresh the Integration Design Document (IDD / Solution Design Doc) from the IR, contracts, mappings, and decisions.md via the solution-design-author agent.
argument-hint: [spec-folder]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Render the integration's machine artifacts into one **client-facing Solution Design Document** at `<folder>/docs/solution-design.md`. The pipeline produces the spec, IR, contracts, and mappings, but never assembles them into the single design narrative a client signs off on — `/idd` does, and because it regenerates from the IR, the document never drifts from the current design.

This command reads pipeline artifacts and writes **only** `<folder>/docs/solution-design.md` — it does not mutate `integration-ir.yaml`, `status.json`, or any other pipeline artifact. It is **not** guarded by the lifecycle-guard (it never regenerates pipeline artifacts), so it is safe — and useful — to run on a frozen, deployed integration to produce up-to-date design documentation.

## Steps

1. Resolve the integration folder per the **Resolving the integration folder** rules in `.claude/skills/pipeline-status/SKILL.md`. Consult `activeIntegration` as a default; this command may pin it (it is a writing command, but writes only documentation).

2. Require `integration-ir.yaml` to exist. If it does not, stop with: `No integration-ir.yaml in <folder>. The IDD renders from the IR — run /architect (or /biztalk-reverse-engineer) first.`

3. If `<folder>/decisions.md` does not exist, note that the Decision Log section will be empty and seed it from `templates/core/decisions.md` so future `/change` runs have a registry to append to (optional — the agent can also run without it and flag "no decision log recorded").

4. Call the `solution-design-author` agent with the folder path. It renders `docs/solution-design.md` from the IR, spec, data-model, contracts, mappings, and decisions.md.

5. Print the output path and a short summary (sections rendered, number of flows/mappings documented, count of `DD-NN` decisions, count of open items / undocumented decisions). If the agent reported undocumented decisions, list them and suggest recording each with a `DD-NN` entry (via `/change` or a hand edit to `decisions.md`).

6. Ask one short follow-up: `What do you want to do next?` with choices:
   - `Refresh the flow diagram: /visualize <folder>` (the IDD links to it)
   - `Record a missing decision: edit <folder>/decisions.md`
   - `Stop here`

## Notes

- `/idd` is read-only with respect to the pipeline — the only file it writes is the design document (and, optionally, a seeded `decisions.md`).
- Run it after `/architect`, after any `/change`, or any time you need current design documentation for a review or client sign-off.
