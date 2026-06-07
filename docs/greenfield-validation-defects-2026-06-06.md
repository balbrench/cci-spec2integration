# Greenfield Pipeline Validation — Defect Report

**Date:** 2026-06-06
**Run:** `/run-pipeline --mode greenfield --input examples/08-flat-file-etl-warehouse.md`
**Integration produced:** `specs/greenfield/001-flat-file-sales-etl-warehouse`
**Scenario:** Flat-file fixed-width sales ETL → warehouse bulk load. Mixed-host target — `NightlyDiscoveryFlow` → Azure Logic Apps Standard (scheduled Recurrence + list-files + fan-out + aggregator), `FileLoadFlow` → Azure Data Factory (bulk parse + validate + reconcile + partition-scoped load). First end-to-end greenfield exercise of the **Azure Data Factory** compiler path.

## Purpose

This run was a deliberate validation of the **greenfield** path (prior hardening work focused on the BizTalk→Azure path). It drove example 08 through `/specify → /clarify → /model → /contracts → /map → /architect → /test-mappings → /test-flows → /review → /plan`, paused before `/tasks`. The defects below are **source-level** (agent / command / skill / script) and recur on every greenfield run unless fixed — they are not one-off content issues with this specific integration.

## How the run went (stage-by-stage)

| Stage | Result | Notes |
|---|---|---|
| /specify | ✅ (after manual `--fresh`) | Would have enriched the wrong spec — see **D1** |
| /clarify | ✅ | 8 OQs, auto-signed-off with `--auto-sign-off` (operator chose "accept all defaults") |
| /model | ✅ | 8 entities, 8 events, ~40 invariants, idempotency key `(businessDate, storeId)` |
| /contracts | ❌→✅ | Sev-1 AsyncAPI lint error — see **D2**; fixed + re-lint clean |
| /map | ✅ | 6 mappings (all portable JSONata), `layout/sales-v3.yaml`, 14 fixtures |
| /architect | ✅ (after fixes) | IR validates; but introduced **D4** (queue seam) and **D5** (flow-test fixtures) |
| /test-mappings | ✅ | 8/8 pass |
| /test-flows | ❌→✅ | 2/5 failed initially (**D5**); 5/5 after architect fixture fix |
| /review | ⚠️ | 0 Sev-1 (after **D4** fix), 6 Sev-2 STM_DRIFT (**D3**), 4 Sev-3 advisories; proceeded with `--allow-sev2` |
| /plan | ✅ | plan.md produced; Integration Account correctly = none |
| /tasks → /implement-azure → /test-azure | ⏸ not run | Paused here for this report |

Constitution audit (Articles I–IX): **all PASS**. PII flow: PASS. Secret-scan: correctly **N/A** (greenfield, no `source:` block).

---

## Defects

### D1 — `/specify` enrich-misfire: greenfield run can silently corrupt an unrelated spec  🔴 HIGH (data-loss risk)

**Where:** [.claude/commands/specify.md](../.claude/commands/specify.md) (mode-selection, steps 2–3) + [.claude/commands/run-pipeline.md](../.claude/commands/run-pipeline.md) (greenfield intake).

**Root cause:** `/specify` chooses **enrich mode** whenever an EXISTING SPEC is in scope — and step 2 resolves that from `.spec2integration/state.json`'s `activeIntegration`. `/run-pipeline`'s greenfield branch calls `/specify [PRD-path]` **without `--fresh`**. So when `activeIntegration` points at *any* prior integration (here it pointed at `specs/biztalk/001-biztalk-combined`), a fresh greenfield PRD is folded **into that unrelated spec** instead of creating a new integration.

**Observed:** At run start `activeIntegration = specs/biztalk/001-biztalk-combined`. Driving example 08 through `/specify` would have enriched the BizTalk combined spec. Caught manually; forced fresh mode by invoking `requirements-analyst` directly with explicit fresh instructions, and pinned the new folder as `activeIntegration`.

**Impact:** An **unattended** `/run-pipeline --mode greenfield` (e.g. CI) started while any integration is active will silently mutate the wrong spec.md — a destructive, hard-to-detect outcome.

**Recommended fix (either or both):**
- In [run-pipeline.md](../.claude/commands/run-pipeline.md), the greenfield intake should pass `--fresh` to `/specify` whenever it is **not** a `--folder` resume (a fresh `--input` means a new integration).
- In [specify.md](../.claude/commands/specify.md), treat "the resolved PRD path differs from the active integration's recorded source PRD" as a fresh signal, or **prompt for confirmation before enriching a different integration** than the one the PRD belongs to.

---

### D2 — contract-designer emits a top-level `tags:` block in AsyncAPI 3.x (Sev-1 lint)  🔴 HIGH (deterministic block)

**Where:** [.claude/agents/contract-designer.md:51](../.claude/agents/contract-designer.md#L51).

**Root cause:** The in-head Spectral checklist instructs: *"Do the same for AsyncAPI (`tags`, `info.contact`, `info.license`, non-empty `servers` …)."* The bare token `tags` misleads the agent into emitting a **root-level** `tags:` array — valid in AsyncAPI **2.x**, but **invalid in 3.x**, where tags belong under `info.tags`. Root-level `tags` is rejected by `asyncapi-3-document-resolved` ("Property tags is not expected to be here").

**Observed:** contract-linter (Spectral 6.16.0, live) → 1 Sev-1 + the related Sev-2 `asyncapi-3-tags`. Fixed by moving the block to `info.tags`; re-lint clean (sev1=0).

**Impact:** Every greenfield integration with an AsyncAPI surface (i.e. nearly all async/event flows) blocks at `/contracts` until manually fixed.

**Recommended fix:** Reword [contract-designer.md:51](../.claude/agents/contract-designer.md#L51) to say, for AsyncAPI **3.x**, tags go under **`info.tags`** (there is **no** root `tags`), and enumerate the valid root keys (`asyncapi, id, info, servers, defaultContentType, channels, operations, components`). Consider an explicit "AsyncAPI 3.x trap: tags moved from root → info.tags since 2.x" note.

---

### D3 — mapping-designer STM output self-drifts from its canonical template (6 Sev-2 every run)  🟠 MEDIUM-HIGH

**Where:** [.claude/agents/mapping-designer.md](../.claude/agents/mapping-designer.md) (STM template) + [.claude/agents/stm-drift-checker.md:13,38](../.claude/agents/stm-drift-checker.md#L38).

**Root cause:** `stm-drift-checker` regenerates each `mappings/<Name>.md` using *"the same template `mapping-designer` uses"* and flags any byte difference as Sev-2 `STM_DRIFT`. But the `mapping-designer` **agent** produced **richer** STM docs than the documented template — extra "Positional layout" tables, a "Reject predicates" precedence table, a forensic-reload note, reworded rule notes, truncated/rewritten `Description`/`Effect`. So the committed STMs self-drift from a fresh regeneration: all 6 mappings flagged.

**Observed:** stm-drift-checker → 6/6 Sev-2 STM_DRIFT. The richer content is genuinely useful (derived from the IR/layout, not arbitrary hand-edits), so it was **not** stripped; proceeded with `--allow-sev2`.

**Impact:** Every greenfield run with non-trivial mappings produces a `/review` that is BLOCKED on Sev-2 and requires `--allow-sev2`, masking any *real* Sev-2s.

**Recommended fix (pick one canonical form):**
- **(a, simplest)** Constrain `mapping-designer` to emit **only** the documented template sections (verbatim `Description`/`Effect`, strict rules table, the 4 canonical sections) — makes regeneration deterministic and drift→0.
- **(b)** Extend the shared template (in **both** `mapping-designer.md` and `stm-drift-checker.md`) to include the richer sections in a deterministically-regenerable way (e.g. always render a "Positional layout" table when the source message is `format: flat-file`). Higher value, more work.

---

### D4 — integration-architect: flow-to-flow queue seam modeled with wrong trigger direction + missing idempotency (2 Sev-1)  🟠 MEDIUM (recurs in any fan-out)

**Where:** [.claude/agents/integration-architect.md](../.claude/agents/integration-architect.md) (+ possibly the `ir-authoring` skill).

**Root cause:** `file-load-requested-queue` is the seam between the two flows — produced by `NightlyDiscoveryFlow.requestFileLoad` (`send`) and consumed by `FileLoadFlow` as its `trigger`. The architect declared the channel `direction: outbound` and gave it no `schemaRef`. A channel consumed as a flow trigger must resolve to `inbound`, and with no `schemaRef` the Article III idempotency chain (`channel.schemaRef → message → idempotencyKey`) is broken.

**Observed:** ir-validator → 2 Sev-1: `TRIGGER_CHANNEL_DIRECTION_INVALID` + `IDEMPOTENCY_KEY_MISSING`. Fixed by setting the queue `direction: inbound` and binding `schemaRef: File-Discovered.json` (which carries `idempotencyKey: businessDate+storeId`). Re-validate: 0 Sev-1.

**Impact:** Any multi-flow integration where one flow's output queue is another flow's trigger (a common fan-out / pipeline-of-flows pattern) hits two Sev-1s at `/review`.

**Recommended fix:** Add an explicit rule to `integration-architect` (and document the convention in `ir-authoring`): *a channel consumed as a flow `trigger` MUST be `direction: inbound` and MUST carry a `schemaRef` to a message that declares an `idempotencyKey`; for an internal flow-to-flow queue seam, the consumer (trigger) side governs the declared direction, and the producing `send` may target it freely.*

---

### D5 — integration-architect authors flow-test fixtures at the wrong boundary (2 flow-test failures)  🟡 MEDIUM

**Where:** [.claude/agents/integration-architect.md](../.claude/agents/integration-architect.md) (flow `tests[]` authoring).

**Root cause:** Two `FileLoadFlow` tests (`file-reconciles-and-publishes`, `warehouse-load-exhausts-to-dlq`) were triggered with `contracts/examples/load-context-reconciled.json` — a **downstream `FileLoadContext` projection** (no `rawRecord`). But `FileLoadFlow`'s entry path (`receiveFileRequest → readFile → parseHeader → … validateRows`) slices a positional `rawRecord`. With none present, validation failed, reconciliation never passed, and `bulkLoadPartition` / `partition-published-topic` were never reached — so the asserted outputs and the injected fault never fired.

**Observed:** flow-tester → 2/5 fail. Fixed by adding `contracts/examples/file-load-request-reconciled.json` (a valid `rawRecord` + header + reconcile totals) and re-pointing both test triggers; 5/5 pass.

**Impact:** Flow tests authored against the wrong message shape fail for fixture reasons unrelated to flow logic — noisy false negatives that erode trust in `/test-flows`.

**Recommended fix:** Guidance in `integration-architect`: author each `flows[].tests[]` trigger fixture to match the **flow's entry-step input contract** (the message bound to the trigger channel), not a downstream projection. If mid-flow assertions are needed, use step-boundary injection if/when the IR test model supports it.

---

### D6 — `src/pipeline/FlowTester/Program.cs` diverges from the flow-tester agent contract  🟢 LOW (verify / decide)

**Where:** [src/pipeline/FlowTester/Program.cs](../src/pipeline/FlowTester/) vs [.claude/agents/flow-tester.md](../.claude/agents/flow-tester.md).

**Root cause / status:** The `integration-architect` agent reported the committed .NET FlowTester diverges from the authoritative flow-tester contract in 3 ways: (a) throws on `enrich` steps without a `mappingRef` instead of treating them as no-op pass-throughs; (b) does not register `mappings[].lookups`, so `$lookup("<table>", key)` returns undefined; (c) replaces the message on each transform instead of field-merging. **However**, `flow-tester.md` has **no reference** to the .NET runner — the flow-tester **agent** uses its own in-process jsonata interpreter (confirmed: it ran `jsonata` via node, not `dotnet`). So this divergence does **not** affect `/test-flows` output today.

**Impact:** None on the pipeline currently. `Program.cs` is effectively reference/parallel code that has drifted from the agent contract.

**Recommended fix (decide):** Either (a) wire `src/pipeline/FlowTester` in as the authoritative deterministic runner and align it to the contract (no-op enrich, register lookups, field-merge), or (b) mark it clearly as reference-only / remove it to avoid future confusion. Not urgent.

---

## Summary table

| # | Component | Severity | Recurs every run? | One-line fix |
|---|---|---|---|---|
| D1 | `specify.md` / `run-pipeline.md` | 🔴 HIGH | Yes (when an integration is active) | Pass `--fresh` on fresh greenfield intake / confirm before cross-integration enrich |
| D2 | `contract-designer.md:51` | 🔴 HIGH | Yes (any AsyncAPI) | AsyncAPI 3.x tags → `info.tags`, not root `tags` |
| D3 | `mapping-designer.md` + `stm-drift-checker.md` | 🟠 MED-HIGH | Yes (non-trivial mappings) | Make STM output match the canonical template (constrain agent or extend template) |
| D4 | `integration-architect.md` | 🟠 MED | Yes (any fan-out / flow-to-flow queue) | Trigger channel must be `inbound` + `schemaRef`→idempotencyKey |
| D5 | `integration-architect.md` | 🟡 MED | Likely (multi-step flows) | Flow-test fixtures must match the flow entry-step contract |
| D6 | `src/pipeline/FlowTester/Program.cs` | 🟢 LOW | N/A (not in pipeline path) | Align to agent contract or mark reference-only |

## Process notes (not defects)

- Because I invoked agents directly (rather than via the slash-command wrappers), I manually pinned `activeIntegration` after `/specify` and manually applied the `--auto-sign-off` edits to `clarifications.md` (the existing file was fresh, so no clarifier re-run was needed). Both worked as the command wrappers would have done.
- `--allow-sev2` was used to pass the `/review` gate solely for the D3 STM-drift Sev-2s (operator-approved); the underlying artifacts are correct and richer, not degraded.

## Still outstanding for this validation

The run paused before `/tasks`. The **primary handoff goal** — confirming the source fixes from last session hold on the greenfield path (`parameters.json` must be `{type, value}`; the `func start` runtime gate in `/test-azure`) — is **not yet validated on this integration**, because `/implement-azure` and `/test-azure` have not run. Resume from `/tasks` on `specs/greenfield/001-flat-file-sales-etl-warehouse` to complete that validation (note: this is the first integration to exercise the **Azure Data Factory** compiler at `/implement-azure`).
