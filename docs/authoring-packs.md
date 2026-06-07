# Authoring a Platform Pack

A "platform pack" is the set of `<plat>-*` prefixed agents, commands, and skills under [.claude/](../.claude/) that consume `integration-ir.yaml` + `contracts/` and emit deployable platform artifacts.

Platform packs live behind the same user-facing command taxonomy as the core pipeline:

- `Guided` commands orchestrate multiple stages and should be used sparingly for pack-specific convenience flows.
- `Manual` commands usually own the primary pack lifecycle: `/implement-<plat>` and `/deploy-<plat>`.
- `Recovery` commands usually cover validation and unblock loops such as `/test-<plat>`.
- `Reporting` commands are optional read-only helpers when a pack needs extra diagnostics.

When you add a new pack, its command `description` should use the same role prefixes as the core surface so the `/` command palette stays consistent.

> See [platform-pack-guide.md](platform-pack-guide.md) for the full step-by-step authoring guide. This file is a quick reference on the contract every pack must honour.

## Scaffolding a new pack

A ready-to-fork scaffold lives at `templates/platform-pack/`. It contains stub `<plat>-*` agents, commands, and an `eip-to-<plat>-mapping` skill skeleton — drop these into [.claude/agents/](../.claude/agents/), [.claude/commands/](../.claude/commands/), and [.claude/skills/](../.claude/skills/) and replace the `<plat>` placeholders.

**Steps to scaffold:**

1. Pick a short, lowercase platform slug (e.g. `mulesoft`, `aws-step`, `sap-cpi`).
2. Copy each file from `templates/platform-pack/agents/PLAT-*.md` into `.claude/agents/`, renaming to `<plat>-<role>.md` and updating the `name:` frontmatter to match.
3. Copy each file from `templates/platform-pack/commands/*-PLAT.md` into `.claude/commands/`, renaming to `<verb>-<plat>.md`.
4. Copy `templates/platform-pack/skills/eip-to-PLAT-mapping/` into `.claude/skills/eip-to-<plat>-mapping/` and update its `name:` frontmatter.
5. Replace every `<plat>` and `<Platform Name>` placeholder in all file contents.
6. Fill in the EIP `SKILL.md` mapping table — this is the core intellectual work.
7. Supply any native templates the compiler needs under `templates/<plat>/`.
8. Restart Claude Code. No `.claude/settings.json` change is required — Claude Code auto-loads everything in `.claude/agents/`, `.claude/commands/`, and `.claude/skills/`.
9. Run the verification checklist below.

## EIP mapping skill schema

`.claude/skills/eip-to-<plat>-mapping/SKILL.md` must contain, at minimum:

- A **Node types** table mapping every IR `type` to a native construct.
- A **Channel kinds** table mapping every IR `kind` to a native resource and auth approach.
- A **Mapping engines** table for each supported `engine` value (`jsonata`, `xslt`, `liquid`, etc.).
- A **Retry policy mapping** table.
- A **Correlation id propagation** section with a concrete code snippet.
- A **Secret and parameter references** section explaining how store references are resolved.

The scaffold's `SKILL.md` has all required headings pre-populated with `<!-- TODO -->` placeholders.

## Naming and frontmatter rules

**Agent files** (`.claude/agents/<plat>-<role>.md`):

```yaml
---
name: <plat>-<role>
description: <when/why Claude should delegate to this agent>
tools: Read, Edit, Write, Grep, Glob
model: inherit
---
```

- `name` MUST match the filename minus `.md`.
- Required roles: `<plat>-compiler`, `<plat>-connections-binder`, `<plat>-infra-author`, `<plat>-workflow-tester`, `<plat>-cicd-author`, `<plat>-reviewer`.
- Pack agents MUST be prefixed `<plat>-` to avoid collisions with core agents or other packs. This naming convention is the only namespacing — there are no plugin boundaries.

**Command files** (`.claude/commands/<verb>-<plat>.md`):

```yaml
---
description: [Manual] <one-line summary, prefixed with category>
argument-hint: [spec-folder]
allowed-tools: Read, Edit, Write, Grep, Glob, Agent
---
```

- Required commands: `implement-<plat>`, `test-<plat>`, `deploy-<plat>`.
- Recommended description prefixes: `[Manual]` for implement and deploy, `[Recovery]` for test.
- Only introduce a pack-specific guided command when there is a real multi-step user journey to collapse, similar to `/prepare-for-implementation`.

## Contract obligations

- Do not read the PRD, spec.md, or data-model.md directly. Consume only `integration-ir.yaml` and `contracts/`.
- Do not mutate any core artifact.
- Do not introduce secrets in generated files.
- Emit observability (structured logs, correlation-id propagation, traces) by default. Compile `flows[].tracked[]` into the platform's native tracked/span-attribute API; compile `flows[].metrics[]` into custom metrics; honour `flows[].logSampling`.
- Honour `errorHandling` in the IR; do not silently "improve" it.
- **IR is authoritative over contracts (Phase 8).** Packs consume transport detail (HTTP method, path, request/response schemas, rate limits, CORS, AsyncAPI bindings) from the IR's `endpoints[]` and `channels[].binding` blocks — never by re-parsing OpenAPI / AsyncAPI. `contract-designer` projects the IR into those documents; `ir-validator` and `contract-linter` both fail on divergence.
- **OAuth2 auth:** when `channels[].auth` is an object with `type: oauth2`, the pack must acquire a token using the declared `issuer`, `audience`, and `scopes` at runtime. `clientSecretRef` is a secret-store reference — the pack must resolve it via the platform's secret-store API, not inline it. Never fall back to a hard-coded credential.
- **Flow tests:** `<plat>-workflow-tester` may consume `flows[].tests[]` to generate native test fixtures when higher-fidelity testing is needed than the core `flow-tester` provides. The core `/test-flows` must always remain runnable without the pack present.

## Verification

Before merging a new pack:

1. `npx -y ajv-cli validate -s schemas/integration-ir.schema.json -d <example-ir>` passes.
2. `/implement-<plat>` produces a project that builds in its native toolchain.
3. At least one unit test per flow exists and passes.
4. `<plat>-reviewer` returns zero Sev-1 findings on the worked example.
5. The worked example's `integration-ir.yaml` contains at least one OAuth2 `auth` channel, and the pack's output binds it correctly (token acquired from the declared issuer with the declared scopes; secret resolved from the store reference).
6. Agents and commands appear in the `/` palette after a Claude Code restart with no errors.
