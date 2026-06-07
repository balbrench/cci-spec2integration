---
name: no-stubs-code-generation
description: Sev-1 prohibition — generated code (`.cs`, `workflow.json`, Bicep, scripts) must be production-ready end-to-end. Never emit stubs, placeholders, `NotImplementedException`, empty method bodies, `TODO` comments, `throw new NotSupportedException()`, fake return values, or "the user will fill this in" markers. Consumed by `azure-local-functions-author`, `azure-logic-apps-compiler`, `azure-bicep-author`, `azure-connections-binder`, and the `azure-reviewer`. Adapted from the Azure Logic Apps Migration Agent reference.
---

# No Stubs in Generated Code

> **Purpose**: A converted BizTalk integration is delivered to teams that intend to deploy it. A stub in any generated artifact silently shifts behaviour from the source system into a runtime-time failure that the team only discovers in the first end-to-end test (or in production). This skill formalises the prohibition and lists the patterns that count as stubs.

This rule is Sev-1 under constitution Article IX (one agent, one artifact) and Article VII (tests before implementation): stubs cannot be unit-tested honestly because the test either passes against the stub (false green) or fails for a non-business reason (false red). The reviewer treats every match in §2 as a hard block.

---

## 1. Scope

This skill applies to every file the pipeline writes into a target platform output folder, including but not limited to:

- `.cs` files under any `Functions/` / local-functions project.
- `workflow.json` files under `app/<flowName>/`.
- `connections.json`, `parameters.json`, `host.json`, `local.settings.json`.
- Bicep files under `infra/` (`main.bicep`, modules, `.bicepparam`).
- Scripts under `scripts/`, `.azure/`, or `azure.yaml` hooks.
- Test scaffolds under `tests-mstest/` (these may use mocks, but mocks must compile and assert real behaviour — see §3).

It does NOT apply to:

- Markdown reports (`review-report.md`, `mapping-test-report.md`, ...) which legitimately use TODO entries for follow-up.
- The IR (`integration-ir.yaml`), spec, data model, or contracts — those are design artifacts, not deployable code.

---

## 2. Prohibited patterns

The following appear in generated code ONLY as a last-resort skeleton during early prototyping. None of them is acceptable in any artifact handed to the reviewer or to `/deploy-azure`. The reviewer (and `azure-reviewer`) MUST grep for these patterns and fail the run on any match.

### 2.1 .NET / local functions

| Pattern | Status |
|---|---|
| `throw new NotImplementedException(...)` | Sev-1 — fail closed |
| `throw new NotSupportedException(...)` used as a placeholder for a missing branch | Sev-1 |
| Empty method body `{ }` for a non-void function that the workflow invokes | Sev-1 |
| `return null;` / `return string.Empty;` / `return "{}";` as a stand-in for the real transformation | Sev-1 |
| `// TODO: implement` / `// TODO: port BizTalk logic` / `// FIXME` | Sev-1 |
| `var result = "<stub>"; return result;` or any literal `"stub"` / `"placeholder"` / `"TBD"` in a return path | Sev-1 |
| Parameters declared and never read inside a non-trivial method | Sev-2 (likely a missed branch) |
| `#warning ...` directives | Sev-2 |

If the source BizTalk logic genuinely cannot be recovered (compiled-only assembly with no decompilation), the function MUST be omitted from the build, and the corresponding `InvokeFunction` action MUST be flagged in the IR with a `migrationHint: manual-review` and a Sev-1 finding raised by the reviewer. Do NOT emit a stub function and pretend the migration is complete.

### 2.2 Workflow JSON

| Pattern | Status |
|---|---|
| `"value": "TODO"` / `"value": "<replace-me>"` / `"value": "PLACEHOLDER"` in any action input | Sev-1 |
| Empty `actions: { }` in a workflow that the IR declares as having business logic | Sev-1 |
| `Compose` action whose `inputs` is a literal string like `"TBD"` or `"see source"` | Sev-1 |
| `Http` action with `uri: "https://example.com/..."` or any `example.com` host | Sev-1 |
| Reference to a connection name not present in `connections.json` | Sev-1 |
| Reference to a `Artifacts/Maps/X.xsl`, `Artifacts/DataMapper/X.lml`, `Artifacts/Liquid/X.liquid`, or `Artifacts/Schemas/X.xsd` not present on disk | Sev-1 (cross-ref to `workflow-json-rules` §9) |

### 2.3 Bicep

| Pattern | Status |
|---|---|
| Hard-coded `subscriptionId` / `tenantId` / GUID resource IDs | Sev-1 |
| `param ... = 'CHANGEME'` / `'TODO'` / `'placeholder'` defaults | Sev-1 |
| Module reference to a file that does not exist | Sev-1 |
| Empty `resource` body `{ }` | Sev-1 |
| `// TODO`, `// FIXME` comments | Sev-1 |

### 2.4 Test code

Test scaffolds may legitimately call `Mock.Setup(...)` and use canned outputs — that is the testing pattern, not a stub. However:

| Pattern | Status |
|---|---|
| `[Ignore]` / `[Skip]` attribute on a generated test | Sev-1 |
| `Assert.Inconclusive(...)` as the only assertion | Sev-1 |
| `// TODO: write assertions` inside a test body | Sev-1 |
| Test method whose body is `await Task.CompletedTask;` and nothing else | Sev-1 |

Mocks MUST return realistic shapes for the action under test. A `MockOutput` whose body is `{ }` is treated as a stub.

---

## 3. The substitution rule

When a stub is the *only* honest representation of the source behaviour (e.g. the source called a third-party DLL whose source is not in the repo), the substitution is NOT a stub in code — it is a documented gap:

1. Omit the unimplementable code from the generated artifact.
2. Add the gap to the IR via `migrationHint: manual-review` on the affected mapping or function reference.
3. Surface the gap in `review-report.md` as a Sev-1 `MISSING_BEHAVIOUR` finding.
4. Surface the gap in `tasks.md` as an explicit task that the human team must complete before deploy.

The reviewer counts (1)+(2)+(3)+(4) as compliant. The reviewer counts a stub-with-no-gap-record as Sev-1 non-compliant.

---

## 4. Detection regex (for reviewer)

The `azure-reviewer` and `reviewer` agents MUST run these greps over the generated platform output folder and treat any hit as Sev-1 (with the §3 substitution rule as the only escape hatch):

```
NotImplementedException
NotSupportedException\s*\(\s*"(?:TODO|TBD|stub|placeholder|fixme)
//\s*(TODO|FIXME|XXX|HACK)\b
"value"\s*:\s*"(TODO|TBD|placeholder|<replace-me>|CHANGEME)"
example\.com
"CHANGEME"
\[Ignore\]
Assert\.Inconclusive
```

False positives in legitimate documentation strings (e.g. an `XmlComment` inside a `.cs` file that explains "this replaces the BizTalk TODO comment") are acceptable when the agent annotates them with `// allow-stub-grep: doc-only` on the same line; the reviewer suppresses those.

---

## 5. Agent-level prerequisites

The following agents MUST treat this skill as a prerequisite (read it before producing their primary artifact):

- `azure-local-functions-author` — every `.cs` it emits must implement the source logic end-to-end. If the source is unavailable, emit nothing for that function and raise the gap per §3.
- `azure-logic-apps-compiler` — every `workflow.json` action must have real, deploy-ready inputs.
- `azure-bicep-author` — every Bicep parameter must have a real default or an explicit `@secure()` declaration; no placeholder strings.
- `azure-connections-binder` — every `@appsetting('NAME')` reference must have a real value (Key Vault reference, real connection string, or explicit local emulator value).
- `azure-workflow-tester` — every test must have at least one real assertion.
- `azure-reviewer` — runs the §4 regex sweep and fails the run on any unannotated hit.

---

_Adapted from the [Azure Logic Apps Migration Agent](https://github.com/Azure/logicapps-migration-agent) reference material._
