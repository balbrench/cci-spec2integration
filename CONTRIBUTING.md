# Contributing to Spec2Integration

Thank you for your interest in contributing! This document covers how to report bugs, propose changes, and submit pull requests.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How to Contribute](#how-to-contribute)
- [Development Setup](#development-setup)
- [Pull Request Process](#pull-request-process)
- [Agent, Command, and Skill Authoring](#agent-command-and-skill-authoring)
- [Platform Pack Contributions](#platform-pack-contributions)
- [Commit Style](#commit-style)

---

## Code of Conduct

This project is governed by the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to abide by its terms. Please report unacceptable behaviour to the maintainers via the contact in that document.

---

## How to Contribute

### Reporting Bugs

1. Search [existing issues](../../issues) first — your bug may already be filed.
2. Open a new issue using the **Bug report** template.
3. Include the Claude Code version, OS, and the exact slash command + input that triggered the problem.
4. Attach relevant generated artifacts (IR, review report, etc.) where possible — redact any secrets first.

### Suggesting Features

1. Search [existing issues](../../issues) and [discussions](../../discussions) first.
2. Open a new issue using the **Feature request** template.
3. Describe the integration scenario you are trying to solve; a concrete PRD excerpt is ideal.
4. If the feature introduces a new pipeline stage, reference the relevant section of the [Spec2Integration Constitution](CLAUDE.md#spec2integration-constitution).

### Questions and Discussion

Use [GitHub Discussions](../../discussions) for questions, architectural ideas, and sharing interesting pipeline runs. Issues are for actionable bugs and tracked feature requests.

---

## Development Setup

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Claude Code](https://claude.ai/code) | Latest | Runs the agent pipeline |
| Node.js + npm | 20 LTS+ | Spectral / ajv-cli / VS Code extension |
| .NET SDK | 8.0+ | FlowTester + Logic Apps unit tests |

### Clone and open

```bash
git clone https://github.com/balbrench/cci-spec2integration.git
cd cci-spec2integration
```

Open the folder in Claude Code or VS Code — no install step is required for the agents and skills themselves. Claude Code auto-loads everything under `.claude/` at startup.

### Optional tooling

```bash
# Spectral for contract linting (or use npx — agents prefer npx by default)
npm install -g @stoplight/spectral-cli

# ajv-cli for JSON Schema and IR validation
npm install -g ajv-cli

# VS Code extension (dev mode)
cd tools/vscode-extension
npm install && npm run compile
# then press F5 in VS Code to launch the extension host
```

### Running tests

```bash
# .NET flow-test runner
cd src/pipeline/FlowTester
dotnet test
```

---

## Pull Request Process

1. **Fork** the repository and create a branch: `git checkout -b feat/my-feature` or `fix/my-bug`.
2. **Make your changes.** Keep commits focused (one logical change per commit).
3. **Check existing tests pass.** Run `dotnet test` for the FlowTester and any affected unit tests.
4. **Update documentation** inline — agents have their own `AGENT.md` or frontmatter; skills have `SKILL.md`.
5. **Open the PR** against `main`. Fill in the PR template fully.
6. **A maintainer will review** within a reasonable timeframe. Expect feedback; be ready to iterate.
7. Once approved and CI passes, a maintainer will merge.

> **Draft PRs are welcome.** Open one early to signal work-in-progress and gather feedback on direction before investing in a full implementation.

### PR scope guidance

| Change type | Branch prefix |
|-------------|--------------|
| New feature / new agent or command | `feat/` |
| Bug fix | `fix/` |
| Documentation only | `docs/` |
| Refactor / rename (no behaviour change) | `refactor/` |
| New example scenario | `example/` |
| New platform pack | `platform/<name>` |

---

## Agent, Command, and Skill Authoring

All agents, commands, and skills live directly under `.claude/` — no plugin registration required. Claude Code loads them automatically.

### Adding an agent

1. Create `.claude/agents/<name>.md` (or `<prefix>-<name>.md` for a platform-specific agent).
2. Include a YAML frontmatter block that declares `name`, `description`, and optionally `skills` (preloaded `SKILL.md` paths for reference-heavy compilers).
3. Write the `## Inputs`, `## Outputs`, and `## Instructions` sections.
4. Add the agent to the table in `CLAUDE.md` under the correct prefix group.
5. If the agent produces a primary artifact, add it to the **Status refresh contract** table in `CLAUDE.md` and implement the `status.json` merge step as its final action.

### Adding a command

1. Create `.claude/commands/<name>.md`.
2. The first H1 is the command name shown in Claude Code's `/` menu.
3. Commands orchestrate agents via the `Agent` tool — they do not duplicate agent logic inline.
4. Add the command to the relevant table in `CLAUDE.md`.

### Adding a skill

1. Create `.claude/skills/<name>/SKILL.md` plus any `reference/` sub-files.
2. `SKILL.md` is loaded on demand (or preloaded by agents that declare it in frontmatter).
3. Keep `SKILL.md` focused on a single domain; split large skill files into a `reference/` subfolder.
4. Add the skill to the skills section of `CLAUDE.md`.

### Constitution compliance

Every new agent output must satisfy the applicable [constitutional articles](CLAUDE.md#spec2integration-constitution). The `reviewer` agent audits all artifacts — add test fixtures in `tests/fixtures/` to cover your new agent's output.

---

## Platform Pack Contributions

A platform pack is a set of `<plat>-*` agents, commands, and skills that compile the IR to a new target. See [docs/platform-pack-guide.md](docs/platform-pack-guide.md) for the full authoring guide.

Naming convention: all files use the `<plat>-` prefix. No other changes to the core pipeline are required.

---

## Commit Style

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer: Closes #123]
```

| Type | When to use |
|------|------------|
| `feat` | New agent, command, skill, or platform pack |
| `fix` | Bug fix in an agent, command, or script |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or updating tests |
| `chore` | Build scripts, CI, dependency bumps |

Scope examples: `azure-pack`, `biztalk-pack`, `ir-schema`, `flow-tester`, `vscode-ext`, `examples`.
