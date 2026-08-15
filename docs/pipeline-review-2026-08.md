# Spec2Integration — end-to-end review (2026-08)

Scope: the pipeline contract (CLAUDE.md + constitution), all 35 agents, 27 commands and
34 skills (including a content pass over the 25 Azure-facing ones), the JSON schemas, the
VS Code extension (v1.0.2) and both visualizers.

Method: static review plus a few executable checks — `tsc --noEmit` on the extension
(clean), `node esbuild.js --production` (clean, 56.6 kB), `node scripts/sync-assets.js`
(380 files, 4.7 MB), and a regeneration/diff of `templates/azure/reference-workflows/catalog.json`
(byte-identical, 63 entries — the catalog is current).

---

## 1. What is in good shape

- **The spine is sound.** Contract-first → IR-first → platform pack is enforced at the
  right places: `/plan`'s phase gates, `/implement-azure`'s host bucketing, and the
  hard Bash gates in `/implement-azure` (8a `az bicep build`, 8b strict-parse of every
  `adf/*.json`). Those two gates are the best pattern in the repo — a deterministic check
  owned by the orchestrator precisely because the agent that emitted the artifact has no
  Bash to verify it. More of the pipeline should look like this (see §5.1).
- **Skill preloading is the right call** and the rationale in CLAUDE.md is correct — it
  converts "the model might read the connector reference" into "the connector reference
  is in context". Applied consistently across the heavy Azure compilers.
- **`/review`'s parallel validator fan-out** is now implemented (single message, five
  agents). This closes item 2 of `docs/architecture-review-skills-agents.md`.
- **The extension is genuinely well built.** Typechecks clean; the asset bundle is
  generated from the live repo rather than hand-maintained; the scaffolder probes for
  `pwsh`/`powershell` before wiring the hook, so a mac/Linux project doesn't log a failing
  hook on every edit; the CSP on the visualizer webview is tight (`default-src 'none'`,
  `connect-src 'none'`, vendored libs only).
- **Reference workflow catalog** is real, current, and consumed by exactly the two agents
  that need it.

---

## 2. Findings

Severity uses the repo's own scale.

### Sev-1 — blocks or silently corrupts the process

#### F-1. `pipeline-status` contradicts itself on who owns `status.json`

`.claude/skills/pipeline-status/SKILL.md` states both positions:

- Lines 8–30 — *"**Agents** are the primary owners… Slash commands no longer own the
  refresh"*, with a merge pattern (§"How to update").
- Lines 265–273 — *"**Sub-agents MUST NOT write `status.json`**… This is a hard rule with
  three reasons"*, with the opposite merge model (*"Only the calling slash-command
  refreshes"*).

Two further internal conflicts sit inside the same file:

- §"Refresh protocol" step 2 says *"Do **not** trust the previous `status.json` —
  overwrite from scratch"*, which contradicts both the merge pattern above it and
  CLAUDE.md's *"Never overwrite the full file from scratch"*.
- `refreshedBy` is specified twice: as the agent name (`"reviewer"`) in step 5 of the
  merge pattern, and as the slash-command name with a leading slash (`/review`) in the
  output schema and the visualizer footer contract.

CLAUDE.md's "Status refresh contract" section takes the agent-ownership side and lists 25
agents that "MUST" refresh. **The implementation takes the other side**: every stage
command (`/model` step 5, `/architect` step 6, `/review` step 6, `/implement-azure` step
13, …) performs the refresh, and only 3 of 35 agents mention `status.json` at all
(`reviewer`, `biztalk-spec-author`, `azure-sql-schema-author`).

This is not cosmetic. An agent that reads the skill top-down writes `status.json` and
stamps `refreshedBy` with its own name; the orchestrating command then overwrites it. On
`/implement-azure`, up to eight agents own stage 10 concurrently — exactly the race the
bottom section was written to prevent, and plausibly the origin of the 17 kB stage-10
summary the skill now warns about.

**Fix:** pick command-ownership (it matches the implementation, the provenance argument
and the race argument). Delete the merge-pattern and stage-ownership-map sections from the
skill, delete the "Status refresh contract" agent table from CLAUDE.md, and reconcile
`refreshedBy` to one definition. Keep the PostToolUse hook as the safety net it already is.

#### F-2. The IR cannot express file, FTP, SFTP or Event Hub channels

`schemas/integration-ir.schema.json:167` — `channel.kind` is
`["http","queue","topic","blob","timer","eventgrid"]`, and `$defs/channel` sets
`additionalProperties: false`. There is no escape hatch.

Consequences:

- **The BizTalk path's most common adapters have no valid IR representation.** File, FTP
  and SFTP receive locations are the bread and butter of BizTalk, and
  `.claude/skills/biztalk-to-azure-mapping/SKILL.md` maps all three in full (service
  provider IDs, trigger semantics, the FTP "trigger returns metadata, add
  `getFileContent`" rule). `biztalk-ir-compiler` has nowhere to put them — it must either
  mis-file them as `blob` or emit a schema-invalid IR.
- **The `event-hubs` skill is unreachable.** Its description says it is consumed
  *"when an IR channel of kind `eventhub` is present"* — a condition no schema-valid IR
  can satisfy. Same for `templates/azure/reference-workflows/event-hub-trigger/` and the
  `connections/event-hub/` template.
- The connection catalog already ships templates for `ftp`, `sftp`, `file-system`,
  `event-hub`, `sap`, `ibm-mq`, `db2`, `cosmos-db`, `confluent-kafka`, `mllp` — the pack
  can bind ten transports the IR cannot name.

**Fix:** extend the enum (`file`, `ftp`, `sftp`, `eventhub` at minimum) and add the
matching binding shapes to the channel-bindings cookbook in `docs/ir-spec.md`. Longer
term, consider `kind` + an open `protocol` discriminator so a pack can carry a transport
the core schema hasn't enumerated yet, reporting Sev-2 "not supported by pack" rather than
failing validation — which is already the stated policy for `channel.binding` fields.

#### F-3. Article II's hard gate is narrated, not executed

Article II says no platform file may be produced before the IR "validates against
`schemas/integration-ir.schema.json`". Two places claim to do that validation:

- `.claude/agents/ir-validator.md` step 3 — *"Validate against `integration-ir.schema.json`
  using structural rules"*. Its tools are `Read, Edit, Write, Grep, Glob` — **no Bash**.
- `.claude/commands/architect.md` step 4 — *"validate it against
  `schemas/integration-ir.schema.json`"*. `allowed-tools` — **no Bash**.

So the pipeline's strictest gate is a model reading a 1000-line JSON Schema and reasoning
about conformance, while `ajv` is already allow-listed in `.claude/settings.json` and used
for real by `contract-linter`. The asymmetry is stark: contracts get executable linting,
the IR — the artifact every pack consumes — does not.

**Fix:** give `ir-validator` `Bash` and a first step that converts the YAML to JSON and runs
`npx -y ajv-cli validate -s schemas/integration-ir.schema.json -d <tmp>.json`, emitting each
ajv error as a `SCHEMA_VIOLATION` finding. Keep the model-reasoning pass for the semantic
Phase 9 rules, where it is genuinely the right tool.

#### F-4. There is no CI

`.github/` contains `PULL_REQUEST_TEMPLATE.md`, `ISSUE_TEMPLATE/`, `CODEOWNERS` and
`dependabot.yml` — and no `workflows/`. Nothing on a PR verifies that:

- the extension typechecks and bundles (both currently do — but nothing keeps them doing so);
- `catalog.json` still matches the template tree (currently does — regenerate-and-diff is a
  three-line job);
- the `tests/ir-validator/fixtures/` expectations still fire (today the fixture README
  describes a manual comparison procedure that nobody runs);
- the agent/command/skill counts in the docs match the directories (they currently don't — F-5);
- `examples/*.md` and the fixture IRs validate against the schema.

Every one of those is deterministic and cheap. For a repo whose entire value proposition is
"deterministic gates around a probabilistic core", the absence of CI is the largest
structural gap.

### Sev-2 — drift and inconsistency

#### F-5. Doc drift from the most recent merge (`azure-sql-schema-author`)

- `README.md:3`, `:129`, `:313` say **34 agents** (also "20 core + 5 BizTalk + 9 Azure").
  There are 35 (20 + 5 + 10). CLAUDE.md is correct.
- `docs/agent-reference.md` documents 34 agents — `azure-sql-schema-author` is absent
  entirely, though `/implement-azure` invokes it and CLAUDE.md lists it.
- `run-pipeline`'s remediation dispatch table doesn't mention it either, so a
  SQL-schema-related `/test-azure` failure has no routing rule.

#### F-6. Skill preloading is applied inconsistently to the status contract

Of the agents CLAUDE.md says MUST refresh `status.json`, twelve don't preload
`pipeline-status`: `contract-designer`, `contract-linter`, `biztalk-contract-extractor`,
`ir-validator`, `stm-drift-checker`, `secret-scanner`, `pii-flow-checker`,
`mapping-tester`, `flow-tester`, `azure-connections-binder`, `azure-bicep-author`,
`azure-cicd-author`. If the contract stands they need the skill; if F-1 is resolved in
favour of commands, the whole table goes away. Either way, today's state is the worst of
both.

#### F-7. `azure-sql-schema-author` is told to do the thing the skill forbids

`.claude/agents/azure-sql-schema-author.md:68` — *"merge your `sql/` artifacts into the
stage-10 summary (e.g. **append** `+ SQL schema (<T> tables, <P> procs)`)"*.
`pipeline-status/SKILL.md:20` — *"**REPLACE** your row's `summary`, never append to it…
A 17 KB stage-10 summary that swallowed five agents' histories is exactly the failure this
rule prevents."* The newest agent reintroduces the exact bug.

#### F-8. The stage→command map is triplicated and incomplete

`STAGE_CMD` exists in three hand-maintained copies:
`.claude/skills/pipeline-status/SKILL.md` (next-step precedence),
`tools/vscode-extension/src/commandCatalog.ts:58`, and
`tools/pipeline-runner/index.html:108`. All three omit stage `1` (`/specify`) and stage `7`
(`/platform`), so the tree and the runner render no ▶ action on those rows, and all three
hardcode `-azure` for stages 10/11/12 — which contradicts the pluggable-pack claim in
`docs/platform-pack-guide.md`.

#### F-9. Cross-platform: the always-on staleness probe is Windows-only

CLAUDE.md presents `scripts/refresh-status.ps1` as *"the always-on staleness probe the
Bash-less slash commands can't run"*. It's 858 lines of PowerShell. The scaffolder handles
this correctly (probes for `pwsh`, omits the hook when absent), which means a mac/Linux
project silently has **no** staleness detection except by manually running `/status` —
and CLAUDE.md never says so. The repo's own `.claude/settings.json:35` hardcodes
`powershell` (Windows PowerShell, not even `pwsh`), so the hook doesn't run in this very
repo on any non-Windows machine.

#### F-10. Stale self-assessment

`docs/architecture-review-skills-agents.md`'s summary table still marks "Independent
validation fan-out" as *"⚠️ Currently serial — batch it"*. `/review` step 3 now issues all
five validator `Agent` calls in a single message. The recommendation was implemented; the
doc wasn't updated.

### Sev-3 — advisory

- `run-pipeline`'s resume table lists a stage id `0 Inventory`; the actual ids are `0a`
  and `0b` everywhere else.
- `.claude/agents/clarifier.md` has a relative markdown link to `spec.md` that resolves
  nowhere from `.claude/agents/`.
- The repo's `.claude/settings.json` allow-list carries developer-machine artefacts:
  `c:\AIAgents\…` paths, `Read(//c/Projects/BizTalk-Combined/**)`, and a one-off
  `xargs -0 sed -i` command from the plugins→`.claude` migration. The scaffolder's
  `assets-templates/settings.json` is correctly clean — the repo's own file should match it.
- `@vscode/vsce` is not in `devDependencies`, yet `npm run package` invokes `vsce`; the
  packaging step only works if vsce happens to be installed globally.
- `examples/` starts at `02-`; there is no `01-`.

---

## 3. Azure skills

Reviewed the 25 Azure-facing skills (`workflow-json-rules`, `connections-json-generation-rules`,
`logic-apps-builtin-connectors`, `logicapp-standard-layout`, `scaffold-logic-apps-project`,
`logicapp-cloud-deployment`, `logic-apps-standard-testing`, `logic-apps-resilience-observability`,
`no-stubs-code-generation`, `integration-account-artifacts`, `edi-x12`, `data-factory`,
`ais-platform`, `api-management`, `service-bus`, `event-grid`, `event-hubs`, `azure-functions`,
`batch-processing`, `dotnet-local-functions`, `logic-apps-rules-engine`, `eip-to-azure-mapping`,
`logic-apps-planning-rules`, `logic-app-patterns`, `runtime-validation-and-testing`).

**These are the strongest artifacts in the repo.** They are specific where it counts (exact
`operationId` casing, `serviceProviderId` values, the FTP-vs-FileSystem naming trap), they carry
provenance for hard-won facts (`[VERIFIED — deployed runtime]`, *"This was a real bug"*, dated
runtime versions), and they cross-reference each other correctly. Three things I expected to be
contradictions turned out to be right:

- `.bicepparam` vs `main.parameters.json` — looks like a conflict across four files; is actually
  correct and explained (`logicapp-cloud-deployment` §: `azd provision` reads
  `main.parameters.json` and does *not* read `.bicepparam`; both are emitted deliberately).
- `mountPath` rules agree exactly between `connections-json-generation-rules` §3.4 and
  `logicapp-cloud-deployment` §5, down to the single-subdirectory-of-`/mounts` constraint.
- the EDI `schemaReferences[]` post-upload PATCH is stated identically in
  `connections-json-generation-rules`, `integration-account-artifacts`, `edi-x12` and
  `conversion-task-plan-rules`.

No orphans either: every one of the 34 skills is reachable from at least one agent, and the
preloaded-vs-on-demand split matches the documented policy (always-needed authoritative skills in
`skills:` frontmatter; per-channel/per-format skills named in `## Inputs` prose).

The defects below are narrower than §2's, but two of them sit inside *preloaded* skills — which
means they are injected into the compiler's context on every single run.

### A-1 (Sev-1). The compiler already branches on channel kinds the schema forbids

`.claude/agents/azure-logic-apps-compiler.md:141` handles `ftp` / `filesystem` / `sftp`
file-drop intake explicitly, with a full substitution pattern. **None of those three is a legal
`channel.kind`** (schema line 167). This is the same defect as F-2, but it confirms it from the
other end: this is not a theoretical modelling gap, there is already-written, carefully-reasoned
compiler logic that no schema-valid IR can ever reach.

Note the exact spellings when fixing F-2 — the compiler expects `ftp`, `filesystem`, `sftp`
(not `file`). Adopt the compiler's names in the enum rather than inventing new ones.

### A-2 (Sev-2). `scaffold-logic-apps-project` emits an `azure.yaml` that `azd` cannot use

§3.17 gives *verbatim file content* for `../azure.yaml`:

```yaml
name: <slug>
metadata:
  template: spec2integration-azure@1.0.0
# Add services only for stand-alone Function Apps...
```

There is no `infra:` block. That contradicts, in order:

- **its own §5 verification gate** — *"`azure.yaml` (integration root) points `infra.path` at
  `./infra`"*;
- `templates/azure/azure.yaml`, which has the full `infra: {provider, path, module}` block;
- `/implement-azure` step 6 — *"with `infra.path: ./infra`"*.

This is a "verbatim content" block in a **preloaded** skill, so the literal-copy behaviour it asks
for is exactly what produces the broken file. `azd provision` has no template to deploy.

Same file, §0: *"`azure.yaml` at the integration root references `./app`"* — the direct opposite of
the rule stated three lines below it in §3.17's own comment and in `/implement-azure` step 6 (Logic
Apps Standard content is package-deployed, never an azd service).

### A-3 (Sev-2). A preloaded skill tells the compiler a capability it has doesn't exist

`workflow-json-rules` §4.1 documents the verified runtime failure of native file-added
service-provider triggers and prescribes the Recurrence + list-files + `For_each` +
`getFtpFileContentV2` replacement — then closes with:

> *"(Until the compiler emits this pattern, file-intake flows deploy but their trigger will not
> register — track as a known limitation.)"*

The compiler **does** emit it — `azure-logic-apps-compiler.md:141`, including the Event Grid
alternative and the "note the substitution in the run summary" instruction. The caveat is stale and
actively misleading: it invites the compiler to treat working behaviour as a known-broken area.

### A-4 (Sev-2). Two preloaded skills disagree about TODO markers

`workflow-json-rules` §1.4: *"Do NOT invent `operationId` values. If you can't find a reference,
**flag it as a TODO**."*
`no-stubs-code-generation`: `// TODO` comments and `"value": "TODO"` in any action input are both
**Sev-1**, with regexes to detect them.

Both are preloaded into `azure-logic-apps-compiler`, so the agent receives both rules in the same
context. The intent of each is fine; the instruction should be reconciled to *"stop and report the
missing reference"* — which is what no-stubs actually requires and what the catalog cross-check in
§5.1 would make cheap.

### A-5 (Sev-3). Layout skill's `infra/` tree is stale

`logicapp-standard-layout` lists `parameters.dev.bicepparam` / `parameters.prod.bicepparam` and a
`modules/keyvault.bicep`, but omits `main.parameters.json` — which `/implement-azure` gate 8a hard-
requires and `azure-bicep-author` §6b calls a Sev-1 omission — and omits `datafactory.bicep`, which
exists in `templates/azure/infra/modules/`. `azure-reviewer` preloads this skill as its audit
reference for the emitted tree.

### A-6 (Sev-3). "Mandatory Reference Lookup" never says where to look

`workflow-json-rules` §1 is three phases of *"Search reference workflows…"*, *"Search reference
connections…"* with no path anywhere in the section. The actual location is
`templates/azure/reference-workflows/`, indexed by `catalog.json` (63 entries, and current). For
the one rule whose entire purpose is "never guess an `operationId`", leaving the lookup target
implicit is the single determinism hole in an otherwise very tight skill. Name the folder and the
catalog in §1.1.

### A-7 (Sev-3). `scaffold-logic-apps-project` frontmatter miscounts its own manifest

The description — the part that gets injected and indexed — says *"17-file manifest"*. The manifest
heading, the file table, and the §5 verification gate all say **18**.

---

## 4. Visualizers

### 4.1 IR visualizer (webview) — the graph never refreshes

`tools/vscode-extension/src/extension.ts:404-406` watches `status.json`, `state.json` and
the BizTalk inventory/catalogue. **It does not watch `integration-ir.yaml`**, and
`refreshVisualizer()` (`src/visualizer.ts:108`) only re-posts `status` and `findings` — it
never re-reads the IR. The viewer's message contract has no `ir` refresh message either;
`load` is the only path that parses YAML.

Net effect: open the visualizer, let `/architect` or a `--auto-fix` loop rewrite the IR,
and the graph silently shows the previous version while the status pill updates around it.
The one moment the picture matters most is the one moment it's wrong.

**Fix:** add `**/specs/**/integration-ir.yaml` to the watcher set, and either extend the
message contract with `{type:'ir', ir}` (re-parse, preserve `currentView`/`currentFlow`) or
re-send `load` and restore the view. Small change, high value.

Other visualizer gaps, roughly in value order:

1. **Only `ir-validation-report.json` is overlaid.** `review-report.json` — the findings
   that actually block `/plan` — is never pushed in, nor are `pii-flow-report.json` or
   `stm-drift-report.json`. The status pill shows `N Sev-1` but you cannot click through
   to the offending node. Since the reviewer already emits `location`-style strings and
   `locationToNodeIds()` is deliberately tolerant, this is mostly wiring: post the review
   report alongside the validation report and let the drawer group by source.
2. **No `implementation.host` awareness.** The IR now routes flows to
   `logic-app-standard` / `function-app` / `data-factory` / `container-app` /
   `synapse-pipeline`, and `/implement-azure` buckets by exactly that field into `app/`,
   `FunctionApps/`, `adf/`. The viewer renders every flow identically — grep for
   `implementation` in `media/visualizer/index.html` returns nothing but comments. A host
   badge on the flow node (and a `durablePattern` badge in the flow detail panel) would
   make a mixed-target IR legible at a glance.
3. **No panel restore.** `retainContextWhenHidden: true` is set, but no
   `WebviewPanelSerializer` is registered, so after a window reload the panel reopens on
   the empty state with no folder.
4. **PNG export and error reporting go through browser APIs that webviews restrict.**
   `$('#btnExport')` builds a `data:` URL and calls `a.click()`; `loadYamlText()` reports a
   parse failure via `alert()`. Both are worth routing through the extension host
   (`postMessage` → `showSaveDialog` + `fs.writeFile`; and render the parse error into the
   existing in-panel empty state, which is better UX regardless — today a malformed IR
   leaves the panel looking merely idle).
5. `formatForChannel`'s `channelToMsg` index is last-writer-wins when two flows use the
   same channel, and it reads `ch.format`, which `additionalProperties: false` makes an
   impossible field.

### 4.2 Two visualizers, one IR

`/visualize` writes a Mermaid diagram to `docs/generated/flows.md`; the webview draws a
Cytoscape graph. Both derive from the same IR with entirely independent traversal logic, so
they can and will disagree. Worth deciding whether the Mermaid output is the shareable
export of the webview's model (generate it from the same node/edge builder) or a separate
deliberately-simpler artifact — and saying which in the docs.

### 4.3 Extension packaging

Builds clean (`tsc --noEmit` 0 errors; esbuild 56.6 kB; assets 4.7 MB, dominated by the
vendored Microsoft reference docs under `skills/*/reference/`, which is the intended
trade-off for offline operation). `sync-assets.js` deriving the bundle from the live repo
is the right design — the `.vsix` cannot drift from `.claude/`. The gaps are F-5 (the
bundled `CLAUDE.md`/docs ship the stale counts), the missing `vsce` devDependency, and the
absence of a CI job that runs `npm run package` on a PR.

---

## 5. Recommended improvements to the end-to-end process

Ordered by value-to-effort.

### 5.1 Make every gate executable

The `/implement-azure` 8a/8b gates are the model: *the orchestrator has Bash, so the
orchestrator verifies what the Bash-less agent emitted.* Generalise it:

| Gate | Today | Should be |
|---|---|---|
| IR conforms to schema | model reads the schema | `ajv-cli` in `ir-validator` (F-3) |
| Mapping expressions evaluate | `mapping-tester` (has Bash) ✅ | keep |
| Contracts lint | `contract-linter` (has Bash) ✅ | keep |
| Bicep compiles | `az bicep build` ✅ | keep |
| ADF JSON parses | strict-parse ✅ | keep |
| Workflow JSON is well-formed | not checked | strict-parse `app/**/workflow.json` in `/implement-azure`, same shape as 8b |
| `operationId`/`serviceProviderId` are real | skill preloading only | cross-check emitted IDs against `catalog.json` — it already indexes every valid ID |

That last row is the highest-value addition: the repo's stated worst failure mode is a
guessed `operationId`, preloading makes it *less likely*, and a catalog cross-check makes it
*detectable*.

### 5.2 Add CI (one workflow, five jobs)

`typecheck+bundle+package` the extension · `catalog.json` regenerate-and-diff ·
`ajv` over `examples/` and `tests/ir-validator/fixtures/*/integration-ir.yaml` ·
a doc-consistency script (counts in README/CLAUDE.md/agent-reference vs `ls .claude/*`) ·
markdown link check excluding `skills/*/reference/`. All five are minutes of work and
would have caught F-5 and F-10 automatically.

### 5.3 Resolve the status-ownership contradiction (F-1) and generate the stage table

Pick command-ownership, then make the stage table a single generated source: one
`stages.json` from which the skill's markdown table, `commandCatalog.ts`, and the
pipeline-runner's `STAGE_CMD` are produced. That kills F-8 permanently and makes adding a
stage a one-file change.

### 5.4 Port `refresh-status.ps1` to Node

858 lines of PowerShell is the only Windows-only component in a stack that otherwise runs
anywhere; Node is already a hard dependency (esbuild, ajv, spectral, the catalog builder).
A single `scripts/refresh-status.mjs` makes the always-on staleness probe genuinely
always-on, and lets the scaffolder drop the `pwsh` probe.

### 5.5 Extend the channel model before the next platform pack (F-2)

`ftp`/`filesystem`/`sftp`/`eventhub` are needed *today* by the BizTalk path — and per A-1
the Logic Apps compiler is already written against the first three. Use the compiler's exact
spellings. Doing this now, with one pack in the tree, is far cheaper than doing it once
`aws-*` or `mulesoft-*` agents also depend on the enum.

The four Azure-skill fixes (A-2 azure.yaml, A-3 stale caveat, A-4 TODO conflict, A-6 missing
lookup path) are each a few lines of edit in a preloaded skill, and all four change what the
compiler is told on every run. They are the cheapest items on this list.

### 5.6 Close the visualizer loop

IR watcher + `{type:'ir'}` message (§4.1), review findings overlaid alongside validation
findings, host badges on flow nodes. Together these turn the viewer from a static picture
into the live cockpit the progress panel is already trying to be.

### 5.7 Then, and only then, consider the structural refactor

`docs/architecture-review-skills-agents.md` item 1 — collapsing thin single-agent commands
(`/model`, `/architect`, `/map`, `/contracts`, `/specify`, `/tasks`) into forking skills —
is still a reasonable direction, but it touches every entry point. It is worth strictly
less than 5.1-5.4, and it is much safer to do once CI exists to prove nothing regressed.
