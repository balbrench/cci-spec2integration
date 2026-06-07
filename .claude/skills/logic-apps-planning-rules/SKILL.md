---
name: logic-apps-planning-rules
description: Authoritative planning rules for Azure Logic Apps Standard implementations. Covers Integration Account decision, source-design preservation policy (no merge/simplify), and the component-priority ladder for choosing the right Logic Apps construct (built-in connector → expression → Compose → Data Mapper/Liquid → .NET local function) with the custom-code-from-source override. Consumed by the `planner` agent. Adapted from the Azure Logic Apps Migration Agent reference.
---

# Logic Apps Standard — Planning Rules

> **Purpose**: Decisions every Azure plan MUST make consistently — what to provision, what to keep, and which Logic Apps construct to pick for each IR action. These rules complement `conversion-task-plan-rules` (which orders the tasks) by deciding **what** the tasks should produce.

---

## 1. Integration Account decision (provision-only-if-needed)

> **Rule**: Provision an Integration Account ONLY if at least one of the following is true for the integration. Otherwise, do NOT provision one — use Logic App `Artifacts/` instead.

Provision an IA if any flow uses:

- **EDI**: X12 (`X12Decode`/`X12Encode`/`X12BatchEncode`), EDIFACT, HL7 over MLLP that requires agreement-based encode/decode.
- **Trading-partner agreements** (AS2 partner pairs, EDI agreements). These require IA's partner/agreement model.
- **Map cross-references** at runtime (Integration Account `MapName` lookup) where a single map is shared across multiple Logic Apps.
- **Schema cross-references** where a single XSD is shared across multiple Logic Apps.

For everything else — including BizTalk-derived XSLT maps, XSDs used by a single Logic App, flat-file schemas — use `<logicAppName>/Artifacts/Maps/` and `<logicAppName>/Artifacts/Schemas/` per `integration-account-artifacts` skill §2/§3. The built-in `Xslt`, `XmlValidation`, `XmlCompose`, and `FlatFileDecoding` actions accept Source: `LogicApp` references with no IA dependency.

### Bicep impact

If IA is **not** provisioned:
- Do NOT emit `infra/modules/integration-account.bicep`.
- Do NOT add `integrationAccount` to the Logic App resource properties.
- Do NOT emit `connections.json` entries with `integrationAccount` parameter values.

If IA **is** provisioned:
- Emit the IA module, the agreement/schema/map/partner uploads, and the post-deploy `schemaReferences[]` PATCH per `connections-json-generation-rules` §5.1.
- Wire the Logic App's `integrationAccount` property to the IA's resource ID.

### Plan-level decision record

`plan.md` MUST contain a one-line decision in Phase 0 or Phase 3:

> **Integration Account**: PROVISION | NOT REQUIRED — *<one-sentence reason citing the IR construct that drives the decision>*.

---

## 2. Preserve source design (no merge, no simplify)

> **Rule**: The plan MUST preserve the source flow topology one-to-one. Do NOT merge two source flows into one Logic App. Do NOT split a single source flow across two Logic Apps. Do NOT "simplify" by dropping intermediate steps the IR declares.

### What this means

| Source has | Plan must produce |
|---|---|
| One BizTalk orchestration with three send ports | One Logic App workflow with three send branches |
| Two receive locations into the same orchestration (per `detect-logical-groups` Rule 1) | One workflow with one trigger that handles both shapes (or two workflows feeding a child workflow) — the **group** is preserved as one Logic App |
| A pipeline that does Validate → Decode → Disassemble → Map | A workflow that does `XmlValidation` → `EdifactDecode` → `XmlCompose` → `Xslt` (one action per source step) |
| A custom .NET helper called by the orchestration | An `InvokeFunction` action calling a real local function whose body is the translated helper |

### What this prohibits

- **Combining** two unrelated flows into one workflow because they share a destination.
- **Replacing** an `XmlValidation` step with "we'll trust the source" because the schema is non-trivial.
- **Skipping** an `EdifactDecode` → `XmlCompose` bridge (Sev-1 per `workflow-json-rules` §8.5).
- **Inlining** a custom-code helper as a JavaScript expression when source called a .NET method (see §3 ladder rule below).
- **Re-architecting** to "modernise" — for example, replacing a request/response orchestration with an event-driven pattern unless the PRD explicitly asks for it.

The migration delivers a **functionally equivalent** Logic Apps Standard implementation. Re-architecture is a separate downstream concern.

---

## 3. Component priority ladder

When choosing a Logic Apps construct for an IR action, walk this ladder top-to-bottom. Stop at the first level that satisfies the action's intent **without losing fidelity to the source**.

| Level | Construct | When to use |
|---|---|---|
| 1 | **Built-in connector** (ServiceProvider) | A first-party connector exists for the protocol/operation (Service Bus, Blob, SQL, Event Hub, FTP, SFTP, X12, EDIFACT, MQ, etc.). |
| 2 | **Built-in action** (`XmlParse`, `XmlCompose`, `XmlValidation`, `Xslt`, `Parse JSON`, `Compose`, `FlatFileDecoding`, `FlatFileEncoding`) | The operation is a generic XML/JSON/flat-file shape transform. |
| 3 | **Workflow expression** (`@concat()`, `@coalesce()`, `@formatDateTime()`, `@xpath()`, etc.) | Trivial arithmetic, string, or date manipulation. **NEVER for parsing structured XML when a schema exists** (use `XmlParse`). |
| 4 | **Data Mapper / Liquid template** | Complex JSON↔JSON, JSON↔XML, or template-driven transforms that exceed JSONata/`Compose` ergonomics but are still declarative. |
| 5 | **.NET local function** (`InvokeFunction`) | The source has compiled custom logic, OR levels 1-4 cannot express the required behaviour without losing semantic fidelity. |

### Custom-code override (HIGHEST PRIORITY for ported BizTalk code)

> **Rule**: When the IR carries a `migrationHint: local-function` (or the source artifact is a custom .NET helper, scripting functoid extension assembly, or custom pipeline component decompiled per `biztalk-decompilation`), JUMP STRAIGHT TO LEVEL 5. Do NOT downgrade to a workflow expression, `Compose` + `concat()`, JavaScript, or "we'll inline this in JSONata".

Why:
- The source code already exists and was decompiled. Rewriting it as an expression risks behavioural drift.
- Local functions are unit-testable, debuggable in VS Code, and produce the same observability surface as built-in actions.
- Per `no-stubs-code-generation` skill §2, an `InvokeFunction` call MUST resolve to a real, deploy-ready function body — never a stub. The ladder rule is what guarantees we always have a function to call.

### Anti-patterns

- Picking level 5 when level 1 fits (over-engineering — the .NET project is now a maintenance burden).
- Picking level 3 (`@xpath()`) for XML field extraction when a schema exists (use `XmlParse` — level 2).
- Picking level 4 (Liquid) for trivial reshaping that level 2 (`Compose`) handles in two lines.
- Picking level 3 (`@concat`/`@replace`) to re-implement decompiled C# string-handling logic — that's the override case; use level 5.

---

## 4. Plan-level outputs

`plan.md` Phase 2 (Per-flow implementation) MUST, for each flow, list:

1. The IA decision (§1) — for the integration as a whole, repeat once.
2. The chosen Logic Apps construct for every IR action (§3 ladder level + the specific connector/action ID).
3. The source artifact preserved one-to-one with the planned action (§2 fidelity check).

If any planned action does not map to a ladder level, or skips a source step, stop and write `plan-blocked.md` listing the gaps.
