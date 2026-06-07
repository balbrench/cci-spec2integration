---
description: [Guided] End-to-end pipeline orchestrator from intake through /test-<platform>, stopping before /deploy-<platform>. Resumable from status.json.
argument-hint: --mode <greenfield|biztalk> [--input <path-or-brief>] [--group INT-NNN] [--folder <specs-folder>] [--platform <pack>] [--allow-sev2] [--auto-accept-clarifications] [--auto-fix [N]] [--unattended] [--dry-run]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Orchestrate the full Spec2Integration pipeline end-to-end, stopping before deployment.

This prompt is a **meta-runner**. It invokes the existing slash-commands in sequence and gates on `status.json` between stages. It does NOT itself produce or modify any pipeline artifact, and per the `pipeline-status` skill it MUST NOT write `<folder>/status.json` — only the invoked sub-prompts do.

## Arguments

Parse `$ARGUMENTS` as a flag list:

- `--mode <greenfield|biztalk>` — required. Selects the intake branch.
- `--input <path-or-brief>` — required for fresh runs:
  - `greenfield`: a one-line brief (in quotes) OR a path to an existing PRD `.md`.
  - `biztalk`: an absolute path to the BizTalk solution folder.
  - Optional on resume if `--folder` is provided and intake is already done.
- `--group INT-NNN` — optional, `biztalk` mode only. Scopes the migration to a single catalogue group: `/biztalk-reverse-engineer` produces a spec/contracts/IR covering only that group, in a group-named folder. Run once per group to migrate a solution group-by-group (each group becomes its own integration). Omit to migrate the whole solution into one combined integration. Ignored in `greenfield` mode.
- `--folder <specs-folder>` — optional. If supplied and `<folder>/status.json` exists, resume from the first non-`done` stage instead of restarting intake.
- `--platform <pack>` — optional, default `azure`. Used only if `.spec2integration/state.json` is missing.
- `--allow-sev2` — optional. Forwarded to `/review` and `/plan`. Sev-1 still always blocks.
- `--auto-accept-clarifications` — optional. Treats all `clarifier` recommendations as Resolved and skips the human sign-off pause. **Risky** — only use when the team has pre-agreed all defaults are acceptable.
- `--auto-fix [N]` — optional. Enables the self-healing loop (see "Auto-fix loop" below). `N` is the max remediation attempts per stop condition (default `3`). Sev-1 findings, Sev-2 findings, contract lint errors, plan-blocked phase gates, BLOCKED-flow stubs, and `/test-<platform>` failures are all dispatched to the authoring agent that owns the artifact and the stage is re-run. The orchestrator only halts if the loop exhausts `N` without reaching `done`.
- `--unattended` — optional. Shorthand for `--auto-accept-clarifications --allow-sev2 --auto-fix 3`. Designed for CI / overnight runs where no human is at the keyboard. Still stops on (a) missing platform pack, (b) auto-fix budget exhausted, (c) unrecoverable input (e.g. malformed PRD path).
- `--dry-run` — optional. Prints the planned command sequence (with the resolved folder, mode, and resume point) and exits without invoking any sub-prompt.

If `--mode` is missing, stop with: `"--mode <greenfield|biztalk> is required."` and a one-line usage example for each mode.

If `--unattended` is set, expand it before flag-handling into `--auto-accept-clarifications --allow-sev2 --auto-fix 3` (preserving any explicit `--auto-fix N` the user already supplied).

## Pre-flight

1. **Platform pack.** If `.spec2integration/state.json` is missing or its `activePlatform` field is empty, run `/platform <--platform || azure>`. If that prompt fails (pack not installed), stop and surface its error verbatim.
2. **Folder resolution.**
   - If `--folder` was supplied: use it. Read `<folder>/status.json` if present to determine the resume point (see "Resume semantics" below).
   - Else if `--mode greenfield`: the folder will be created by `/specify`; defer resolution.
   - Else if `--mode biztalk`: the folder will be created by `/biztalk-reverse-engineer`; defer resolution.
3. **Dry-run.** If `--dry-run` is set, print the resolved mode, folder (or "to be created"), platform, resume point, and the ordered command list that would be executed. Do not invoke any sub-prompt. Exit.

## Resume semantics

When `<folder>/status.json` exists, treat the first stage whose `status` is not `done` (and is not `covered`, which is rolled into `5e Review`) as the **resume point**. Map stages to commands:

| First non-`done` stage | Resume command |
|---|---|
| `0 Inventory` (biztalk) | `/biztalk-reverse-engineer` |
| `1 Spec` | mode-dependent: `/specify` or `/biztalk-reverse-engineer` |
| `1a Clarifications` | `/clarify` |
| `2 Data model` | `/model` |
| `3 Contracts` | `/contracts` (greenfield) — for biztalk this should already be `done` after RE; if not, re-run `/biztalk-reverse-engineer` |
| `3a Contracts lint` | `/contracts` (re-runs the linter) |
| `4 Mappings (STM)` | `/map` |
| `5 IR` | `/architect` (greenfield) or `/biztalk-reverse-engineer` (biztalk) |
| `5a IR validation` | `/review` (validator runs as part of review) |
| `5e Review` | `/review` |
| `6 Mapping tests` | `/test-mappings` |
| `6a Flow tests` | `/test-flows` |
| `7 Platform pack` | `/platform <--platform || azure>` |
| `8 Plan` | `/plan` |
| `9 Tasks` | `/tasks` |
| `10 Implement` | `/implement-<platform>` |
| `11 Tests` | `/test-<platform>` |
| `12 Deploy` | **STOP** — orchestrator does not deploy (see "Final summary") |

If `status.json` is absent on a folder that already contains `spec.md`, run `/status <folder>` first to regenerate it, then read it.

## Stage gate (between every step)

After each invoked sub-prompt returns:

1. Re-read `<folder>/status.json` (the sub-prompt is required to refresh it as its last step, per the `pipeline-status` skill).
2. Find the row for the stage that just ran. If `status != done`, retry the sub-prompt **once**. If still not `done`, **STOP** with: `"Stage <id> <name> did not reach done after retry. Last refreshedBy=<value>. Recover with: <command>."`
3. Inspect `counts.sev1`, `counts.sev2`, `counts.blockedFlows` per the rules in "Stop conditions" below before proceeding.

For every stop, after printing the primary recovery command, you MAY add one orientation line: `Need a quick reminder after the fix? Run /next <folder>.` This does not replace the primary recovery command.

## Procedure

### Greenfield branch (`--mode greenfield`)

1. **Intake.** If `--input` is a brief (no `.md` extension or doesn't exist as a file): run `/draft-prd "<input>"`. If it's a path to an existing PRD: skip.
2. `/specify --fresh [PRD-path]` — `--fresh` is **mandatory** here so the pipeline always creates a new integration folder rather than silently enriching the currently-active integration. Capture the resolved folder path from the prompt's output and use it for all subsequent steps.
3. `/clarify <folder>` — see "Clarifications gate" below.
4. `/model <folder>`.
5. `/contracts <folder>` — blocks on Sev-1 lint findings; surface and stop if so.
6. `/map <folder>`.
7. `/architect <folder>`.
8. `/test-mappings <folder>` — skip silently if `mapping-test-report.json` shows no fixtures declared.
9. `/test-flows <folder>` — skip silently if no flow tests declared.
10. Continue to **Common tail**.

### BizTalk branch (`--mode biztalk`)

1. **Inventory + reverse engineer.**
   - `/biztalk-inventory <input>` (only if `specs/biztalk/biztalk-inventory.md` is missing).
   - `/biztalk-reverse-engineer <input> [--group INT-NNN]` — produces the spec, contracts, and IR under `specs/biztalk/NNN-<slug>/`. **Forward the BizTalk solution folder (`<input>`) as the positional argument** so the reverse-engineer scans the correct source even when the inventory step was skipped (it otherwise falls back to the `Solution path:` recorded in the inventory header — pass `<input>` to override a stale/empty header). **Also forward `--group INT-NNN` verbatim when supplied** so the run scopes to that one catalogue group (the resolved folder is group-named, e.g. `specs/biztalk/002-xml-mapping-payment-registration/`). Capture the resolved folder path; the remaining stages (`/clarify`, `/model`, common tail) run against **that** folder. To migrate another group, re-run `/run-pipeline --mode biztalk --input <solution> --group INT-MMM` — each group is an independent integration with its own status.json.
2. **BLOCKED-flow gate.** Read `<folder>/status.json`:
  - If `counts.blockedFlows > 0`: **STOP**. Print the BLOCKED list from `integration-ir.yaml` (search for the `# BLOCKED:` comments) and: `"Manual implementation required for the flows above. Treat as Sev-1: hand-author the artifacts under <folder>/artifacts/custom/, clear the BLOCKED comments in integration-ir.yaml, then re-run /run-pipeline --folder <folder> --mode biztalk."` Then add: `Need a quick reminder after the fix? Run /next <folder>.`
3. `/clarify <folder>` — see "Clarifications gate".
4. `/model <folder>`.
5. Continue to **Common tail**.

### Common tail (both modes)

1. `/review <folder> [--allow-sev2]` — see "Sev gate" below.
2. `/plan <folder> [--allow-sev2]`. If `<folder>/plan-blocked.md` is produced (instead of `plan.md`), **STOP** with: `"Phase gate failed — see <folder>/plan-blocked.md. Fix the listed gates and re-run /run-pipeline --folder <folder> --mode <mode>."` Then add: `Need a quick reminder after the fix? Run /next <folder>.`
3. `/tasks <folder>`.
4. `/implement-<platform> <folder>`.
5. `/test-<platform> <folder>`. If tests fail, **STOP** with: `"Tests failed — see <folder>/TEST-REPORT.md. Fix and re-run /test-<platform> <folder> (or /run-pipeline to resume)."` Then add: `Need a quick reminder after the fix? Run /next <folder>.`
6. **Final summary** — see below.

## Clarifications gate

After `/clarify`:

1. Re-read `<folder>/clarifications.md` (or `<folder>/status.json.counts.openClarifications`).
2. If `openClarifications == 0`: continue.
3. Else if `--auto-accept-clarifications` is set: instruct the user (in chat) that all open OQs will be marked Resolved with the `clarifier`'s recommended answer, then re-invoke `/clarify <folder>` with the directive that every OQ should be auto-accepted. Confirm `openClarifications == 0` after the second pass; if not, STOP.
4. Else: **STOP** (pause for human). Print: `"<N> open clarifications require sign-off. Edit <folder>/clarifications.md (set Resolved: true and fill the Resolution log), then re-run /run-pipeline --folder <folder> --mode <mode>."` Then add: `Need a quick reminder after the sign-off? Run /next <folder>.`

## Sev gate

After `/review`:

1. Read `<folder>/review-report.json` (or `status.json.counts`).
2. If `sev1 > 0`: **STOP**. Print the Sev-1 finding IDs and: `"<N> Sev-1 findings block /plan. Fix per <folder>/review-report.md, then re-run /run-pipeline --folder <folder> --mode <mode>."` Then add: `Need a quick reminder after the fix? Run /next <folder>.`
3. If `sev2 > 0` and `--allow-sev2` is NOT set: **STOP**. Print: `"<N> Sev-2 findings. Either fix them or re-run with --allow-sev2 to proceed."` Then add: `Need a quick reminder after the decision? Run /next <folder>.`
4. Else: continue.

## Auto-fix loop

Active only when `--auto-fix` (or `--unattended`) is set. For every stop condition tagged **fixable** in the table below, the orchestrator must:

1. Capture the findings file referenced by the stop (e.g. `<folder>/review-report.json`, `<folder>/contract-lint-report.json`, `<folder>/plan-blocked.md`, `<folder>/TEST-REPORT.md`).
2. Dispatch the **remediation agent** listed for that condition with the findings file path and a directive to fix every listed item in place. Agents must not weaken the constitution to clear a finding — if an Article-I/II/III/V violation cannot be honestly fixed, the agent returns `unfixable` and the loop aborts for that condition.
3. Re-run the stage's command (the same one that produced the failure).
4. Re-evaluate the stop condition. If cleared, continue the pipeline. If still failing, increment the attempt counter and repeat from step 2.
5. After `N` attempts (default 3) without reaching `done`, STOP with the original recovery message **plus** a single line: `"Auto-fix exhausted after <N> attempts. Last unresolved findings: <id-list>."`

### Remediation dispatch table

| Stop condition | Remediation agent(s) | Stage to re-run |
|---|---|---|
| Contract lint Sev-1 (`/contracts`) | `contract-designer` | `/contracts` |
| BLOCKED flows after `/biztalk-reverse-engineer` | `biztalk-ir-compiler` + `azure-local-functions-author` (to hand-author the artifacts under `<folder>/artifacts/custom/` from `_extracted/` source) | `/biztalk-reverse-engineer` (then re-evaluate) |
| `/review` Sev-1 | route by finding `articleId` — Article I→`contract-designer`; Article II/II-a→`mapping-designer` then `integration-architect`; Article III/IV/VI→`integration-architect`; Article V (`pii-flow-checker`)→`mapping-designer` (apply `redact`); secret-scanner→`azure-connections-binder` (managed-identity) | `/review` |
| `/review` Sev-2 (when `--allow-sev2` not set and auto-fix is on) | same routing as Sev-1 | `/review` |
| `/plan` produced `plan-blocked.md` | read `plan-blocked.md` gate IDs and route each to its owning agent (gate 0a→spec-coverage findings→`integration-architect`; gate 0b→`mapping-designer`; gate 5→`stm-drift-checker` regeneration) | `/plan` |
| `/test-mappings` failures | `mapping-designer` (regenerate the failing expression from spec + STM) | `/test-mappings` |
| `/test-flows` failures | `integration-architect` (fix the IR flow) | `/test-flows` |
| `/test-<platform>` failures | platform compiler agent (e.g. `azure-logic-apps-compiler`, `azure-local-functions-author`, `azure-bicep-author` — chosen by which artifact the failing test exercises) | `/test-<platform>` |

Conditions **not** fixable by the loop (always halt immediately even with `--auto-fix`):

- `--mode` missing or malformed `--input`.
- Platform pack not installed (`/platform` failed).
- A sub-prompt did not advance its stage to `done` after one in-stage retry **and** the failure is not in the dispatch table above (indicates an infrastructure / tooling problem, not a content problem).
- Open clarifications without `--auto-accept-clarifications` (the orchestrator never invents business answers).
- Any remediation agent returned `unfixable`.

The auto-fix loop must refresh `<folder>/status.json` indirectly — i.e. by re-invoking the stage command, which itself refreshes status per the `pipeline-status` skill. The orchestrator still never writes `status.json` directly.

## Stop conditions (summary)

The orchestrator halts mid-run for any of:

| Condition | Recovery message |
|---|---|
| `--mode` missing | `"--mode <greenfield|biztalk> is required."` |
| Platform pack not installed | (verbatim from `/platform`) |
| Sub-prompt did not move stage to `done` after one retry | `"Stage <id> ... Recover with: <command>."` |
| `clarifications.md` has open OQs (no `--auto-accept-clarifications`) | sign-off message above |
| `/contracts` linter Sev-1 | `"Contract lint blocked — see <folder>/contract-lint-report.md."` |
| `counts.blockedFlows > 0` (biztalk, after RE) | manual-implementation message above |
| `/review` Sev-1 > 0 | review fix message above |
| `/review` Sev-2 > 0 without `--allow-sev2` | sev-2 override message above |
| `/plan` produced `plan-blocked.md` | phase-gate message above |
| `/test-<platform>` failed | test-fix message above |
| Resumed run finds everything `done` except `12 Deploy` | `"Pipeline complete through /test-<platform>. Nothing to do. Run /deploy-<platform> manually when ready."` |

Every stop must print **exactly one primary** next manual command the user can run to recover or proceed. It may also print `/next <folder>` as an optional orientation shortcut after that primary recovery command.

## Final summary

When the common tail completes successfully:

1. Re-read `<folder>/status.json`.
2. Print the stages table (id, name, status, summary) for stages 0 through 11.
3. Ask one short follow-up question in chat: `What do you want to do next?`
  - If the chat surface supports selectable options, offer them as choices.
  - Otherwise render a numbered list and wait for the user's reply.
  - Print `Why: deployment is the next unmet stage and the orchestrator stops before deploy by design.` before the choices.
  - Offer these choices:
    - `Deploy manually now: /deploy-<platform> <folder>`
    - `Show quick orientation: /next <folder>`
    - `Stop here`
4. Print, verbatim and on its own line:
  ```
  Stopped before /deploy-<platform> as designed. Run `/deploy-<platform> <folder>` manually when ready.
  ```
5. Do not invoke `/deploy-<platform>` under any circumstance — even with extra flags.

## Examples

- Fresh greenfield run:
  `/run-pipeline --mode greenfield --input "Order intake from HTTP, validate, publish to Service Bus"`

- Fresh BizTalk migration:
  `/run-pipeline --mode biztalk --input C:\Projects\BizTalk-Combined --allow-sev2`

- Resume an existing folder after fixing Sev-1 findings:
  `/run-pipeline --mode biztalk --folder specs/<domain>/001-<slug> --allow-sev2`

- Preview only:
  `/run-pipeline --mode greenfield --input "..." --dry-run`

- Unattended (auto-accept clarifications, allow Sev-2):
  `/run-pipeline --mode greenfield --input "..." --auto-accept-clarifications --allow-sev2`

- Fully unattended with self-healing (CI / overnight):
  `/run-pipeline --mode biztalk --input C:\Projects\BizTalk-Combined --unattended`

- Unattended with a larger remediation budget:
  `/run-pipeline --mode biztalk --folder specs/<domain>/001-<slug> --unattended --auto-fix 5`
