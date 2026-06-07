# Platform Pack Developer Guide

How to add support for a new target platform (e.g., MuleSoft, AWS Step Functions, SAP CPI) to Spec2Integration.

> **Note:** Spec2Integration uses Claude Code's native `.claude/agents/`, `.claude/commands/`, and `.claude/skills/` layout — there is no plugin manifest or marketplace. Adding a platform means dropping `<plat>-*` prefixed files into those folders. For format reference see the Claude Code [subagents](https://code.claude.com/docs/en/sub-agents.md) and [slash command](https://code.claude.com/docs/en/slash-commands.md) documentation.

---

## What is a Platform Pack?

A "platform pack" is the set of `<plat>-*` agents, commands, and skills that consume `integration-ir.yaml` + `contracts/` and emit deployable platform-specific artifacts. The core pipeline (the unprefixed agents) is platform-neutral; the prefixed agents are the translation layer.

**Reference packs already in the repo:**
- **Azure** (`azure-*`) — multi-host Azure target. Buckets each IR flow by `implementation.host` into Logic Apps Standard workflows, stand-alone .NET 8 Function App projects, or Data Factory artifacts, plus Bicep infrastructure, MSTest tests, and GitHub Actions CI/CD.
- **BizTalk** (`biztalk-*`) — reverse-engineers BizTalk solutions (MSI cracking + source inventory) into the core pipeline format. This is a source pack, not a target pack — it produces the IR rather than consuming it.

---

## Architecture

```
┌─────────────────────────────────────┐
│  Core agents  (unprefixed)           │
│  spec.md → data-model.md → contracts │
│  → mappings → integration-ir.yaml    │
└──────────────┬──────────────────────┘
               │ IR + contracts/
               ▼
┌─────────────────────────────────────┐
│  <plat>-* agents                     │
│  Reads: integration-ir.yaml,         │
│         contracts/                   │
│  Writes: deployable artifacts        │
└─────────────────────────────────────┘
```

Pack agents **never** read the PRD, `spec.md`, or `data-model.md` directly. They consume only the IR and contracts.

---

## File layout

A new platform pack adds files directly into the existing `.claude/` tree — no separate folder structure:

```
.claude/
  agents/
    <plat>-compiler.md                # IR flows → native workflow artifacts
    <plat>-connections-binder.md      # IR channels → native connections/bindings
    <plat>-infra-author.md            # IR non-functionals + deps → IaC
    <plat>-workflow-tester.md         # contracts + IR → native test harness
    <plat>-cicd-author.md             # → CI/CD pipeline
    <plat>-reviewer.md                # platform best-practice audit
  commands/
    implement-<plat>.md               # /implement-<plat>
    test-<plat>.md                    # /test-<plat>
    deploy-<plat>.md                  # /deploy-<plat>
  skills/
    eip-to-<plat>-mapping/
      SKILL.md                        # EIP → platform-native mapping table
    <plat>-layout/
      SKILL.md                        # File layout conventions (optional)

templates/<plat>/                     # Native template skeletons (optional)
```

There is no install step. As soon as the files are present, Claude Code auto-discovers them on the next restart.

---

## Step-by-step: adding a new platform

### 1. Choose your platform slug

Pick a short, lowercase slug (e.g., `mulesoft`, `sap-cpi`, `aws-step`). All agents, commands, and skills use this as their prefix.

### 2. Create the agents

Each agent lives at `.claude/agents/<plat>-<role>.md` with this frontmatter shape:

```yaml
---
name: <plat>-compiler
description: Compiles each flow in integration-ir.yaml to <Platform> native artifacts. Invoke from /implement-<plat>.
tools: Read, Edit, Write, Grep, Glob
model: inherit
---

You are the <Platform> Compiler. You translate each flow in integration-ir.yaml to a native <Platform> workflow artifact.

## Inputs
- `integration-ir.yaml`
- `contracts/` (schemas only — do NOT re-parse OpenAPI/AsyncAPI for transport detail)

## Outputs
- `<integration-folder>/<native artifact files>`

## Rules
- Use the `eip-to-<plat>-mapping` skill for every node type translation.
- Never read spec.md, data-model.md, or PRD.
- Honour `errorHandling` from the IR exactly — do not "improve" it.
- Compile `flows[].tracked[]` into platform-native observability.
- Compile `flows[].metrics[]` into custom metrics.
```

Required agents: **compiler**, **connections-binder**, **infra-author**, **workflow-tester**, **cicd-author**, **reviewer**. See the Azure agents for working reference:

- [.claude/agents/azure-logic-apps-compiler.md](../.claude/agents/azure-logic-apps-compiler.md)
- [.claude/agents/azure-connections-binder.md](../.claude/agents/azure-connections-binder.md)
- [.claude/agents/azure-bicep-author.md](../.claude/agents/azure-bicep-author.md)
- [.claude/agents/azure-workflow-tester.md](../.claude/agents/azure-workflow-tester.md)
- [.claude/agents/azure-cicd-author.md](../.claude/agents/azure-cicd-author.md)
- [.claude/agents/azure-reviewer.md](../.claude/agents/azure-reviewer.md)

### 3. Create the EIP mapping skill

This is the core intellectual work. `.claude/skills/eip-to-<plat>-mapping/SKILL.md`:

```markdown
---
name: eip-to-<plat>-mapping
description: Mapping from IR node types and channel kinds to <Platform> constructs. Use when compiling integration-ir.yaml to <Platform> native artifacts.
---

# EIP to <Platform> Mapping

## Node types

| IR type | <Platform> construct | Notes |
|---------|----------------------|-------|
| receive | … | |
| transform | … | |
| enrich | … | |
| filter | … | |
| router | … | |
| recipientList | … | |
| splitter | … | |
| aggregator | … | |
| scatterGather | … | |
| send | … | |
| invoke | … | |
| claimCheck | … | |
| wireTap | … | |
| throttler | … | |
| saga | … | |
| resequencer | … | |

## Channel kinds

| IR kind | <Platform> resource | Auth |
|---------|---------------------|------|
| http | … | |
| queue | … | |
| topic | … | |
| blob | … | |
| timer | … | |
| eventgrid | … | |

## Mapping engines

| Engine | <Platform> equivalent |
|--------|-----------------------|
| jsonata | … |
| xslt | … |
| liquid | … |

## Retry policy mapping

| IR policy | <Platform> config |
|-----------|-------------------|
| fixed | … |
| exponential | … |

## Correlation id propagation

(Platform-specific snippet showing how `correlationId` flows through)

## Secret and parameter references

(How secret-store references in the IR resolve to platform-native constructs)
```

### 4. Create the commands

Each command lives at `.claude/commands/<verb>-<plat>.md`:

```yaml
---
description: [Manual] Generate <Platform> artifacts from the IR.
argument-hint: [spec-folder]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---

Run the `/implement-<plat>` orchestration:

1. Verify prerequisites — `integration-ir.yaml` exists and validates, `contracts/` exists, `tasks.md` exists, and `.spec2integration/state.json` records `activePlatform: <plat>`.
2. Invoke the `<plat>-compiler` agent via the `Agent` tool with `subagent_type: <plat>-compiler` on each flow.
3. Invoke `<plat>-connections-binder` similarly.
4. Invoke `<plat>-infra-author`.
5. Invoke `<plat>-workflow-tester`.
6. Invoke `<plat>-cicd-author`.
7. Invoke `<plat>-reviewer` and surface any Sev-1 findings.
8. Refresh `<folder>/status.json` per [.claude/skills/pipeline-status/SKILL.md](../.claude/skills/pipeline-status/SKILL.md).
```

Create matching commands for `/test-<plat>` and `/deploy-<plat>`.

### 5. Add templates (optional)

If your compiler needs skeleton files, add them under `templates/<plat>/`.

### 6. Register the platform

`/platform <plat>` writes `.spec2integration/state.json` with `{ "activePlatform": "<plat>" }`. That is the only registration step — no plugin manifest, no `enabledPlugins` entry.

---

## Contract obligations

Every pack must follow these rules (all Sev-1 unless noted):

| Rule | Article |
|------|---------|
| Consume only `integration-ir.yaml` and `contracts/` — never PRD, spec, data-model. | II |
| Never mutate core artifacts. | IX |
| No secrets in generated files. | V |
| Emit structured logs, correlation-id propagation, and traces by default. | IV |
| Honour `errorHandling` exactly as declared in the IR. | VI |
| Read transport detail from IR `endpoints[]` and `channels[].binding`, not by re-parsing OpenAPI/AsyncAPI. (Sev-2) | II |
| Resolve OAuth2 `clientSecretRef` via platform secret-store API. | V |
| Generate at least one unit test per flow. (Sev-2) | VII |
| `/test-flows` (core) must remain runnable without the pack present. (Sev-2) | — |

---

## Agent naming

- All pack agents **must** be prefixed with `<plat>-` to avoid collisions with core agents or other packs.
- Core agents are **never** prefixed.
- Use kebab-case for agent filenames; the `name` frontmatter field must match the filename minus `.md`.
- This naming convention is the only namespacing — there are no plugin boundaries.

---

## Verification checklist

Before merging a new platform:

- [ ] `npx -y ajv-cli validate -s schemas/integration-ir.schema.json -d <example-ir>` passes.
- [ ] `/implement-<plat>` produces a project that builds in its native toolchain.
- [ ] At least one unit test per flow exists and passes.
- [ ] `<plat>-reviewer` returns zero Sev-1 findings on a worked example.
- [ ] The worked example's IR contains at least one OAuth2 `auth` channel, and the pack binds it correctly.
- [ ] EIP mapping skill covers all 16 node types and all 6 channel kinds.
- [ ] Agents and commands appear in `/` palette after a Claude Code restart (no settings.json changes required).

---

## Reference: Azure pack

The Azure pack is the reference implementation. Study these files:

| File | Purpose |
|------|---------|
| [.claude/agents/azure-logic-apps-compiler.md](../.claude/agents/azure-logic-apps-compiler.md) | Logic Apps Standard compiler (`implementation.host: logic-app-standard`) |
| [.claude/agents/azure-functions-compiler.md](../.claude/agents/azure-functions-compiler.md) | Stand-alone Function App compiler (`implementation.host: function-app`) |
| [.claude/agents/azure-data-factory-compiler.md](../.claude/agents/azure-data-factory-compiler.md) | Data Factory compiler (`implementation.host: data-factory`) |
| [.claude/agents/azure-local-functions-author.md](../.claude/agents/azure-local-functions-author.md) | In-process WebJobs SDK project for Logic Apps `InvokeFunction` targets |
| [.claude/agents/azure-connections-binder.md](../.claude/agents/azure-connections-binder.md) | Connections binder |
| [.claude/agents/azure-bicep-author.md](../.claude/agents/azure-bicep-author.md) | IaC author |
| [.claude/agents/azure-workflow-tester.md](../.claude/agents/azure-workflow-tester.md) | Test generator |
| [.claude/agents/azure-cicd-author.md](../.claude/agents/azure-cicd-author.md) | CI/CD pipeline |
| [.claude/agents/azure-reviewer.md](../.claude/agents/azure-reviewer.md) | Platform reviewer |
| [.claude/skills/eip-to-azure-mapping/SKILL.md](../.claude/skills/eip-to-azure-mapping/SKILL.md) | EIP mapping skill |
| [.claude/skills/logicapp-standard-layout/SKILL.md](../.claude/skills/logicapp-standard-layout/SKILL.md) | Layout conventions |
| [.claude/commands/implement-azure.md](../.claude/commands/implement-azure.md) | Implementation command (multi-host orchestrator) |
| [templates/azure/](../templates/azure/) | Template skeletons |
