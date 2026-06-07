# Spec2Integration — Claude Code Project Guide

A spec-driven integration pipeline. Converts a PRD into a fully deployed integration solution through a strict sequence of agents and slash commands.

## Layout

All agents, commands, and skills live directly under `.claude/`, which Claude Code auto-loads from the project root — no plugin or marketplace registration required.

| Tree | Contents |
|---|---|
| [.claude/agents/](.claude/agents/) | 34 agents grouped by prefix: unprefixed (core, platform-neutral), `biztalk-*` (BizTalk reverse engineering), `azure-*` (Azure target platform). |
| [.claude/commands/](.claude/commands/) | 27 slash commands. |
| [.claude/skills/](.claude/skills/) | 34 skills covering EIP patterns, IR authoring, platform-specific layouts and decision tables. |

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
- **Reporting** — explain current state without advancing: `/next`, `/status`, `/visualize`, `/ir-diff`, `/drift-check`, `/use`.
- **Recovery** — unblock a failed stage: `/review`, `/platform`, `/test-mappings`, `/test-flows`, `/test-azure`.
- **Advanced** — specialist utilities: `/domain`.

Default opening moves:

1. Prefer `/run-pipeline` for end-to-end execution.
2. Use `/prepare-for-implementation` when an IR already exists.
3. Ask `/next` for the shortest possible answer to "what should I do now?"
4. Ask `/status` when you want the full stage table.
5. Run `/use <folder>` once to pin the **active integration** — afterwards `/map`, `/review`, `/plan`, `/next`, … default to it, so you can drop the folder argument. Any command you run with an explicit folder also pins it. See the **Resolving the integration folder** section of [.claude/skills/pipeline-status/SKILL.md](.claude/skills/pipeline-status/SKILL.md).

## Agents

Agents are invoked exclusively via the `Agent` tool with `subagent_type: <agent-name>`. Slash commands call them; you should not need to call them directly. All 34 live in [.claude/agents/](.claude/agents/), namespaced by prefix:

| Prefix | Agents |
|---|---|
| (none) — core, platform-neutral | clarifier, contract-designer, contract-linter, domain-architect, domain-modeler, flow-tester, integration-architect, ir-validator, mapping-designer, mapping-tester, pii-flow-checker, planner, prd-author, requirements-analyst, reviewer, secret-scanner, spec-coverage-checker, stm-drift-checker, target-architecture, task-decomposer |
| `biztalk-` — brownfield intake | biztalk-contract-extractor, biztalk-inventory, biztalk-ir-compiler, biztalk-msi-cracker, biztalk-spec-author |
| `azure-` — Azure target platform | azure-bicep-author, azure-cicd-author, azure-connections-binder, azure-data-factory-compiler, azure-functions-compiler, azure-local-functions-author, azure-logic-apps-compiler, azure-reviewer, azure-workflow-tester |

### Skill preloading

Reference-heavy compilers (`azure-logic-apps-compiler`, `azure-connections-binder`, `azure-bicep-author`, `azure-functions-compiler`, `azure-workflow-tester`, and the `biztalk-*` compilers) declare their **always-needed authoritative skills** in a `skills:` frontmatter list. Those skills' `SKILL.md` instructions are injected into the agent's context at startup — making the load **deterministic** rather than dependent on the model choosing to read them, which directly hardens failure modes like emitting a guessed `operationId`/`serviceProviderId`. The bundled `reference/` files inside each skill still load on demand. Only always-needed skills are preloaded; per-channel / per-format / per-host skills (e.g. `edi-x12`, `service-bus`, `biztalk-decompilation`) remain listed in the agent's `## Inputs` prose and are read on demand when the relevant condition applies.

## Status refresh contract

Every agent that produces or modifies a primary artifact under `specs/**/NNN-<slug>/` MUST, as its **final step**, update the relevant stage(s) in `<folder>/status.json` per the [`pipeline-status`](.claude/skills/pipeline-status/SKILL.md) skill. This is the agent's responsibility, not the slash command's — the agent is the only thing that knows with certainty what it produced and whether it succeeded.

Agents that must refresh `status.json`:

| Agent | Stage(s) it owns |
|---|---|
| `biztalk-spec-author` | 1 (Spec) |
| `clarifier` | 1a (Clarifications) |
| `domain-modeler` | 2 (Data model) |
| `biztalk-contract-extractor`, `contract-designer`, `contract-linter` | 3 (Contracts), 3a (Contracts lint) |
| `mapping-designer` | 4 (Mappings STM) |
| `biztalk-ir-compiler`, `integration-architect` | 5 (IR) |
| `ir-validator` | 5a (IR validation) |
| `stm-drift-checker` | 5b (STM drift) |
| `secret-scanner` | 5c (Secret scan) |
| `pii-flow-checker` | 5d (PII flow) |
| `reviewer` | 5e (Review) |
| `mapping-tester` | 6 (Mapping tests) |
| `flow-tester` | 6a (Flow tests) |
| `planner` | 8 (Plan) |
| `task-decomposer` | 9 (Tasks) |
| `azure-logic-apps-compiler`, `azure-functions-compiler`, `azure-data-factory-compiler`, `azure-connections-binder`, `azure-bicep-author`, `azure-local-functions-author`, `azure-cicd-author` | 10 (Implement) |
| `azure-workflow-tester` | 11 (Tests) |

**How to update:** read the existing `status.json`, merge only the stage rows this agent owns (preserving all other keys including `artifactHashes` and `lastImplement`), and write it back. Never overwrite the full file from scratch unless the file doesn't exist yet.

**Exception — always re-probe state.json-derived stages.** Stage 7 (Platform pack) is owned by no artifact-producing agent; it is a pure function of `.spec2integration/state.json`. On every refresh (whether a full `/status` rebuild or a per-agent merge), recompute stage 7 from `state.json` (`done` when `activePlatform` is non-null, else `missing`) rather than preserving the prior row. Otherwise a run that reuses an already-active pack — without re-running `/platform`, the only command that owns stage 7 — carries a stale `missing` placeholder forward indefinitely, even though the done-criterion has been satisfied the whole time. (Phase gate 7 in the constitution reads `state.json` directly, so this never blocks `/plan`; the stale row is cosmetic but misleading.)

The orchestrating slash command may do a final full `/status`-style re-probe after all agents complete, but it is no longer the primary owner. Read-only commands (`/status`, `/ir-diff`, `/visualize`, `/drift-check`) are exempt. `/status` remains the on-demand full rebuild.

A `PostToolUse` hook (`Write|Edit`) backs this up automatically — `scripts/refresh-status.ps1`, wired in the `hooks` block of `.claude/settings.json`, rebuilds `status.json` after any edit inside an integration folder (tagged `refreshedBy: auto:postwrite-hook`). The hook also computes **mtime-based staleness**: because it runs on every edit with full filesystem access, it is the always-on staleness probe the Bash-less slash commands can't run — editing an upstream artifact flips its downstream stages to `stale` and repoints `next` at the rebuild, surfaced on the next `/next`, `/status`, or visualizer read without a manual probe. Slash commands still perform the authoritative refresh with their own name as the final step; the hook is the safety net. To opt out, remove the `hooks` block from `.claude/settings.json`.

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
│   ├── agents/                  # 34 agents (core, biztalk-*, azure-*)
│   ├── commands/                # 27 slash commands
│   └── skills/                  # 34 skills
├── schemas/                     # IR and domain JSON Schemas (see schemas/CLAUDE.md)
├── templates/                   # skeleton artifacts (see templates/CLAUDE.md)
├── src/pipeline/FlowTester/     # .NET 8 deterministic flow-test runner
├── tools/                       # UIs: pipeline-runner, vscode-extension (hosts the IR visualizer)
├── scripts/                     # helper scripts (status refresh, catalog build)
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
