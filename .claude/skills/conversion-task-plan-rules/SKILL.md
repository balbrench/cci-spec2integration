---
name: conversion-task-plan-rules
description: Rules for generating ordered Azure implementation task plans. Covers mandatory task ordering, Integration Account decision rules, required task fields, and runtime-validation/testing stages.
---

# Conversion Task Plan Rules

> Purpose: Authoritative rules for how an agent should derive an ordered Azure implementation task plan from the IR and plan artifacts. Follow exactly.

## 1. Task derivation

Determine all implementation tasks required by the chosen platform design. Derive tasks from the actual flow architecture, message formats, dependencies, artifact model, and deployment needs.

## 2. Mandatory task order

### 2.1 Scaffolding first

- The first implementation task group establishes the Logic Apps Standard project layout.
- Scaffold before generating workflows, artifacts, tests, connections, or infrastructure.

### 2.2 Artifact and implementation tasks in the middle

After scaffold, add tasks for the implementation slices that apply:

- Schemas → `app/Artifacts/Schemas/`
- Maps → `app/Artifacts/Maps/`
- Rules or certificates when applicable
- Local functions → local-functions project
- Workflows → `app/<FlowName>/workflow.json`
- Connections → `app/connections.json`, `parameters*.json`, app settings
- Infrastructure for connectors or resources with no local equivalent

### 2.3 Integration Account decision rule

For every artifact-related task, explicitly decide whether the flow uses:

- Logic App `Artifacts/` folders, or
- Integration Account.

Rules:

- Use Integration Account when the design requires Integration Account-only capabilities, especially B2B or EDI scenarios such as X12, EDIFACT, AS2, partners, agreements, or centrally shared schemas/maps.
- If a flow uses Integration Account, keep that artifact model consistent for that flow. Do not split deployable artifacts for the same flow between Integration Account and local `Artifacts/` folders.
- Provision and configure the Integration Account before any schema, map, certificate, partner, or agreement task that depends on it.
- Integration Account provisioning must include the actual Azure resource creation, not just IaC file generation.
- That provisioning step must capture the Integration Account resource ID and callback URL and ensure the required Logic Apps Standard app settings are planned: `WORKFLOWS_INTEGRATION_ACCOUNT_ID` and `WORKFLOW_INTEGRATION_ACCOUNT_CALLBACK_URL`.
- The next Integration Account artifact step must explicitly upload schemas, maps, certificates, partners, and agreements as required.
- Critical: after uploading X12 or EDIFACT schemas, agreements must be updated so `schemaReferences[]` is populated. Empty `schemaReferences[]` is a runtime defect that causes `X12Decode` or `EdifactDecode` failures.

### 2.4 Runtime validation before E2E testing

- After generation tasks, include a runtime-validation stage.
- Runtime validation means starting the app locally and fixing startup issues before broader E2E execution.

### 2.5 Local E2E testing after runtime validation

- Include a local E2E testing stage after runtime validation.
- This stage must use `runtime-validation-and-testing/SKILL.md` for test coverage, field-level validation, and `TEST-REPORT.md` generation.

### 2.6 Optional cloud testing last

- If cloud testing is included, it must be the final implementation-stage activity.
- Local validation must pass first.

## 3. Task ID and task-shape rules

- Task identifiers must be descriptive. Avoid generic sequential names.
- Every task should clearly state the target output path or artifact slice it touches.
- Group tasks by the smallest meaningful implementation slice. Prefer one file or one narrow artifact family per task.
- Preserve TDD order: test tasks appear before the implementation tasks they verify.

## 4. Required content in each task

Each task should make clear:

- what artifact or file slice it changes,
- why it exists,
- what it depends on,
- what requirement or IR element it traces back to,
- and, where needed, the key execution rule (for example, use reference workflows, preserve BizTalk flat-file XSDs verbatim, or patch Integration Account agreement schema references).

## 5. Key execution rules to embed in tasks

- Workflow-generation tasks should instruct the executor to consult the Azure reference workflows before writing `workflow.json`.
- Connection-generation tasks should instruct the executor to follow canonical `connections.json` shapes.
- Local-function tasks should reference the local-functions skill.
- Runtime-validation and E2E tasks should reference `runtime-validation-and-testing/SKILL.md`.
- Reverse-engineered BizTalk flows should preserve source design and use the original native artifacts (`nativeSchemaRef`, `codeRef`) rather than approximating behavior.

## 6. Completion rule

A plan is not implementation-ready unless it explicitly includes:

- scaffolding,
- artifact generation,
- workflow generation,
- connections and settings,
- infrastructure where needed,
- runtime validation,
- local E2E testing,
- and optional cloud testing only after local validation passes.
