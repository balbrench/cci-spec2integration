# Plan: Round-trip and spec quality

**Status:** Implemented (branch `Enhancements2`). Two details changed during implementation and are reflected below: the reconciler reads requirement text from `spec-coverage-report.json` rather than `spec.md` (Article II), and the coverage checker's FR parser was fixed to accept the plain `- FR-1.` ids the spec template uses.
**Date:** 2026-10-21
**Audience:** Engineers and architects implementing Spec2Integration changes
**Builds on:** the maintenance-phase work merged in PR #16 — the lifecycle guard, `/change`, `/analyze`, `/idd` with `decisions.md`, and the Dataverse skill with `azure-dataverse-binder`.

## Purpose

This plan tightens the loop between the **spec** and the **deployed code**. Once an integration is deployed, its generated artifacts become the source of truth and the spec and IR become reference documents that drift. The framework therefore needs to:

- (a) make requirements mechanically traceable, and
- (b) detect when the deployed artifacts no longer match the declared intent.

The work is one small prerequisite fix plus two self-contained changes. All of it is markdown, agent, skill, and catalog work; there is no new VS Code extension UI.

| # | Change | Effort | Prior art |
|---|---|---|---|
| 0 | **Prerequisite:** add the missing commands to the VS Code extension's command catalog | XS | — |
| 1 | **EARS notation for spec functional requirements** | S | EARS (Mavin et al., Rolls-Royce, 2009); AWS Kiro `requirements.md` |
| 2 | **Spec→code reconciliation (bidirectional drift)** | M | — |
| — | *(optional, deferred)* Extract the constitution into a versioned `constitution.md` | S | GitHub Spec Kit constitution |

Ship them in order: **0, then 1, then 2**. Change 1 is small and sharpens the input that both the coverage checker and the reconciler consume.

---

## Change 0 — Command catalog gap (prerequisite)

### Problem

The VS Code extension builds its command composer from a hard-coded list in [`tools/vscode-extension/src/commandCatalog.ts`](../tools/vscode-extension/src/commandCatalog.ts). Four commands added in PR #16 are missing from it: `/analyze`, `/change`, `/idd`, and `/lifecycle`. Users of the extension cannot see or compose them.

### Change

| File | Change |
|---|---|
| `tools/vscode-extension/src/commandCatalog.ts` | Add entries for the four missing commands. `/analyze` and `/idd` are folder-only (`folderOnly(...)`, group `Reporting`). `/change` takes a quoted description plus a folder, and `/lifecycle` takes a verb (`freeze` / `unfreeze` / none) plus a folder and an optional `--stage`; both need full entries with `args`, in a new `Maintenance` group. |

Change 2 adds one more entry (`/reconcile`). Every future command needs a catalog entry too; add a line to [`docs/platform-pack-guide.md`](platform-pack-guide.md) saying so.

### Testing

Run `npm run compile` in `tools/vscode-extension`, launch the Extension Development Host (F5), and confirm the four commands appear in the composer with the right arguments.

---

## Change 1 — EARS notation for spec functional requirements

### Problem

`spec.md` functional requirements are free-form prose today. `spec-coverage-checker` traces each MUST clause to an IR construct with a regex rule pack. Free-form text often matches no rule and falls through to `MANUAL_TRACE_REQUIRED` (Sev-3), which weakens phase gate 6 ("every MUST clause satisfied by an IR construct"). A requirement like "duplicate submissions should be handled" is neither testable nor traceable.

### Design

Adopt **EARS** (Easy Approach to Requirements Syntax): every functional requirement is a single trigger→response statement.

Five patterns, shown with `SHALL`:
- **Ubiquitous** — `THE SYSTEM SHALL <response>.`
- **Event-driven** — `WHEN <trigger> THE SYSTEM SHALL <response>.`
- **State-driven** — `WHILE <state> THE SYSTEM SHALL <response>.`
- **Unwanted behaviour** — `IF <condition> THEN THE SYSTEM SHALL <response>.`
- **Optional feature** — `WHERE <feature present> THE SYSTEM SHALL <response>.`

Rules:
- **Requirement level.** Classic EARS uses only `SHALL`. This pipeline also needs SHOULD- and MAY-level requirements, so the EARS structure stays fixed and the RFC-2119 keyword takes the `SHALL` slot: `SHALL` / `SHALL NOT` / `MUST` → MUST-level, `SHOULD` → SHOULD-level, `MAY` → MAY-level. For example: `WHEN a batch file arrives after the cut-off THE SYSTEM SHOULD process it in the next window.`
- **One keyword per FR.** Split compound requirements into separate FRs.
- **Uppercase keywords**, so humans and the parser both spot them. The checker matches keywords case-sensitively today, which stays.
- **The text changes, the ids don't.** EARS changes the requirement *text*, not the `FR-N` id markup, so the existing parser and numbering are untouched.
- **NFRs stay as measured thresholds**, not WHEN/THEN behaviours.

### Files to add / change

| File | Change |
|---|---|
| `.claude/skills/ears-requirements/SKILL.md` | **New.** The authoritative notation: the five patterns, the keyword-to-level mapping above, the rules (one keyword per FR, a concrete observable trigger and response), free-form→EARS examples, and how the coverage checker and reconciler use it. |
| `.claude/agents/requirements-analyst.md` | Add `ears-requirements` to the `skills:` frontmatter so it is always preloaded. In the authoring step and the enrich-mode step, require each FR to be written in EARS. This also covers `/clarify`, which calls `requirements-analyst` to fold resolved answers back into `spec.md`. |
| `.claude/agents/biztalk-spec-author.md` | Same as above: preload `ears-requirements` and write each inferred FR in EARS. Without this, migration specs keep free-form FRs and get less of the traceability benefit. |
| `.claude/agents/spec-coverage-checker.md` | In "Parse spec.md", add `SHALL` / `SHALL NOT` / `REQUIRED` as MUST-level keywords (the checker recognises only `MUST` / `SHOULD` / `MAY` today). Capture an optional `earsResponse` (the text after the keyword) and run the forward-trace rule pack against the response clause first. Explicit response verbs match rules like `R-IDEMPOTENT`, `R-TRANSFORM` and `R-DLQ` far more reliably than full prose. |
| `.claude/agents/spec-coverage-checker.md` (fix) | The FR/NFR/OQ parser only accepted bold ids (`- **FR-1.**`), but `templates/core/spec.md` writes plain ones (`- FR-1.`). Accept both. Also add `text`, `earsPattern`, and `earsResponse` to each `matrix.forward[]` row of `spec-coverage-report.json`, so the reconciler can quote requirements without reading `spec.md`. |
| `templates/core/spec.md` | Show the EARS form in the Functional requirements section (`FR-1. WHEN … THE SYSTEM SHALL …`), with a one-line comment pointing at the skill. |
| `CLAUDE.md`, `README.md` | Skill count +1. |

### Format / parser impact

- **`mustLevel`:** `SHALL` / `SHALL NOT` / `REQUIRED` become MUST-level. This is the only behavioural change to the checker, and it changes no severity: today a `SHALL` FR with no other keyword already falls back to the FR→MUST default. The explicit mapping makes it correct and documented.
- **Id markup unchanged:** the `FR-N` / `NFR-N` regexes stay as they are. No existing spec needs migrating; EARS applies to newly written or enriched requirements, and existing free-form FRs keep parsing.

### Testing

- Write a small spec through `/specify` and confirm the FRs come out in EARS form, including at least one SHOULD-level FR.
- Run `/review` (which invokes `spec-coverage-checker`) on that spec and confirm that rules such as `R-IDEMPOTENT` and `R-TRANSFORM` now match requirements that free-form prose previously left at `MANUAL_TRACE_REQUIRED`.
- Confirm an existing free-form spec still parses with the same verdicts (no regression).

### Risks

Low: the change is additive and backward-compatible. The main risk is forcing NFRs into EARS; the explicit "NFRs stay measured" rule guards against it.

---

## Change 2 — Spec→code reconciliation (bidirectional drift)

### Problem

Today's checkers each answer a narrower question:
- `/drift-check` detects **hash drift**: did a generated file change since `/implement`?
- `stm-drift-checker` detects drift in the mapping documents.
- `/analyze` joins the existing reports.

None of them answers the most useful question: **do the deployed artifacts still do what the spec and IR say they do?** On a post-implementation integration the artifacts are the source of truth, and the spec and IR drift away from reality. Today that drift is tribal knowledge, not something a tool can detect.

### Design

A new **read-only, advisory** reconciliation pass compares declared intent (`spec.md` + `integration-ir.yaml`) with the generated artifact tree in **four directions**. "Deployed" here means the artifact tree in the integration folder; the pass reads files and never calls Azure.

1. **IR → code (declared but not implemented).** Each `flows[]`, `mappings[]`, `dependencies[]`, external `channels[]` and `errorHandling` block should have a matching artifact. A missing artifact gives `IMPL_MISSING`, `TRANSFORM_MISSING`, `BINDING_MISSING` or `RESILIENCE_MISSING`.
2. **Code → IR (implemented but not declared: "the spec lies").** Each feature-bearing artifact should trace back to an IR construct. One that doesn't gives `IMPL_UNACCOUNTED`, `SCHEMA_UNACCOUNTED`, `TRANSFORM_UNACCOUNTED` or `BINDING_UNACCOUNTED`. *No existing checker can see this direction.*
3. **Spec → code (behaviour not implemented).** Chain spec→IR (reusing `spec-coverage-report.json`) with IR→code. A MUST-level FR that is satisfied in the IR but has no implementing artifact gives `SPEC_BEHAVIOR_UNIMPLEMENTED`. The finding quotes the EARS trigger→response so the at-risk behaviour is explicit; this is where Change 1 pays off.
4. **Divergent transforms.** Where a mapping and its implementing transform both exist but equivalence cannot be confirmed (for example a stubbed or empty map), the result is `TRANSFORM_DIVERGED`. Never assert divergence without evidence: say "could not confirm equivalence" and name both locations.

**Severity: every reconciliation finding is Sev-3 (advisory).** The constitution defines Sev-2 as "must be fixed before merge", so Sev-2 would contradict the advisory intent. The verdict (`ALIGNED` / `DIVERGED`) gates nothing, and `reviewer` must **not** aggregate this report into its blocking verdict. A divergence on a deployed integration is a prompt for human judgment ("re-baseline the IR via `/change`", or "the spec is stale, update it"), never an automatic regeneration. This respects the lifecycle-guard model.

**Platform split.** Directions 1, 2 and 4 must know each platform's artifact layout (for Azure: `app/<flow>/workflow.json`, `adf/pipelines/`, `sql/`, `infra/`, `FunctionApps/`, `Functions/`). Following the repo's platform-pack convention ([`docs/platform-pack-guide.md`](platform-pack-guide.md)), that knowledge lives in a **pack-prefixed agent**, not a core one:
- **`/reconcile`** is a platform-neutral command. It reads `activePlatform` from `.spec2integration/state.json` and dispatches to `<platform>-spec-code-reconciler`. If the active pack has no reconciler, it stops with a clear message.
- **`azure-spec-code-reconciler`** is the Azure implementation of all four directions. Direction 3 reuses `spec-coverage-report.json`, so the spec-side logic stays in the existing core checker.
- A future pack (AWS, MuleSoft) adds its own `<plat>-spec-code-reconciler` without touching the command.

### Files to add / change

| File | Change |
|---|---|
| `.claude/agents/azure-spec-code-reconciler.md` | **New.** The four-direction logic for the Azure artifact layout, the finding list above (all Sev-3), and the two output reports. Read-only, and exempt from `status.json` because it produces a report, not a stage artifact (like `target-architecture`). As a pack agent it **never reads `spec.md`** (Article II): requirement text comes from the `matrix.forward[]` rows of `spec-coverage-report.json`. |
| `.claude/commands/reconcile.md` | **New.** A `[Reporting]` command: resolve the folder, require `integration-ir.yaml`, dispatch to `<activePlatform>-spec-code-reconciler`, print the summary, and ask a follow-up. Read-only: it writes only the report, never `status.json`. Not guarded by the lifecycle guard, since it never regenerates; it is the natural post-deployment check. |
| `.claude/commands/analyze.md` | Add the reconciler to the parallel fan-out in step 2 (skipped when the active pack has none, or when there is no artifact tree yet), and merge its findings into the conflict table under a new **Spec↔code** heading. `/analyze` already describes itself as checking whether the spec, IR, plan, tasks and *deployed artifacts* agree, so it is the natural aggregator. |
| `.claude/agents/reviewer.md` | State explicitly that `reconciliation-report.json` is advisory and is not aggregated into the review verdict. |
| `.claude/skills/pipeline-status/SKILL.md` | Add `/reconcile` and `azure-spec-code-reconciler` to the read-only / exempt lists. |
| `docs/platform-pack-guide.md` | List `<plat>-spec-code-reconciler` as an optional agent a platform pack can provide. |
| `tools/vscode-extension/src/commandCatalog.ts`, `tools/pipeline-runner/index.html`, `tools/pipeline-runner/server.mjs` | Add `/reconcile` to the extension catalog (`Reporting` group) and to the web runner's folder-command list and allow-list. |
| `docs/agent-reference.md` | Add the reconciler (and the three agents from PR #16 that were never documented there). |
| `CLAUDE.md`, `README.md` | Counts (agents +1, commands +1). Add `/reconcile` to the Reporting intent, add `azure-spec-code-reconciler` to the `azure-` agents row, and mention it in the maintenance-phase section. |

### Outputs

- `<folder>/reconciliation-report.md` — findings grouped by direction; each row names the IR location, the artifact path, and a one-line explanation.
- `<folder>/reconciliation-report.json` — `{ generated, activePlatform, summary: { implMissing, implUnaccounted, specUnimplemented, diverged, verdict }, findings: [...] }`.

### How it fits with existing commands

| Command | Question it answers |
|---|---|
| `/drift-check` | Did a generated file change since `/implement`? (hash) |
| `/reconcile` | Do the generated artifacts still match the spec and IR? (meaning, not hashes) |
| `/analyze` | Do all the artifacts agree with each other? Aggregates the coverage, STM-drift, artifact-drift and reconciliation findings into one table. |
| `/review` | Is the integration constitutionally compliant? The blocking verdict; does not include reconciliation findings. |

### Testing

This repo contains no integration folder to test against (`specs/` is empty and `examples/` holds only briefs), so testing needs one:

1. Generate an integration from a bundled brief, for example `/run-pipeline` on `examples/04-order-event-fanout.md`, through `/implement-azure`.
2. Run `/reconcile` and confirm the verdict is `ALIGNED` with no findings, or only explained Sev-3 findings.
3. Inject one divergence in each direction and confirm each is reported with both locations:
   - delete a flow's `workflow.json` → `IMPL_MISSING`;
   - add a SQL table no IR dependency accounts for → `SCHEMA_UNACCOUNTED`;
   - empty a deployed map → `TRANSFORM_DIVERGED`.
4. Confirm it writes only the two report files and never `status.json` or any artifact.
5. Confirm `/analyze` includes the findings and `/review`'s verdict is unchanged.

### Risks

- **Medium.** The code→IR direction has to enumerate the "feature-bearing" artifacts in each host tree and match them to IR constructs, and matching heuristics can produce false positives. Mitigation: back every finding with both locations, keep every finding Sev-3, and phrase unconfirmable equivalence as "could not confirm" rather than asserting divergence.
- Transform equivalence (direction 4) is genuinely hard. Keep it advisory and evidence-based rather than attempting semantic equality between JSONata and a deployed data flow.

---

## Optional refinement — versioned `constitution.md` (deferred)

Not one of the changes in this plan; recorded here so it is not lost. Extract the `# Spec2Integration Constitution` section from `CLAUDE.md` into a top-level `constitution.md` with a version header and a changelog, so the reviewer can cite "Article vX.Y" and changes to the principles become diffable. Many agents and commands refer to the constitution as "CLAUDE.md", so this is a broad refactor and should be its own change if pursued.

## Sequencing

1. **Change 0 (catalog gap).** Fixes a gap that already exists in the extension; independent of the rest.
2. **Change 1 (EARS).** Small, backward-compatible, and it sharpens the input Change 2 uses. Ships with its own count update.
3. **Change 2 (reconciliation).** Structurally independent of Change 1, but its spec→code direction benefits from EARS-shaped FRs.

## Out of scope

- New VS Code extension UI: per-stage checkpoint and revert, a panel showing which stages are stale and how they depend on each other, and a diff-and-approve gate. Change 0 and the `/reconcile` catalog entry are data edits, not UI work.
- Migrating existing specs to EARS. EARS applies going forward, and existing free-form FRs keep parsing.
- Reconcilers for platform packs other than Azure.
