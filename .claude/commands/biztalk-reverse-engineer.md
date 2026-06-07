---
description: [Guided] Full BizTalk reverse-engineering pipeline — inventory, spec author, contract extractor, and IR compiler in sequence. Produces spec.md, contracts/, and integration-ir.yaml ready for /model, /plan, and /implement-azure.
argument-hint: [path-to-biztalk-solution-folder] [--group INT-NNN]
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, Agent
---

Orchestrate the full BizTalk reverse-engineering pipeline: msi-crack → inventory → spec → contracts → IR.

Steps:

0. **Parse a `--group INT-NNN` flag** from `$ARGUMENTS` (case-insensitive; accept `--group INT-002`, `--group int-002`, or `--group 002` → normalise to `INT-002`). Strip it before resolving the solution folder. When present, this run is **group-scoped**: spec, contracts, and IR cover only that one catalogue group and land in a group-named folder. When absent, the run is whole-solution (every group becomes flows in one combined integration) — unchanged behaviour.

1. Resolve the BizTalk solution folder:
   - If the remaining `$ARGUMENTS` (after stripping `--group`) is provided and resolves to a directory, use it.
   - Otherwise check for `specs/biztalk/biztalk-inventory.md`. If found, read the `Solution path:` from its header and use that.
   - If neither is available, stop and ask the user to supply the BizTalk solution folder path.

2. **MSI crack phase** (conditional): Check whether `specs/biztalk/_extracted/_manifest.json` already exists.
   - If it exists, print: "Using existing MSI manifest at `specs/biztalk/_extracted/_manifest.json`. Delete it and re-run to re-extract." Skip to step 3.
   - If it does not exist, scan for MSIs using a Bash/PowerShell command (NOT a workspace file-search tool, which won't reach outside the repo root):
     ```bash
     find "<solution-folder>" -name '*.msi' -not -path '*/.msi-extract/*' -not -path '*/_extracted/*'
     ```
   - If no MSIs are found, print: "No MSIs in solution — skipping crack phase. Inventory will work from source artifacts only." Skip to step 3.
   - If at least one MSI is found, run `scripts/crack-msi.ps1` directly via PowerShell — do NOT call the `biztalk-msi-cracker` agent:
     ```powershell
     powershell -NoProfile -ExecutionPolicy Bypass -File scripts/crack-msi.ps1 `
       -SolutionRoot "<absolute-solution-folder>" `
       -OutRoot "<repo-root>/specs/biztalk/_extracted"
     ```
     The script writes `specs/biztalk/_extracted/_manifest.json` and per-MSI artifact folders under `specs/biztalk/_extracted/<AppName>/` (extracted XSLT from map DLLs, XSDs from schema DLLs, ODX from orchestration DLLs, plus pipelines, custom components, and helpers).
   - **Manifest gate**: after the script exits, verify `specs/biztalk/_extracted/_manifest.json` exists and is valid JSON. If not, surface the script's stdout/stderr verbatim and stop — do not proceed to inventory without a manifest when MSIs are present.

3. **Inventory phase**: Check if `specs/biztalk/biztalk-inventory.md` already exists.
   - If not, call the `biztalk-inventory` agent with the folder path. Print: "Inventory complete. Continuing with reverse engineering."
   - If it exists, print: "Using existing `specs/biztalk/biztalk-inventory.md`. Delete it and re-run `/biztalk-inventory` if the BizTalk solution has changed."

3a. **Inventory output gate** — verify both required files exist:
   - `specs/biztalk/biztalk-inventory.md`
   - `specs/biztalk/integration-catalogue.md`
   If `integration-catalogue.md` is missing (Step 9 of the inventory agent was skipped), re-call `biztalk-inventory` with: "Your previous run did not produce `specs/biztalk/integration-catalogue.md`. Re-read Step 9 and the Diagram Rules in `.claude/agents/biztalk-inventory.md`, then produce the catalogue from the existing inventory using `templates/biztalk/integration-catalogue.md` as the skeleton. Do NOT regenerate the inventory itself."
   If still missing after that, stop with: "biztalk-inventory failed to produce `integration-catalogue.md`. This file is required — every IR artifact tags itself with the catalogue's INT-NNN identifiers. Cannot proceed."

4. Read `specs/biztalk/biztalk-inventory.md`. Count artifacts with `migrationHint: manual`. If any exist, print a warning listing their names and paths. Do not stop — manual artifacts will become `# BLOCKED:` flows in the IR and can be implemented separately.

4b. **Group validation (group-scoped runs only).** If `--group INT-NNN` was supplied, confirm `INT-NNN` appears in the `## Catalogue` table of `specs/biztalk/integration-catalogue.md`. If not, stop with: "Group INT-NNN not found in integration-catalogue.md. Available groups: <list each INT-NNN and its Integration Name>." If a `specs/biztalk/NNN-<slug>/integration-ir.yaml` already exists whose `source.group` equals `INT-NNN`, print: "Group INT-NNN already migrated at <folder>. Delete it and re-run to regenerate." and skip to the summary.

5. **Spec phase**: Call the `biztalk-spec-author` agent with the inventory path. **If this run is group-scoped, include in the agent prompt: "Scope this run to group INT-NNN (<Name>) per specs/biztalk/integration-catalogue.md — produce a spec for only that group and name the folder from the group name."**
   - After it finishes, verify that the expected `specs/biztalk/NNN-<slug>/spec.md` now exists (for a group-scoped run the slug derives from the group name; for a whole-solution run, from the application name).
   - If not, stop and report: "biztalk-spec-author failed to produce spec.md. Check agent output for errors."
   - Record the integration folder path (`specs/biztalk/NNN-<slug>/`). The group (if any) is also recorded in the spec's `Source group` front-matter line, so the next agents stay scoped automatically.

6. **Contracts phase**: Call the `biztalk-contract-extractor` agent with the integration folder path. If group-scoped, add to the prompt: "This folder is scoped to group INT-NNN — emit contracts for only that group's schemas and ports (see the spec's Source group line and the catalogue detail section)."
   - After it finishes, verify that ALL of the following exist:
     - `contracts/openapi.yaml`
     - `contracts/asyncapi.yaml`
     - At least one file under `contracts/schemas/`
     - At least one file under `contracts/xsd/` (native XSD schemas preserved from BizTalk — required for runtime XML validation and to avoid breaking external systems that depend on the original wire format)
   - If any are missing, stop and report which file is absent. This is an Article I gate — the IR cannot proceed without contracts.

7. **IR phase**: Call the `biztalk-ir-compiler` agent with the integration folder path. If group-scoped, add to the prompt: "This folder is scoped to group INT-NNN — emit channels/messages/flows/mappings for only that group, and record `group: INT-NNN` + `groupName` in the IR `source:` block (see the spec's Source group line and the catalogue detail section)."
   - After it finishes, verify that `integration-ir.yaml` exists.
   - If not, stop and report: "biztalk-ir-compiler failed to produce integration-ir.yaml. Check agent output for errors."
   - **STM gate.** Verify that one `mappings/<MappingName>.md` exists for every `mappings[].name` in `integration-ir.yaml` (the compiler emits these in its step 12). If any are missing, re-call `biztalk-ir-compiler` with: "Your previous run did not emit an STM document for every mapping. Re-read step 12 and the canonical template in `.claude/agents/stm-drift-checker.md` (Regeneration rules), then write `mappings/<MappingName>.md` for each entry in `mappings[]` using the preserved-transform form. Do NOT change `integration-ir.yaml`." This satisfies phase-gate #5 and avoids the `STM_MISSING` findings `/review` would otherwise raise.

8. Print the Migration Readiness Summary. Read `specs/biztalk/biztalk-inventory.md` and `integration-ir.yaml` to populate the counts:

```
=== Migration Readiness Summary ===
Integration folder: specs/biztalk/NNN-<slug>/

Artifacts processed:
  Orchestrations : N  (auto: N  local-function: N  azure-function: N  manual: N)
  Maps           : N  (auto: N  local-function: N  azure-function: N  manual: N)
  Schemas        : N  (pure: N  flat-file stubs: N  EDI stubs: N)
  Native schemas : N  (xsd: N  flatfile: N  edi: N) — preserved for runtime validation
  Pipelines      : N  (auto: N  custom: N)
  BRE policies   : N  (auto: N  local-function: N  azure-function: N  manual: N)
  Binary DLLs    : N  (all manual)

IR produced:
  Channels: N  |  Messages: N  |  Mappings: N  |  Flows: N
  BLOCKED flows (manual dependencies): N

Next steps:
  1. Review open questions in spec.md (especially manual migration items)
  2. Run /review to audit the IR against the constitution
  3. Run /model to produce data-model.md
  4. Run /platform azure then /plan
  5. For migrationHint=azure-function artifacts: implement Azure Function sidecars before /implement-azure
  6. For migrationHint=manual artifacts: implement these flows manually (see # BLOCKED comments in IR)
```

9. If any BLOCKED flows exist, also print:
   "WARNING: N flow(s) are BLOCKED due to manual migration items. The platform pack will not generate output for these flows. A human must implement them separately."

10. Refresh `<integration-folder>/status.json` per `.claude/skills/pipeline-status/SKILL.md`. After a successful end-to-end reverse engineer run, stages 0a (Inventory), 0b (Catalogue), 1 (Spec), 3 (Contracts), 4 (Mappings (STM) — the IR compiler now emits `mappings/<Name>.md` for every mapping), and 5 (IR) should all be `done`. Recompute `next` (usually `/clarify` if OQs > 0, else `/review`).
