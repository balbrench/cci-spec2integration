# Architecture Review — Skills / Agents / Commands balance

> **Scope.** This is a design review of how `spec2integration` divides responsibility across the
> three Claude Code primitives — **subagents** (`.claude/agents/`), **skills** (`.claude/skills/`),
> and **slash commands** (`.claude/commands/`) — assessed against current (2025–2026) Anthropic
> guidance. It answers one question: *is the current balance right, or should most agents be
> replaced by skills?*
>
> **It is documentation only — it changes no agent, skill, command, or setting.**

## Verdict

**Keep the agents. Do not bulk-convert them into in-context skills.** The current
knowledge/execution split is correct and matches current best practice. The one real
modernization opportunity is collapsing the now-**redundant command layer**, not converting
executors into skills.

The macro-architecture is on-pattern: this repo is a deterministic **prompt-chaining workflow with
gates**, which is exactly the shape Anthropic recommends for a task that can be pre-mapped into a
fixed decision tree (spec → model → contracts → map → IR → plan → tasks → implement).

## What this repo is (so we judge it against the right standard)

Anthropic's *Building Effective Agents* distinguishes two shapes:

- **Workflows** — LLM steps orchestrated through *predefined code paths*. Best for deterministic,
  decomposable tasks.
- **Agents** — the model directs its own process dynamically. Best for open-ended tasks whose path
  can't be hard-coded.

> "If the task ambiguity allows you to pre-map the decision tree, build it as a workflow instead —
> you'll get more accuracy, more control, and lower cost than any agent."
> — *Building Effective Agents*

`spec2integration` is squarely a **workflow**, specifically **prompt chaining**: each stage
consumes the prior artifact, with a **programmatic gate** between steps (schema validation via
ajv/spectral, `ir-validator`, `spec-coverage-checker`, `reviewer`, the constitution phase gates).
That is the canonical reliability mechanism for this class of system. The fixed, predictable stage
order is a *feature*, not a limitation to be "agent-ified."

## Best-practice findings the review is graded against

1. **Skills ≠ subagents — they solve different problems.**
   A **skill** is reusable knowledge/procedure loaded *into the current context* via progressive
   disclosure (name + description always; body on trigger; bundled files only when read). A
   **subagent** is a *separate context window* that returns one summary. Replacing an agent with a
   skill does not delete the work — it moves it into the orchestrator's context.
   Sources: [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview),
   [Subagents](https://code.claude.com/docs/en/sub-agents).

2. **Commands have been merged into Skills (Oct 2025).**
   `.claude/commands/x.md` and `.claude/skills/x/SKILL.md` both create `/x` and behave the same
   way. Skills are the recommended superset; commands persist only for backward compatibility.
   Source: [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills).

3. **Skills can fork into isolation.**
   `context: fork` + `agent:` frontmatter runs a skill in its own subagent context — so a *single
   skill* can be both the user entry point and the isolated executor. Subagents can also preload
   skills via a `skills:` field. This is what makes the current three-layer stack collapsible.

4. **Subagent isolation has real cost, and must earn it.**
   Each spawn reloads CLAUDE.md + git status + the delegation message (~3.5–6.5k tokens), and
   multi-agent runs report large token multipliers. Isolation is worth it for: verbose output you
   won't reuse, genuine parallel fan-out, tool restriction, or model downgrade.

5. **Separating knowledge from execution is an endorsed pattern.**
   Anthropic's Agent Skills / progressive disclosure exists precisely to factor reusable domain
   knowledge (decision tables, mappings, schemas) out of executors and load it just-in-time.
   *This repo already does this well* — e.g. `biztalk-to-azure-mapping`, `eip-to-azure-mapping`,
   and `logic-apps-builtin-connectors` carry large reference bundles the agents read on demand.
   > "Bundle comprehensive resources: include complete API docs, extensive examples, large
   > datasets; no context penalty until accessed." — *Agent Skills best practices*

6. **Context isolation across stages is the recommended long-horizon strategy.**
   *Effective context engineering* names multi-agent sub-contexts as a way to keep a stage's
   reasoning trail out of the parent — only the validated artifact crosses the gate. The repo's
   **Article II** ("platform packs consume only the IR and `contracts/`; they do not read the PRD,
   spec.md, or data-model.md") is textbook context isolation.

7. **Prefer the simplest thing that works.**
   > "Consistently, the most successful implementations use simple, composable patterns rather than
   > complex frameworks." — *Building Effective Agents*
   Over-decomposition into too many tiny agents, parallelizing a sequential spine, and premature
   abstraction are named anti-patterns.

## Why "replace most agents with skills" is the wrong move

The premise assumes agents are carrying knowledge that belongs in skills. They aren't — the
knowledge is *already* in skills, and the agents are thin executors that apply it. Converting them
to in-context skills would:

- **Destroy context isolation.** The heavy compilers load large reference skills (connectors
  ~700 KB, EDI ~636 KB, resilience ~484 KB) and emit dozens of files. Running that inline would
  flood the orchestrator's window and trigger context rot — the opposite of best practice.
- **Not reduce surface area.** It relabels N agents as N skills. The moving-part count is unchanged;
  only the isolation is lost.
- **Break the platform-pack model.** The `<plat>-*` agent-per-artifact convention is the extension
  mechanism (drop in `aws-*`, `mulesoft-*`). Folding executors into in-context skills erodes the
  one-agent-one-artifact contract that keeps packs pluggable.

## Where the balance *can* improve (optional, priority order)

These are refinements, not corrections — the system is sound as-is.

1. **Collapse the redundant command layer.** Most of the 27 commands are thin wrappers that
   delegate to one subagent and refresh `status.json`. Post-merger, these are idiomatically a
   single **forking skill** (`context: fork`, `agent: <the-agent>`). Representative candidates:
   `architect`, `model`, `contracts`, `map`, `specify`, `tasks`. **Keep the thick orchestrators**
   (`run-pipeline`, `implement-azure`, `review`, `deploy-azure`, `test-azure`) as commands/skills —
   they sequence many agents and own the Bash gates that agents can't run.
2. **Batch the sequential validators.** Run the independent `/review` checks
   (`ir-validator`, `stm-drift-checker`, `secret-scanner`, `pii-flow-checker`,
   `spec-coverage-checker`, `contract-linter`) as one fan-out pass rather than serially — they
   are provably independent, the one place parallelization is safe.
3. **Merge the tightly-coupled producer pair.** `mapping-designer` feeds its `mappings:` block
   straight into `integration-architect`; merging removes a round-trip if you want fewer stages.
4. **Prefer deterministic gates over LLM-judgment gates** wherever a check can be coded; reserve
   the `reviewer` agent for genuinely semantic constitution checks.

## What must stay as isolated executors

Isolation clearly earns its keep here — keep these as subagents (or forked skills):

- **Heavy compilers:** `integration-architect`, `azure-logic-apps-compiler`, `azure-bicep-author`,
  `azure-functions-compiler`, `azure-data-factory-compiler`, `azure-connections-binder`,
  `azure-local-functions-author`, and the `biztalk-*` crackers/compilers.
- **Parallel validators:** `reviewer`, `ir-validator`, `spec-coverage-checker`, `pii-flow-checker`,
  `stm-drift-checker`, `secret-scanner`, `contract-linter`.

## Summary table

| Concern | Best-practice primitive | Status in repo |
|---|---|---|
| Reusable domain knowledge (mappings, schemas, connector refs) | **Skill** (progressive disclosure) | ✅ Correct |
| Heavy, reference-laden, multi-file generation | **Subagent / forked skill** (isolation) | ✅ Correct |
| Independent validation fan-out | **Subagents in parallel** | ⚠️ Currently serial — batch it |
| Thin single-stage user entry point | **Forking skill** (post Oct-2025 merger) | ⚠️ Still a separate command — collapsible |
| Multi-stage orchestration + Bash gates | **Command / orchestrator skill** | ✅ Correct |
| Pipeline spine | **Prompt-chaining workflow + gates** | ✅ Correct |

## Sources

Primary (Anthropic):
- Building Effective Agents — https://www.anthropic.com/engineering/building-effective-agents
- Effective context engineering for AI agents — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- How we built our multi-agent research system — https://www.anthropic.com/engineering/multi-agent-research-system
- Equipping agents for the real world with Agent Skills — https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Agent Skills — overview — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Agent Skills — best practices — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- Claude Code — Skills (command↔skill merger, `context: fork`) — https://code.claude.com/docs/en/skills
- Claude Code — Subagents — https://code.claude.com/docs/en/sub-agents

Corroborating secondary:
- Simon Willison, multi-agent research system — https://simonwillison.net/2025/Jun/14/multi-agent-research-system/
- 12-Factor Agents (humanlayer) — https://github.com/humanlayer/12-factor-agents
- ZenML, What 1,200 production deployments reveal about LLMOps in 2025 — https://www.zenml.io/blog/what-1200-production-deployments-reveal-about-llmops-in-2025
- philschmid, Agentic Patterns — https://www.philschmid.de/agentic-pattern

> **Sourcing note.** A few `anthropic.com` pages returned HTTP 403 to the automated fetch used
> during research; the verbatim Anthropic quotes above were captured via search extracts of those
> exact pages and consistent secondary coverage. The Agent Skills best-practices page was fetched
> in full.
