# Agent Reference

Reference for the currently documented agents in the Spec2Integration pipeline.

Agents are background workers invoked by prompts — they are **not called directly** (`user-invocable: false`). They follow a naming convention:

- **Unprefixed** — platform-neutral core agents
- **`azure-`** — Azure Integration Services platform pack
- **`biztalk-`** — BizTalk Server reverse-engineering pack

The user-facing prompt layer is now grouped by role so people do not have to reason about all agents at once:

- `Guided` prompts orchestrate multiple agents or stages. Examples: `/run-pipeline`, `/prepare-for-implementation`, `/biztalk-reverse-engineer`.
- `Manual` prompts move one primary artifact forward. Examples: `/specify`, `/contracts`, `/architect`, `/implement-azure`.
- `Reporting` prompts summarise state or structure without advancing the pipeline. Examples: `/next`, `/status`, `/visualize`, `/ir-diff`, `/drift-check`.
- `Recovery` prompts target validation and unblock loops. Examples: `/review`, `/platform`, `/test-mappings`, `/test-flows`, `/test-azure`.
- `Advanced` prompts are optional specialist utilities. Example: `/domain`.

That taxonomy exists to reduce navigation overhead. The agents below remain deliberately granular because the constitution still enforces one agent per primary artifact or concern.

> **Skill preloading.** The reference-heavy compilers (`azure-logic-apps-compiler`, `azure-connections-binder`, `azure-bicep-author`, `azure-functions-compiler`, `azure-workflow-tester`, and the `biztalk-*` compilers) declare their always-needed authoritative skills in a `skills:` frontmatter list, so those skills' `SKILL.md` instructions are injected at startup — a load *guarantee* rather than relying on the model to read them, which hardens failure modes like emitting a guessed connector `operationId`. Per-channel / per-format skills stay listed in each agent's `## Inputs` and load on demand.

---

## Core Agents (20 — platform-neutral)

### prd-author

| | |
|---|---|
| **Purpose** | Turn a rough brief into a structured PRD |
| **Invoked by** | `/draft-prd` |
| **Inputs** | User-provided brief (inline text) |
| **Outputs** | `specs/PRD.md` |
| **Tools** | read, edit, search |
| **Template** | `templates/core/prd.md` |

Identifies purpose, trigger, actors, data flows, and constraints from a few sentences or bullet points. Marks assumptions and lists open questions.

---

### requirements-analyst

| | |
|---|---|
| **Purpose** | Convert a PRD into a rigorous specification |
| **Invoked by** | `/specify` |
| **Inputs** | PRD file (user-supplied path) |
| **Outputs** | `specs/<domain>/NNN-<slug>/spec.md` |
| **Tools** | read, edit, search |
| **Template** | `templates/core/spec.md` |

Derives user stories, functional requirements (numbered FRs), non-functional requirements (NFRs), actors, scope, and non-scope. Every FR cites the PRD passage it derives from.

**Re-invocation:** when called a second time on a folder where `clarifications.md` already exists (typically from `/clarify`), the agent switches to **fold-back mode**: it does **not** rewrite the spec from the PRD. It scans `clarifications.md` for OQ blocks that have **both** `**Resolved:** true` *and* a fully-populated Resolution log row (Answer + Source + Decided by + Date), then folds those answers into the spec by rewriting affected FRs/NFRs and removing the matching OQ from the Open questions section. Partially-signed-off OQs (flag set but log row blank, or vice versa) are left untouched.

---

### clarifier

| | |
|---|---|
| **Purpose** | Annotate every open question in spec.md with candidate answers, a recommendation, evidence, confidence, and a Resolved flag |
| **Invoked by** | `/clarify` |
| **Inputs** | `spec.md`, original PRD; if present: `biztalk-inventory.md`, `contracts/`, `integration-ir.yaml`, constitution |
| **Outputs** | `clarifications.md` |
| **Tools** | read, edit, search |

For each OQ-N in spec.md, produces a structured block: `**Question:**`, `**Candidate answers:**` (a/b/c/d), then a bulleted meta-list with `**Recommended:**`, `**Evidence:**`, `**Confidence:**`, and `**Resolved:**`. Marks `Resolved: true` only when the answer is unambiguous from artifact evidence; otherwise `Resolved: false` and a note explaining what business sign-off is required.

At the bottom of the file the agent emits an empty **Resolution log** table with one row per OQ. The agent never populates rows — that is the human's audit trail.

**Sign-off rule (dual gate):** an OQ is treated as signed off downstream only when **both** the per-OQ `**Resolved:** true` flag is set **and** all four cells of the matching Resolution log row are populated. The generated `clarifications.md` opens with a "How to sign off an OQ" section that walks the human through this. After sign-off, re-running `/clarify` re-invokes `requirements-analyst` in fold-back mode (see above).

---

### domain-modeler

| | |
|---|---|
| **Purpose** | Produce the domain data model |
| **Invoked by** | `/model` |
| **Inputs** | `spec.md`, `clarifications.md` |
| **Outputs** | `data-model.md` |
| **Tools** | read, edit, search |
| **Prerequisite** | All Sev-1 clarifications signed off (per-OQ `Resolved: true` **and** Resolution log row complete) |

Enumerates entities (with identity fields, invariants), events (with correlation keys), commands, and lookups. PascalCase for types, camelCase for fields.

---

### contract-designer

| | |
|---|---|
| **Purpose** | Produce wire-level contracts from spec and data model |
| **Invoked by** | `/contracts` |
| **Inputs** | `spec.md`, `data-model.md`, `integration-ir.yaml` (when present) |
| **Outputs** | `contracts/openapi.yaml`, `contracts/asyncapi.yaml`, `contracts/schemas/<Entity>.json` |
| **Tools** | read, edit, search |
| **Templates** | `templates/core/contracts/` |

Produces one JSON Schema per entity/event, OpenAPI for HTTP endpoints, AsyncAPI for async channels. When the IR already exists, performs IR-round-trip projection.

---

### contract-linter

| | |
|---|---|
| **Purpose** | Lint and validate all contracts |
| **Invoked by** | `/contracts` (final step) |
| **Inputs** | `contracts/openapi.yaml`, `contracts/asyncapi.yaml`, `contracts/schemas/*.json`, `integration-ir.yaml` |
| **Outputs** | `contract-lint-report.md`, `contract-lint-report.json` |
| **Tools** | read, edit, search, execute |

Runs Spectral on OpenAPI/AsyncAPI, ajv on JSON Schemas, and an IR-round-trip divergence check. Any lint error is a hard block.

---

### mapping-designer

| | |
|---|---|
| **Purpose** | Produce platform-neutral mappings and STM documents |
| **Invoked by** | `/map` |
| **Inputs** | `spec.md`, `data-model.md`, `contracts/` |
| **Outputs** | IR `mappings:` block, `mappings/<Name>.md` (STM documents), test fixtures |
| **Tools** | read, edit, search |

Selects mapping engine (JSONata default, XSLT, Liquid, JSLT). Writes field-level rules, lookups, protocol headers. Authors test fixtures with input/expected-output pairs.

---

### mapping-tester

| | |
|---|---|
| **Purpose** | Execute mapping test fixtures and report pass/fail |
| **Invoked by** | `/test-mappings` |
| **Inputs** | `integration-ir.yaml`, fixture files |
| **Outputs** | `mapping-test-report.md`, `mapping-test-report.json` |
| **Tools** | read, edit, search, execute |

Evaluates each mapping's test fixtures against the declared expression using the appropriate runtime (JSONata, XSLT, Liquid, JSLT). Reports diffs on failure.

---

### integration-architect

| | |
|---|---|
| **Purpose** | Produce the vendor-neutral Integration IR |
| **Invoked by** | `/architect` |
| **Inputs** | `spec.md`, `data-model.md`, `contracts/`, `mappings/` |
| **Outputs** | `integration-ir.yaml` |
| **Tools** | read, edit, search |
| **Skills** | `eip-patterns`, `ir-authoring` |
| **Schema** | `schemas/integration-ir.schema.json` |
| **Template** | `templates/core/integration-ir.yaml` |

Derives channels from contracts, messages from schemas, endpoints from OpenAPI, flows from spec FRs. Selects EIP patterns (content-based router, scatter-gather, etc.). Writes error handling, identity, and non-functionals.

---

### ir-validator

| | |
|---|---|
| **Purpose** | Validate IR structural correctness and cross-references |
| **Invoked by** | `/review` |
| **Inputs** | `integration-ir.yaml`, `contracts/schemas/*.json`, `schemas/integration-ir.schema.json` |
| **Outputs** | `ir-validation-report.md`, `ir-validation-report.json` |
| **Tools** | read, edit, search |

Checks: step `next` pointers resolve, `mappingRef` matches a `mappings[].name`, `schemaRef` files exist, trigger channels exist, names are unique, `onError`/`dlq` targets resolve.

---

### domain-architect

| | |
|---|---|
| **Purpose** | Group integrations into a domain artifact |
| **Invoked by** | `/domain` |
| **Inputs** | All `integration-ir.yaml` files in workspace |
| **Outputs** | `specs/<domain>/domain.yaml` |
| **Tools** | read, edit, search |
| **Schema** | `schemas/domain-ir.schema.json` |

Discovers integrations by domain, assigns layers (experience/process/system), identifies canonical cross-integration events, derives domain-wide policy defaults.

---

### target-architecture

| | |
|---|---|
| **Purpose** | Author the cross-service Azure target architecture document for an integration (or a domain of integrations) |
| **Invoked by** | Manual delegation between `integration-architect` (IR) and `azure-bicep-author` (per-integration Bicep) |
| **Inputs** | `spec.md`, `integration-ir.yaml`, `contracts/`; optional `domain.yaml`, sibling integration folders, `plan.md`, `clarifications.md` |
| **Outputs** | `target-architecture.md` |
| **Tools** | read, edit, search |
| **Skills** | `ais-platform`, `eip-to-azure-mapping`, `eip-patterns`, `api-management`, `service-bus`, `event-grid` (as applicable) |

Produces an architecture decision record that maps the IR to explicit Azure service selection, security model, networking, naming/tagging, RBAC, and provisioning order. Invoke when the engagement spans multiple flows in a domain, or when stakeholders need a written architecture sign-off before Bicep authoring. Not required for trivial single-flow integrations — those go straight from `integration-architect` to `azure-bicep-author`.

---

### planner

| | |
|---|---|
| **Purpose** | Produce the implementation plan after checking all phase gates |
| **Invoked by** | `/plan` |
| **Inputs** | `integration-ir.yaml`, all upstream artifacts, `.spec2integration/state.json` |
| **Outputs** | `plan.md`, `research.md` |
| **Tools** | read, edit, search |

**Phase gates enforced:**
1. `spec.md` exists
2. Clarifications resolved
3. `data-model.md` exists
4. Contracts exist
5. IR exists and validates
6. Platform pack selected
7. Zero Sev-1 review violations

---

### task-decomposer

| | |
|---|---|
| **Purpose** | Break plan into atomic TDD-ordered tasks |
| **Invoked by** | `/tasks` |
| **Inputs** | `plan.md`, `integration-ir.yaml`, `contracts/` |
| **Outputs** | `tasks.md` |
| **Tools** | read, edit, search |

Tasks are numbered (T-NNN), ordered with tests before implementation (Article VII), and marked `[P]` when parallelizable. Each task links to the FR/NFR/IR element it implements.

---

### reviewer

| | |
|---|---|
| **Purpose** | Audit all artifacts against the constitution |
| **Invoked by** | `/review` |
| **Inputs** | Everything in the integration folder, constitution |
| **Outputs** | `review-report.md`, `review-report.json` |
| **Tools** | read, edit, search |

Aggregates findings from `ir-validator`, `pii-flow-checker`, `stm-drift-checker`, `secret-scanner` (when the IR is reverse-engineered), `spec-coverage-checker`, and `flow-tester` (when flows declare `tests[]`). `/review` runs `ir-validator` first as a fail-fast pre-gate, then fans the independent validators out **in parallel** before this agent aggregates their reports. Walks Articles I–IX. Reports at Sev-1/2/3. The planner will not proceed with any open Sev-1.

---

### flow-tester

| | |
|---|---|
| **Purpose** | Run end-to-end flow tests through a deterministic interpreter |
| **Invoked by** | `/test-flows` |
| **Inputs** | `integration-ir.yaml`, fixture files |
| **Outputs** | `flow-test-report.md`, `flow-test-report.json` |
| **Tools** | read, edit, search, execute |

Builds an in-process DAG from `flows[].tests[]`, injects trigger payloads, walks nodes, evaluates mappings via JSONata, and compares emitted messages against `expect` declarations.

---

### pii-flow-checker

| | |
|---|---|
| **Purpose** | Verify PII fields never reach public channels without redaction |
| **Invoked by** | `/review` |
| **Inputs** | `integration-ir.yaml` |
| **Outputs** | `pii-flow-report.md`, `pii-flow-report.json` |
| **Tools** | read, edit, search |

Walks the message graph across channels. A `pii: true` field emitted onto a `classification: public` channel without `redact: hash | mask | drop` is a Sev-1 violation (Article V).

---

### stm-drift-checker

| | |
|---|---|
| **Purpose** | Detect drift between STM documents and the IR |
| **Invoked by** | `/review`, `/drift-check` |
| **Inputs** | `integration-ir.yaml`, `mappings/<Name>.md` |
| **Outputs** | `stm-drift-report.md`, `stm-drift-report.json` |
| **Tools** | read, edit, search |

Regenerates each STM document from the IR's `mappings[]` block and byte-compares against the committed file. Any diff is a Sev-2 finding.

---

### spec-coverage-checker

| | |
|---|---|
| **Purpose** | Two-way trace between spec.md (FRs/NFRs/OQs) and integration-ir.yaml |
| **Invoked by** | `/review`; gate for `planner` |
| **Inputs** | `spec.md`, `integration-ir.yaml`, `clarifications.md` (optional) |
| **Outputs** | `traceability-matrix.md`, `spec-coverage-report.md`, `spec-coverage-report.json` |
| **Tools** | read, edit, search |

Runs a rule pack (FTP / HTTP / DLQ / retry / idempotency / flat-file / XSLT-fidelity / classification / etc.) to verify every `MUST` requirement in spec.md is satisfied by an IR construct. Reverse-traces every IR construct back to a sourcing FR/NFR. Unmatched MUSTs are Sev-1 `FR_NOT_SATISFIED`; un-backed IR constructs are Sev-2 `IR_FEATURE_UNSPECIFIED`; unresolved OQs not tracked in IR are Sev-2 `OPEN_QUESTION_UNRESOLVED`.

---

### secret-scanner

| | |
|---|---|
| **Purpose** | Scan for leaked secrets |
| **Invoked by** | `/review`, `/implement-azure` |
| **Inputs** | Target directory path |
| **Outputs** | `secret-scan-report.md`, `secret-scan-report.json` |
| **Tools** | read, edit, search, execute |

Uses trufflehog (preferred) or gitleaks. Any detected secret is a Sev-1 violation.

---

## Azure Pack Agents (9)

These consume `integration-ir.yaml` and `contracts/` to produce a deployable Azure solution. They never read the PRD, spec, or data model directly. Each flow is routed by `flows[].implementation.host` to one of three host types: Logic Apps Standard (default), Function App, or Data Factory. The matching compiler is skipped when its bucket is empty.

### azure-logic-apps-compiler

| | |
|---|---|
| **Purpose** | Compile each IR flow whose host is `logic-app-standard` to Logic Apps Standard workflow.json |
| **Invoked by** | `/implement-azure` |
| **Inputs** | `integration-ir.yaml`, `contracts/` |
| **Outputs** | `app/<Flow>/workflow.json` (per flow), `app/host.json`, `app/workflow-designtime/`, `app/Artifacts/Maps/`, `app/Artifacts/Schemas/` |
| **Tools** | read, edit, search |
| **Skill** | `eip-to-azure-mapping` |

Translates each IR flow to a native workflow.json. Selects trigger type by channel kind, emits actions per EIP node type, compiles mappings, sets stateful/stateless, applies runtime config. Skipped when no flow routes to `logic-app-standard`.

---

### azure-functions-compiler

| | |
|---|---|
| **Purpose** | Compile each IR flow whose host is `function-app` to a stand-alone .NET 8 isolated-worker Azure Function App project |
| **Invoked by** | `/implement-azure` |
| **Inputs** | `integration-ir.yaml`, `contracts/schemas/*.json`, `mappings/<Name>.md` |
| **Outputs** | `FunctionApps/<Flow>/<Flow>.csproj`, `Program.cs`, `host.json`, `local.settings.json`, `Functions/<Flow>Function.cs`, `Functions/Activities/`, `Functions/Orchestrators/` (when `durablePattern` is set), `Models/`, `Mappings/`, `Helpers/` |
| **Tools** | read, edit, search |
| **Skills** | `azure-functions`, `eip-to-azure-mapping`, `batch-processing`, `no-stubs-code-generation` |

Emits a separately-hosted .NET 8 isolated-worker Function App with its own `host.json`, its own deploy lifecycle, and its own infra module. One project per flow, one trigger function per flow. Not the same as `azure-local-functions-author` (which emits in-process WebJobs DLLs that run inside the Logic Apps Standard host). Skipped when no flow routes to `function-app`.

---

### azure-data-factory-compiler

| | |
|---|---|
| **Purpose** | Compile each IR flow whose host is `data-factory` to Azure Data Factory artifacts (pipelines, datasets, linked services, triggers) |
| **Invoked by** | `/implement-azure` |
| **Inputs** | `integration-ir.yaml`, `contracts/schemas/*.json` |
| **Outputs** | `adf/pipelines/<Flow>.json`, `adf/datasets/`, `adf/linkedServices/`, `adf/triggers/`, `adf/dataflows/` (when transforms warrant Mapping Data Flow), `adf/integrationRuntimes/` (when Self-Hosted IR is required), `adf/factory/<factoryName>.json` |
| **Tools** | read, edit, search |
| **Skill** | `data-factory` |

ADF is the right target only when the flow is fundamentally bulk data movement / ETL (source-to-sink copy, schema-drift transformation, scheduled batch loads). Event-driven orchestrations and sub-second request/response flows belong elsewhere — `ir-validator` rejects `data-factory` for HTTP-triggered or sync-reply flows. Deployed via the factory module under `infra/`. Skipped when no flow routes to `data-factory`.

---

### azure-local-functions-author

| | |
|---|---|
| **Purpose** | Emit the .NET 8 in-process WebJobs SDK project that backs `InvokeFunction` actions in Logic Apps Standard workflows |
| **Invoked by** | `/implement-azure` |
| **Inputs** | `integration-ir.yaml`, the Logic Apps Standard workflows emitted by `azure-logic-apps-compiler` |
| **Outputs** | `Functions/<ProjectName>.csproj` (TFM `net8`, in-proc WebJobs SDK), `Functions/<FunctionName>.cs` per `InvokeFunction` target, `Functions/Models/*.cs`, `Functions/Helpers/*.cs` |
| **Tools** | read, edit, search |
| **Skills** | `dotnet-local-functions`, `no-stubs-code-generation` |

Sibling project to `app/`, NOT inside the logic-app folder. The csproj's post-build target publishes DLLs to `<integration-folder>/app/lib/custom/net8/`. Not the same as `azure-functions-compiler` (which emits stand-alone Function Apps). Skipped when the Logic Apps workflows contain no `InvokeFunction` actions.

---

### azure-connections-binder

| | |
|---|---|
| **Purpose** | Generate connection references, parameters, and project files |
| **Invoked by** | `/implement-azure` |
| **Inputs** | `integration-ir.yaml` |
| **Outputs** | `connections.json`, `parameters.json`, `appsettings.dev.json`, `appsettings.prod.json`, `local.settings.json`, `identity-role-assignments.json`, `.vscode/*` |
| **Tools** | read, edit, search |

Wires workflows to managed-identity connection references. Parameterizes per environment. Produces role assignment snippets for the Bicep author.

---

### azure-bicep-author

| | |
|---|---|
| **Purpose** | Write Bicep infrastructure modules |
| **Invoked by** | `/implement-azure` |
| **Inputs** | `integration-ir.yaml`, `identity-role-assignments.json` |
| **Outputs** | `infra/main.bicep`, `infra/modules/*.bicep`, `infra/parameters.*.bicepparam`, `infra/main.parameters.json`, `azure.yaml` |
| **Tools** | read, edit, search |
| **Templates** | `templates/azure/infra/` |

Composes Bicep modules for Logic App, Service Bus, Storage, Managed Identity, and Monitoring. Derives SKUs from `nonFunctionals`. Emits `azure.yaml` for azd. Also emits `infra/main.parameters.json` (required for the `azd provision` path — azd reads this, **not** the `.bicepparam` files, which are kept for direct `az deployment` use).

---

### azure-cicd-author

| | |
|---|---|
| **Purpose** | Write GitHub Actions CI/CD pipelines |
| **Invoked by** | `/implement-azure` |
| **Inputs** | `integration-ir.yaml`, `infra/`, `app/`, `tests-mstest/` |
| **Outputs** | `app/.github/workflows/deploy.yml`, `app/.github/workflows/pr-validate.yml` |
| **Tools** | read, edit, search |
| **Template** | `templates/azure/ci/github-actions-azd.yml` |

PR validation runs Spectral, ajv, `bicep build`, and `dotnet test`. Deploy uses OIDC federated credentials.

---

### azure-workflow-tester

| | |
|---|---|
| **Purpose** | Generate MSTest unit test scaffolds |
| **Invoked by** | `/implement-azure`, `/test-azure` |
| **Inputs** | `integration-ir.yaml`, `contracts/`, `app/<Flow>/workflow.json`, `app/connections.json` |
| **Outputs** | `tests-mstest/<Flow>.Tests/*.cs`, `tests-mstest/<Flow>.Tests/Mocks/`, `tests-mstest/<Flow>.Tests/fixtures/` |
| **Tools** | read, edit, search |

Uses the official Microsoft Logic Apps Standard unit testing SDK. Generates typed mock classes per action and fixture data from contract schemas.

---

### azure-reviewer

| | |
|---|---|
| **Purpose** | Audit Azure artifacts against the Well-Architected Framework |
| **Invoked by** | `/implement-azure` (post-generation) |
| **Inputs** | `app/`, `infra/`, `tests/`, `.github/workflows/`, `integration-ir.yaml` |
| **Outputs** | `azure-review.md` |
| **Tools** | read, edit, search |
| **Skills** | `eip-to-azure-mapping`, `logicapp-standard-layout` |

Checks reliability (retry, DLQ), security (secrets, identity), cost (SKU), operational excellence (diagnostics), and performance (sizing).

---

## BizTalk Pack Agents (5)

These reverse-engineer a BizTalk Server solution into the core pipeline's format, enabling migration to any target platform. They feed each other in sequence: `biztalk-msi-cracker` (when MSIs are present) → `biztalk-inventory` → `biztalk-spec-author` → `biztalk-contract-extractor` → `biztalk-ir-compiler`.

### biztalk-msi-cracker

| | |
|---|---|
| **Purpose** | Crack open BizTalk application MSIs (BTSTask `ExportApp` output) to recover compiled artifacts |
| **Invoked by** | `/biztalk-inventory`, `/biztalk-reverse-engineer` (conditional — runs only when `.msi` files are present) |
| **Inputs** | BizTalk MSI files under the solution folder |
| **Outputs** | `specs/biztalk/_extracted/<msi>/{maps,schemas,orchestrations,pipelines,bindings,policies,components,helpers}/`, `specs/biztalk/_extracted/_manifest.json` |
| **Tools** | read, edit, search, execute |

Performs an administrative install with `msiexec /a`, parses each MSI's `ApplicationDefinition.adf`, expands the embedded CABs, and reflects over every `BizTalkAssembly` DLL (Mono.Cecil or `MetadataLoadContext`) to recover compiled XSLT maps, XSD schemas, ODX orchestrations, BTP pipelines, BindingInfo.xml, BRE policies, and helper DLLs. Emits `_manifest.json` with per-XSLT flags (`usesInlineScript`, `usesDatabaseLookup`, `extensionNamespaces`, `containsEmbeddedSecrets`) and per-XSD flags (`hasFlatFileAnnotations`, `hasEdiAnnotations`, `rootElement`) that downstream agents read instead of re-reflecting. Skipped silently when no MSIs are present.

---

### biztalk-inventory

| | |
|---|---|
| **Purpose** | Catalog all artifacts in a BizTalk solution |
| **Invoked by** | `/biztalk-inventory`, `/biztalk-reverse-engineer` |
| **Inputs** | BizTalk solution folder |
| **Outputs** | `specs/biztalk/biztalk-inventory.md`, `specs/biztalk/integration-catalogue.md` |
| **Tools** | read, edit, search, execute |
| **Template** | `templates/biztalk/biztalk-inventory.md` |

Parses `.btproj` files, classifies artifacts (.odx, .btm, .xsd, .btp, .xml), assigns migration complexity scores, groups by integration boundary.

---

### biztalk-spec-author

| | |
|---|---|
| **Purpose** | Infer a spec.md from BizTalk artifacts |
| **Invoked by** | `/biztalk-reverse-engineer` |
| **Inputs** | `specs/biztalk/biztalk-inventory.md`, BizTalk source files |
| **Outputs** | `specs/biztalk/NNN-<slug>/spec.md` |
| **Tools** | read, edit, search |
| **Template** | `templates/biztalk/spec.md` |

Infers business intent from orchestrations, identifies actors from adapter configurations, drafts user stories and requirements. **Group scope:** when the run passes `group: INT-NNN` (from `/biztalk-reverse-engineer --group`), the slug derives from the catalogue group name, the spec covers only that group, and it records `- **Source group:** INT-NNN <Name>` in the front matter for the downstream agents to read.

---

### biztalk-contract-extractor

| | |
|---|---|
| **Purpose** | Convert BizTalk schemas and bindings to standard contracts |
| **Invoked by** | `/biztalk-reverse-engineer` |
| **Inputs** | `specs/biztalk/biztalk-inventory.md`, BizTalk `.xsd` files, binding `.xml` files |
| **Outputs** | `contracts/schemas/<Name>.json`, `contracts/openapi.yaml`, `contracts/asyncapi.yaml` |
| **Tools** | read, edit, search |
| **Templates** | `templates/biztalk/contracts/` |

XSD → JSON Schema conversion. HTTP/SOAP bindings → OpenAPI. Queue/topic/MQ bindings → AsyncAPI. Satisfies Article I for the reverse-engineering path. **Group scope:** reads the spec's `Source group: INT-NNN` line (or an explicit `group:`) and emits contracts for only that group's schemas and ports.

---

### biztalk-ir-compiler

| | |
|---|---|
| **Purpose** | Compile BizTalk artifacts to integration-ir.yaml |
| **Invoked by** | `/biztalk-reverse-engineer` |
| **Inputs** | `spec.md`, `contracts/`, `specs/biztalk/biztalk-inventory.md`, BizTalk source files |
| **Outputs** | `integration-ir.yaml`, `artifacts/custom/*` (extracted custom code), `mappings/<Name>.md` (one STM document per mapping, preserved-transform form) |
| **Tools** | read, edit, search |
| **Skills** | `ir-authoring`, `eip-patterns` |
| **Schema** | `schemas/integration-ir.schema.json` |
| **Template** | `templates/biztalk/integration-ir.yaml` |

Maps every BizTalk construct (orchestration shapes, maps, pipelines, bindings, BRE policies) to its IR equivalent using EIP patterns. Extracts custom code with `migrationHint` annotations. **Group scope:** reads the spec's `Source group: INT-NNN` line and emits channels/messages/flows/mappings for only that group, recording `group: INT-NNN` + `groupName` in the IR `source:` block.
