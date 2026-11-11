# Spec2Integration — Claude Code Project Guide

A spec-driven integration pipeline. Converts a PRD into a fully deployed integration solution through a strict sequence of agents and slash commands.

## Layout

All agents, commands, and skills live directly under `.claude/`, which Claude Code auto-loads from the project root — no plugin or marketplace registration required.

| Tree | Contents |
|---|---|
| [.claude/agents/](.claude/agents/) | 38 agents grouped by prefix: unprefixed (core, platform-neutral), `biztalk-*` (BizTalk reverse engineering), `azure-*` (Azure target platform). |
| [.claude/commands/](.claude/commands/) | 32 slash commands. |
| [.claude/skills/](.claude/skills/) | 37 skills covering EIP patterns, IR authoring, platform-specific layouts and decision tables. |

The naming convention is the only grouping — there are no plugin boundaries. New platform support (AWS, MuleSoft, etc.) is added by dropping `<plat>-*` agents, commands, and skills directly into the same folders. See [docs/platform-pack-guide.md](docs/platform-pack-guide.md).

For the rationale behind splitting work across agents, skills, and commands — and how that split maps to current Claude Code best practice — see [docs/architecture-review-skills-agents.md](docs/architecture-review-skills-agents.md).

## Pipeline overview

```
PRD                       → /specify          → spec.md
spec.md (open questions)  → /clarify          → clarifications.md  (loop until closed)
spec.md                   → /model            → data-model.md
data-model.md             → /contracts        → contracts/
contracts/                → /map              → mappings/
mappings/                 → /architect        → integration-ir.yaml
integration-ir.yaml       → /test-mappings    → mapping-test-report.json   (optional)
integration-ir.yaml       → /test-flows       → flow-test-report.json      (optional)
all of the above          → /review           → review-report.md
review PASS               → /plan             → plan.md
plan.md                   → /tasks            → tasks.md
tasks.md                  → /implement-azure  → deployable artifacts
```

After any source-of-truth edit (spec.md, data-model.md, contracts/, mappings/, integration-ir.yaml, plan.md, tasks.md), run `/status <folder>` to see which downstream stages are now stale, then `/run-pipeline --folder <folder>` to resume from the first stale stage. See the **Staleness** section of [.claude/skills/pipeline-status/SKILL.md](.claude/skills/pipeline-status/SKILL.md) for the dependency map.

For BizTalk migration the entry point is different:

```
.msi → /biztalk-inventory → inventory.md → /biztalk-reverse-engineer
  → spec.md + contracts/ + integration-ir.yaml (then continues as above from /plan)
```

## How to use

Type `/` to see the slash-command surface. Commands fall into five intents:

- **Guided** — orchestrate multiple stages: [`/run-pipeline`](.claude/commands/run-pipeline.md), [`/prepare-for-implementation`](.claude/commands/prepare-for-implementation.md), [`/biztalk-reverse-engineer`](.claude/commands/biztalk-reverse-engineer.md). Start here.
- **Manual** — advance one stage at a time: `/specify`, `/clarify`, `/model`, `/contracts`, `/map`, `/architect`, `/plan`, `/tasks`, `/implement-azure`, `/deploy-azure`.
- **Reporting** — explain current state without advancing: `/next`, `/status`, `/visualize`, `/ir-diff`, `/drift-check`, `/analyze`, `/reconcile`, `/idd`, `/use`.
- **Recovery** — unblock a failed stage: `/review`, `/platform`, `/test-mappings`, `/test-flows`, `/test-azure`.
- **Maintenance** — change a *deployed* integration without regenerating it: `/change` (targeted delta via the right platform agent), `/lifecycle` (freeze/unfreeze the folder so generative commands can't overwrite live artifacts). See **Lifecycle / maintenance phase** below.
- **Advanced** — specialist utilities: `/domain`.

Default opening moves:

1. Prefer `/run-pipeline` for end-to-end execution.
2. Use `/prepare-for-implementation` when an IR already exists.
3. Ask `/next` for the shortest possible answer to "what should I do now?"
4. Ask `/status` when you want the full stage table.
5. Run `/use <folder>` once to pin the **active integration** — afterwards `/map`, `/review`, `/plan`, `/next`, … default to it, so you can drop the folder argument. Any command you run with an explicit folder also pins it. See the **Resolving the integration folder** section of [.claude/skills/pipeline-status/SKILL.md](.claude/skills/pipeline-status/SKILL.md).

## Agents

Agents are invoked exclusively via the `Agent` tool with `subagent_type: <agent-name>`. Slash commands call them; you should not need to call them directly. All 38 live in [.claude/agents/](.claude/agents/), namespaced by prefix:

| Prefix | Agents |
|---|---|
| (none) — core, platform-neutral | clarifier, contract-designer, contract-linter, domain-architect, domain-modeler, flow-tester, integration-architect, ir-validator, mapping-designer, mapping-tester, pii-flow-checker, planner, prd-author, requirements-analyst, reviewer, secret-scanner, solution-design-author, spec-coverage-checker, stm-drift-checker, target-architecture, task-decomposer |
| `biztalk-` — brownfield intake | biztalk-contract-extractor, biztalk-inventory, biztalk-ir-compiler, biztalk-msi-cracker, biztalk-spec-author |
| `azure-` — Azure target platform | azure-bicep-author, azure-cicd-author, azure-connections-binder, azure-data-factory-compiler, azure-dataverse-binder, azure-functions-compiler, azure-local-functions-author, azure-logic-apps-compiler, azure-reviewer, azure-spec-code-reconciler, azure-sql-schema-author, azure-workflow-tester |

### Skill preloading

Reference-heavy compilers (`azure-logic-apps-compiler`, `azure-connections-binder`, `azure-bicep-author`, `azure-functions-compiler`, `azure-dataverse-binder`, `azure-workflow-tester`, and the `biztalk-*` compilers) declare their **always-needed authoritative skills** in a `skills:` frontmatter list. Those skills' `SKILL.md` instructions are injected into the agent's context at startup — making the load **deterministic** rather than dependent on the model choosing to read them, which directly hardens failure modes like emitting a guessed `operationId`/`serviceProviderId`. The bundled `reference/` files inside each skill still load on demand. Only always-needed skills are preloaded; per-channel / per-format / per-host skills (e.g. `edi-x12`, `service-bus`, `biztalk-decompilation`) remain listed in the agent's `## Inputs` prose and are read on demand when the relevant condition applies.

## Status refresh contract

`<folder>/status.json` is derived state with **one writer**: [scripts/refresh-status.ps1](scripts/refresh-status.ps1). It computes every stage row from disk: whether each stage's artifact exists, and the verdict recorded in its report file (`review-report.json`, `ir-validation-report.json`, the test reports, `azure-review.md`, `implement-gates.json`, …). It also computes mtime-based staleness and `next`. The full contract, including which file drives each stage, is in [.claude/skills/pipeline-status/SKILL.md](.claude/skills/pipeline-status/SKILL.md).

- **Agents never write `status.json`.** They write their artifact and, where they have a verdict, their report file. An outcome with no report file gets a report file the script reads, not a hand-written stage row.
- **Commands never write stage rows.** A command with Bash/PowerShell runs `scripts/refresh-status.ps1 -Folder <folder> -RefreshedBy /<command>` as its last step. A command without it relies on the hook.
- **The hook.** A `PostToolUse` hook on `Write|Edit` (the `hooks` block of [.claude/settings.json](.claude/settings.json)) runs the script after any edit inside an integration folder, tagged `refreshedBy: auto:postwrite-hook`. It cannot see Bash/script edits, edits made outside Claude Code, or CI; run `/status <folder>` after those. Hook settings are read when a session starts, so restart after changing them.
- **Preserved keys.** A few keys cannot be derived from disk. The script carries them forward, and only their owner changes them: `artifactHashes` / `lastImplement` (`/implement-azure`, `/change`), `lifecycle` and `stages[].frozen` (`/lifecycle`).

## Lifecycle / maintenance phase

The pipeline is excellent at **greenfield generation** — PRD to deployed artifacts in one forward pass. But an integration does not stay in that phase. Once its platform artifacts are deployed and validated, the generated files (ADF JSON, `workflow.json`, SQL, Bicep, connections) become the **source of truth**, and the spec/IR/contracts become *reference documents* that describe intent, not the current code. Re-running a generative command then silently overwrites live, validated work — the highest-severity failure mode this framework has.

That phase is now a **first-class, enforced concept**, not a prose warning in a solution's `CLAUDE.md`:

- **Freeze model.** `status.json` carries a top-level `lifecycle` (`generate` → `post-implementation`) and a per-stage `frozen` flag. Set them with [`/lifecycle freeze <folder>`](.claude/commands/lifecycle.md) once an integration is deployed. See [.claude/skills/lifecycle-guard/SKILL.md](.claude/skills/lifecycle-guard/SKILL.md).
- **Guarded commands.** `/specify`, `/model`, `/contracts`, `/map`, `/architect`, `/implement-azure`, `/run-pipeline`, and `/prepare-for-implementation` run the lifecycle guard after resolving the folder: on a frozen integration they **refuse** and print a redirect to `/change`, unless the deliberate `--force-regen` override is passed.
- **Targeted edits.** [`/change "<description>" <folder>`](.claude/commands/change.md) is the maintenance path: it reads the specific deployed artifact, routes the change to the agent that owns that format (`azure-data-factory-compiler`, `azure-sql-schema-author`, `azure-bicep-author`, `azure-cicd-author`, `azure-connections-binder`, `azure-dataverse-binder`, …), makes the minimal edit, runs the same artifact gates as `/implement-azure` (`scripts/check-azure-artifacts.ps1 -Build -Test`), records a `DD-NN` entry in `decisions.md`, and re-baselines `artifactHashes` so `/drift-check` stays honest. If the gates fail it stops without recording the decision or re-baselining the hashes. It never regenerates sibling artifacts.
- **Consistency & docs.** [`/analyze`](.claude/commands/analyze.md) emits one read-only cross-artifact conflict report (uncovered requirements, orphan tasks, spec↔code divergence, drift, staleness). [`/reconcile`](.claude/commands/reconcile.md) is the spec↔code part on its own: what the IR declares but no artifact implements, what is deployed but no IR construct accounts for, and transforms whose equivalence can't be confirmed — advisory, Sev-3 only. [`/idd`](.claude/commands/idd.md) renders the IR + contracts + `decisions.md` into a client-facing Solution Design Document that never drifts by hand.

The `lifecycle` and `frozen` fields are per-integration **derived control state** in `status.json` (alongside `artifactHashes`/`lastImplement`), so they do not violate Article VIII. Every refresh preserves them; only `/lifecycle` changes them.

## Tool usage

- Use `Read` and `Glob` to understand existing files before any edit.
- Use `Grep` to locate patterns across the workspace.
- Use `Bash` / `PowerShell` sparingly — only for validation commands (`ajv`, `spectral`, `dotnet test`) and small scripts.
- Use the `Agent` tool to delegate to subagents; never duplicate an agent's logic inline.

## Repository layout

```
spec2integration/
├── CLAUDE.md                    # this file
├── .claude/
│   ├── settings.json            # permissions + hooks
│   ├── agents/                  # 38 agents (core, biztalk-*, azure-*)
│   ├── commands/                # 32 slash commands
│   └── skills/                  # 37 skills
├── schemas/                     # IR and domain JSON Schemas (see schemas/CLAUDE.md)
├── templates/                   # skeleton artifacts (see templates/CLAUDE.md)
├── src/pipeline/FlowTester/     # .NET 8 deterministic flow-test runner
├── tools/                       # UIs: pipeline-runner, vscode-extension (hosts the IR visualizer)
├── scripts/                     # helper scripts (status refresh, catalog build, Azure artifact gate)
├── docs/                        # architecture and reference docs
└── .spec2integration/           # mutable pipeline state (state.json)
```

---

# Spec2Integration Constitution

Non-negotiable principles for every integration produced by this pipeline. The `reviewer` agent audits every artifact against this section. The `planner` agent refuses to proceed while any Sev-1 violation is open.

## Article I — Contract-first

No flow may be designed, planned, or implemented before its synchronous contracts (OpenAPI) and asynchronous contracts (AsyncAPI + JSON Schemas) exist under `contracts/`.

## Article II — IR-first

No platform-specific file may be produced before `integration-ir.yaml` exists and validates against `schemas/integration-ir.schema.json`. Platform packs consume only the IR and `contracts/`; they do not read the PRD, spec.md, or data-model.md.

## Article II-a — Mappings are platform-neutral

Every source→destination transformation must be expressed in the IR's `mappings[]` block using a portable engine (JSONata by default; `xslt`, `liquid`, `jslt`, or `expression` only when the format or an explicit team decision requires it). Platform-specific transform syntax (Logic Apps `@...`, MuleSoft DataWeave `%dw`, etc.) is forbidden inside the IR — that is the pack's translation target, not the pack's input. Leaving a transform as a symbolic name (`transform: <Name>`) with no matching `mappings[].name` entry is a Sev-1 violation.

## Article III — Idempotency

Every consumer of an external message must be idempotent. The IR must declare the idempotency key (business key or explicit header). Non-idempotent consumers are a Sev-1 violation.

## Article IV — Observability

Every flow must:
- propagate a correlation id end-to-end,
- emit structured logs at start, end, and each outbound call,
- emit distributed traces (W3C traceparent).

## Article V — Least-privilege identity and data handling

**(a) Least-privilege identity.** No shared secrets in generated files. All platform bindings use managed identity (system- or user-assigned). Role assignments must be the narrowest scope that works. API keys are allowed only for third-party dependencies that don't support OAuth/MI, and only via a secret store reference (never inline).

**(b) Data classification and retention.** Every channel crossing a trust boundary declares a `classification` (one of `public | internal | confidential | restricted`) on either the channel or its bound message; the stricter of the two wins. Fields that carry personally-identifiable information declare `pii: true` on the message or on individual `mappingRule` entries. A `pii: true` field emitted onto a `classification: public` channel without `redact: hash | mask | drop` is a Sev-1 violation (enforced by `pii-flow-checker`).

**(c) Retention.** Any PRD clause requiring messages to be retained for a fixed period must map to a `retention:` duration on the bound channel. A missing `retention` when the PRD mandates one is a Sev-2 violation.

## Article VI — Retries and DLQ

Every external hop has an explicit retry policy and DLQ declared in the IR. Missing `errorHandling.retry` or `errorHandling.dlq` is a Sev-1 violation.

## Article VII — Tests before implementation

`tasks.md` must order unit tests before the implementation they verify. Platform packs that generate implementation files without a paired test file are a Sev-2 violation.

## Article VIII — No hidden state

The only mutable pipeline state is `.spec2integration/state.json` (records the active platform pack and the `activeIntegration` convenience pointer — the folder commands default to when you omit the path). Neither affects generated artifacts. Agents do not stash state elsewhere.

## Article IX — One agent, one artifact

Each core agent produces exactly one primary artifact. Cross-artifact edits are performed by `reviewer` and logged in `review-report.md`.

## Phase gates

The `planner` agent will not produce `plan.md` unless:

1. `spec.md` exists and `clarifier` has either produced `clarifications.md` or explicitly recorded "no open clarifications".
2. `data-model.md` exists.
3. `contracts/openapi.yaml`, `contracts/asyncapi.yaml`, and the referenced JSON Schemas exist.
4. `integration-ir.yaml` exists, contains a populated `mappings:` block, and validates against `schemas/integration-ir.schema.json`.
5. A `mappings/<Name>.md` STM document exists for every entry in `mappings[]` and matches a fresh generation.
6. `spec-coverage-checker` reports zero Sev-1 `FR_NOT_SATISFIED` findings — every `MUST` clause in `spec.md` is satisfied by an IR construct, and every IR construct traces back to a requirement.
7. `.spec2integration/state.json` records an installed platform pack.
8. `reviewer` reports zero Sev-1 violations against this constitution.

Platform pack commands (`/implement-azure`, `/test-azure`, `/deploy-azure`) will not run until steps 1-7 above have passed and `tasks.md` exists.

## Severity

- **Sev-1** — hard blocks progression. Constitutional violations. `/plan` and `/implement-azure` will not run while any Sev-1 is open.
- **Sev-2** — soft blocks. Must be fixed before merge. A per-run override token `--allow-sev2` passed to `/review` allows progression while the finding is tracked. Quality violations (e.g. tests after impl, STM drift).
- **Sev-3** — advisory. Findings are listed in the report but do not change the verdict and do not block any command. Naming, style, doc-quality observations.
