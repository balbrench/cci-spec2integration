# Plan: <Integration Name>

<!-- produced by planner; reviewed by reviewer; do not hand-edit -->

- **Integration folder:** specs/<domain>/NNN-<slug>/
- **Active platform pack:** <name from .spec2integration/state.json>
- **Constitution:** CLAUDE.md
- **IR:** specs/<domain>/NNN-<slug>/integration-ir.yaml
- **Research:** specs/<domain>/NNN-<slug>/research.md

## Overview

<One paragraph restating purpose and scope.>

## Phase 0 - Scaffolding

- **Entry:** constitution phase gates 1-6 pass.
- **Exit:** platform project structure created and builds green with no logic.

Steps:

- ...

## Phase 1 - Contracts in place

- **Entry:** Phase 0 exit.
- **Exit:** schema validation harness runs; contract mocks generated.

## Phase 2 - Per-flow implementation

For each flow in the IR:

### Flow: <FlowName>

| IR step id | Type | Platform mapping | Test | Observability |
|------------|------|------------------|------|---------------|
| ...        | ...  | ...              | ...  | ...           |

Notes:

- Error handling: retry=<policy,count,interval>, dlq=<channel>.
- Identity: <managedIdentity>, role assignments listed.
- Correlation id: <header or field>.

## Phase 3 - Infrastructure

- Compute: <module>
- Messaging: <module>
- Identity: <module>
- Monitoring: <module>

## Phase 4 - CI/CD

- Build
- Lint (contracts, IaC)
- Unit test
- Integration test (staging)
- Deploy (dev -> prod gates)

## Phase 5 - Verification

| FR/NFR | How verified | Evidence |
|--------|--------------|----------|
| FR-1   | <test id>    | <path>   |
| NFR-1  | <test id>    | <path>   |

## Open items

- ...
