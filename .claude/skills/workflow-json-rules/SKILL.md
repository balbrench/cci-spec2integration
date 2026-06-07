---
name: workflow-json-rules
description: Authoritative rules for generating workflow.json files for Logic Apps Standard. Covers connector selection, SplitOn preference, trigger output verification, file trigger semantics, runAfter structure, scenario-specific action overrides (XML, EDI, JSON), and a mandatory pre-finalize validation checklist. Adapted from the Azure Logic Apps Migration Agent reference.
---

# Workflow JSON Generation Rules

> **Purpose**: Authoritative rules for generating `workflow.json` files. Follow exactly. These rules prevent common LLM-generated workflow errors.

---

## 1. Mandatory Reference Lookup

Before generating any `workflow.json`, you MUST follow this exact procedure:

### 1.1 Search Phase

For **each** connector or trigger type you plan to use in the workflow:

1. **Search reference workflows** for the connector name (e.g. `serviceBus`, `fileSystem`, `sql`, `xml`).
2. **Search reference workflows** for the action pattern if applicable (e.g. `Foreach`, `Switch`, `xml transform`).
3. **Search reference connections** for the connector's `connections.json` format.

### 1.2 Read Phase

From the search results, identify the **best-matching** reference workflow. Then:

1. **Read the full workflow JSON** to see the exact trigger/action structure.
2. **Read the connection JSON** to see the exact `serviceProviderConfiguration` format.
3. Note the exact `operationId`, `serviceProviderConfiguration.serviceProviderId`, and `inputs` structure.

### 1.3 Copy Phase

When generating your `workflow.json`:

1. **Copy the exact `serviceProviderConfiguration` structure** from the reference — `serviceProviderId`, `operationId`, and `connectionName` format.
2. **Copy the exact `inputs` format** — field names, nesting, expression patterns.
3. **Copy the exact `type` value** — e.g. `ServiceProvider`, not `serviceProvider`.

### 1.4 Anti-Patterns (NEVER do these)

- **Do NOT invent** `operationId` values. If you can't find a reference, flag it as a TODO.
- **Do NOT guess** `serviceProviderConfiguration` structures. Every connector has a specific format.
- **Do NOT assume** `inputs` field names. They vary per connector (e.g. `queueName` vs `queue` vs `destination`).
- **Do NOT skip** the lookup for connectors you think you know. Always verify against a reference.

---

## 2. Workflow Definition Structure

Each `workflow.json` must contain a `definition` key with:

- `$schema` — `"https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#"`
- `contentVersion` — `"1.0.0.0"`
- `triggers` — at least one trigger
- `actions` — with `runAfter` (object mapping predecessor action names to status arrays) and `type` for each action

### Action Types

| Type | Usage | Notes |
|------|-------|-------|
| `Switch` | Multi-branch routing | Must have `cases` |
| `If` / `Condition` | Binary branching | Must have `actions` (true branch), optionally `else.actions` (false branch) |
| `Foreach` / `Until` | Looping | Nest `actions` inside |
| `Scope` | Error handling container | Nest `actions` inside; `runAfter` supports `Failed`, `TimedOut` |
| `ServiceProvider` | Built-in connector actions | With `serviceProviderConfiguration` |
| `ApiConnection` | Managed connector actions | Only when no built-in ServiceProvider equivalent exists |
| `InvokeFunction` | .NET local function calls | For `migrationHint: local-function` artifacts |
| `Workflow` / `InvokeWorkflow` | Child workflow calls | For Call/Start Orchestration shapes |
| `Http` | HTTP calls | For invoke steps and REST API calls |
| `Compose` | Data construction | For message assembly and simple transforms |
| `Xslt` | XML transformation | For BizTalk map-derived XSLT transforms |
| `JavaScriptCode` | Inline JavaScript | For complex JSONata evaluation |
| `Response` | HTTP response | For request-reply patterns |
| `Terminate` | End workflow | With `Succeeded`, `Failed`, or `Cancelled` status |
| `Delay` / `Delay Until` | Pause execution | For BizTalk Delay shapes |

### Preference: ServiceProvider over ApiConnection

**Always** prefer `ServiceProvider` type with `serviceProviderConfiguration` over `ApiConnection` (managed connector) whenever a built-in equivalent exists. Built-in connectors run in-process with lower latency and no connection overhead.

### Parameterization

- For Logic Apps Standard, prefer `parameters.json` for cross-environment values.
- In `workflow.json`, reference values with `@parameters('name')`.
- In `parameters.json`, `@appsetting('name')` is the only valid expression type.
- In `connections.json`, only `@parameters(...)` and `@appsetting(...)` are valid.

### Response Payload Compose Inside Branches

When an HTTP workflow returns different payloads from `If` / `Condition` branches, emit a branch-local `Compose` immediately before each `Response` instead of inlining a large object literal directly into the `Response.body`.

Use this shape:

```json
{
  "Route_Validation_Outcome": {
    "type": "If",
    "actions": {
      "Compose_Confirmation": {
        "type": "Compose",
        "inputs": {
          "correlationId": "@coalesce(triggerOutputs()?['headers']?['x-correlation-id'], guid())",
          "purchaseOrderNumber": "@body('Parse_PO')?['purchaseOrderNumber']",
          "confirmationStatus": "accepted",
          "message": "Purchase order accepted for processing.",
          "receivedAtUtc": "@utcNow()"
        },
        "runAfter": {}
      },
      "Reply_Accepted": {
        "type": "Response",
        "kind": "http",
        "inputs": {
          "statusCode": 200,
          "headers": {
            "X-Correlation-Id": "@outputs('Compose_Confirmation')?['correlationId']"
          },
          "body": "@outputs('Compose_Confirmation')"
        },
        "runAfter": {
          "Compose_Confirmation": ["Succeeded"]
        }
      }
    }
  }
}
```

Rules:

- Prefer descriptive action names such as `Compose_Confirmation`, `Compose_ValidationError`, `Reply_Accepted`, `Reply_Rejected` over generic names like `buildConfirmation`.
- For the **first action inside a nested branch**, use `runAfter: {}`. Do **not** point the nested action directly at a pre-branch action unless that dependency lives in the same nested `actions` object.
- Keep the `Compose.inputs` payload as a plain object literal with expressions per field. This is valid Logic Apps JSON and has proven more designer-friendly than some improvised variants.
- Have the `Response` reference `@outputs('<ComposeName>')` for both the body and any derived headers.

---

## 3. SplitOn over ForEach

When a **message-batch** trigger returns an array of independent messages, use `splitOn` on the trigger instead of wrapping actions in a `For_each` loop:

```json
"triggers": {
  "myTrigger": {
    "splitOn": "@triggerOutputs()?['body']",
    ...
  }
}
```

SplitOn debatches the array so each item fires a separate workflow run. Only use `For_each` if splitOn is not supported by that trigger type.

### 3.1 Where `splitOn` is allowed (HARD rules — validated at runtime/unit-test)

- ✅ **Message-batch triggers only:** Service Bus `receiveQueueMessages` / `receiveTopicMessages`, Event Hubs `receiveEvents`, Azure Queue `receiveQueueMessages`. These return a true array of independent messages.
- ❌ **NEVER on file triggers** — FTP `whenFtpFilesAreAddedOrModified`, FileSystem `whenFilesAreAdded`/`whenFilesAreAddedOrModified`, SFTP/Blob file triggers. These return per-file metadata, not a message batch; `splitOn` on them fails workflow creation (`System.NotImplementedException: The method or operation is not implemented`). The file trigger already fires once per detected file — process the single file directly (read content via §5, then transform/route). Do NOT add `splitOn`, and do NOT wrap the body in `For_each` either.
- ⚠️ **`splitOn` requires a `Stateful` workflow.** A `Stateless` workflow with `splitOn` fails validation: *"The 'splitOn' property is not supported in stateless workflow."* If a flow is genuinely a stateless passthrough, it must NOT use `splitOn`; if debatching is required, make the workflow `Stateful`.
- ⚠️ **Any flow with a polling / non-Request trigger MUST be `Stateful` — NEVER `Stateless`.** Stateless workflows in Logic Apps Standard support ONLY a `Request` (HTTP) trigger; a polling service-provider trigger (FTP/FileSystem/SFTP/Blob "when a file is added", Service Bus, timer/recurrence, etc.) on a stateless workflow does not register. **Do NOT mark a file-trigger passthrough (e.g. FTP→FTP) stateless** — that was a prior defect: at runtime the host raises `WorkflowProcessingFailed ... 'The method or operation is not implemented.'` (verified). Stateless is permitted ONLY for a synchronous HTTP Request/Response flow. See §4.1.

---

## 4. File System Trigger & Path Semantics

- Do **NOT** add delete/remove/cleanup actions that remove the trigger input file by default.
- The runtime does not re-trigger on the same unchanged file, so deleting is unnecessary unless the user explicitly requests archival/deletion behavior.
- **Logic Apps Standard runs on a Linux WS host — use forward-slash `/` paths everywhere.** Build FileSystem `filePath` with `/` joins (`concat(parameters('outFolder'), '/', name)`), NOT Windows `\`. **Never carry a source Windows absolute path (`C:\BiztalkApp\Input`, `C:\PurchaseFlowPorts\ErrorPort`) into a workflow parameter `defaultValue` or a `filePath`** — re-point it to the deployed mount-relative path (e.g. `xml-mapping/Input`, `purchase-errors/ErrorPort`) per FR-26. This applies to the workflow's `definition.parameters` `defaultValue`s too, not just `parameters.json`. A `\` separator or a `C:\` path on the Linux host produces a malformed path that won't resolve under the mount root (Major correctness finding).
- Every FileSystem `filePath` MUST resolve **under** the connection's `rootFolder` (see `connections-json-generation-rules` §3.4 and `logicapp-cloud-deployment` §5 — the root is a single subdirectory of `/mounts`, common ancestor of all FileSystem RELATIVE paths).

### 4.1 ⚠️ The native file-added service-provider trigger fails to register at runtime [VERIFIED — deployed runtime]

The FTP/FileSystem/SFTP/Blob **"when a file is added or modified" service-provider triggers do NOT register in the deployed Logic Apps Standard runtime** — the host raises `WorkflowProcessingFailed: Workflow '<name>' validation and creation failed. Error: 'The method or operation is not implemented.'` (the same `GetFunctionTriggerType()` `NotImplementedException` that makes these triggers non-executable in the unit-test host — see `logic-apps-standard-testing` §5a). Verified 2026-05-31 on runtime 4.849.100.26208 / Workflows bundle `[1.*, 2.0.0)`: the 3 file-trigger flows failed to load; the HTTP-Request and Service-Bus-`receiveQueueMessages` flows loaded fine.

**Rule — for file intake, do NOT emit the native `whenFtpFilesAreAddedOrModified` / `whenFilesAreAddedOrModified` trigger as the workflow trigger.** Use a **Stateful** workflow with one of these intake patterns instead:
- **`Recurrence` trigger + a "list files" action + `For_each` over the list + `getFtpFileContentV2`/`getFileContentV2`** per file (schedule-based polling — the reliable, runtime-supported equivalent of file-added polling).
- **Event-driven**: for Blob, an Event Grid (`Microsoft.Storage.BlobCreated`) trigger; for FTP/SFTP landing zones, drop the file to Blob/Service Bus first and trigger off that.

This is an IR/compiler design rule, not just a test concern: a flow whose source is a file-drop/FTP poll must compile to the stateful Recurrence+list pattern, and `azure-logic-apps-compiler` must mark such flows `Stateful`. (Until the compiler emits this pattern, file-intake flows deploy but their trigger will not register — track as a known limitation.)

---

## 5. Trigger Output Verification (MANDATORY)

> **⚠️ NEVER assume a trigger returns file/message content directly. ALWAYS verify what the trigger actually returns.**

Many triggers return **metadata** (file path, message ID, blob URI) rather than the actual content. You MUST check the trigger's return type from the reference workflow before building downstream actions.

### 5.1 Procedure

1. After selecting a trigger via reference lookup (§1), read the reference workflow AND the reference docs to see what `triggerOutputs()` or `triggerBody()` actually contains.
2. Search reference documentation for the trigger's connector name to find its output schema and return type.
3. If the trigger returns a **file path** (e.g. File System `whenFilesAreAdded` returns `path` and `name`), you MUST add a separate **read content** action (e.g. `getFileContent`) before any parsing/processing.
4. If the trigger returns **message content directly** (e.g. HTTP Request trigger, Service Bus `receiveQueueMessage`), you can use `triggerBody()` directly.

### 5.2 Common Trigger Return Types

| Trigger                                     | Returns                          | Content Available Via                       |
|---------------------------------------------|----------------------------------|---------------------------------------------|
| File System `whenFilesAreAdded`             | File metadata (path, name, size) | Add `getFileContentV2` action with the path |
| File System `whenFilesAreAddedOrModified`   | File metadata (path, name, size) | Add `getFileContentV2` action with the path |
| Azure Blob `whenABlobIsAddedOrModified`     | Blob metadata (path, URI)        | Add `readBlob` action with the path         |
| FTP `whenFtpFilesAreAddedOrModified`        | File metadata                    | Add `getFtpFileContentV2` action with the path |
| SFTP `whenFilesAreAddedOrModified`          | File metadata                    | Add `getFileContentV2` action with the path |
| HTTP Request                                | Full request body                | `triggerBody()` directly                    |
| Service Bus `receiveQueueMessages`          | Message content + properties     | `triggerBody()?['contentData']` directly    |

> Exact `operationId`s for every connector live in the `logic-apps-builtin-connectors` skill — this table is a quick reminder, that skill is authoritative.
| Recurrence / Timer                          | No body                          | N/A — use actions to fetch data             |

### 5.3 Rule

- **If trigger returns metadata/path**: Add a content-reading action BEFORE any XmlParse, Parse JSON, Compose, or processing action.
- **If trigger returns content directly**: Use `triggerBody()` or `triggerOutputs()?['body']` in downstream actions.
- **If unsure**: Check BOTH the reference workflow AND the reference docs. If the reference workflow has a read-content action after the trigger, you need one too.

---

## 6. 1:1 Orchestration to Workflow Rule

- Every BizTalk orchestration (including sub-orchestrations) MUST be a separate workflow.
- Use the `Workflow` / `InvokeWorkflow` action type to invoke child workflows from parent workflows.
- Do NOT convert orchestrations to local functions.
- Do NOT merge multiple orchestrations into a single workflow.

---

## 7. Plan Adherence

When fixing any errors in workflow.json:

- Do NOT deviate from the planned design.
- Do NOT add/remove actions, change triggers, switch connectors, or alter schemas beyond the plan.
- Before any fix, re-read the planning results to verify compliance.
- If a fix requires changing the design, STOP and report to the user.

---

## 7a. Source Design Preservation (BizTalk path)

> **⚠️ MANDATORY DESIGN PRESERVATION RULE:** Do NOT independently simplify, optimize, refactor, merge, reorder, or redesign the BizTalk flow when generating its Logic Apps target. The target workflow MUST preserve the **same source design and execution intent** unless there is a documented platform gap (recorded in `review-report.md` / IR `gaps`) or the user explicitly asked for a redesign.

- Preserve the original orchestration boundaries, call structure, branching shape, sequencing, message-construction pattern, and helper/local processing decomposition as closely as Logic Apps permits.
- Do NOT combine separate source steps into one target step merely because it looks simpler, unless the source already treated them as one logical unit or an unavoidable platform limitation requires it.
- Do NOT remove intermediate steps, wrapper/message-construction steps, helper calls, or transformation stages unless they are explicitly proven redundant from the source behaviour.
- If any deviation from source design is unavoidable, document it explicitly in the IR `gaps[]` block and in the matching action mapping, with the exact reason.

---

## 7b. Component Priority Ladder (with custom-code override)

> **⚠️ MANDATORY OVERRIDE — READ THIS FIRST:**
> Source custom code — scripting functoids, external assemblies (`.dll`), custom pipeline components, helper libraries, map extension objects — MUST **ALWAYS** map to **.NET local functions** (level 5). Do NOT simplify custom code to expressions, inline code, `Compose` + `concat`, or any other level. This rule overrides the ladder below. The conversion agent MUST translate the real business logic from source or decompiled code — never a stub, never an expression approximation.

For all **other** (non-custom-code) components, follow this deterministic ladder for action selection. Pick the **highest applicable level** without asking the user:

| Level | Choice | Use when |
|---|---|---|
| 1 | **Built-in actions** — `XmlParse`, `XmlCompose`, `XmlValidation`, `Xslt`, `Compose`, `Parse JSON`, `Select`, `FlatFileDecoding`, `FlatFileEncoding` | A built-in covers the operation natively |
| 2 | **Workflow expressions** — `@concat()`, `@add()`, `@if()`, `@xpath()` | Trivial scalar computations only; never when a built-in covers it |
| 3 | **Data Mapper / Liquid** | Field-to-field mapping that does not need .NET |
| 4 | **Inline Code** (`JavaScriptCode`) | Moderate logic that does not warrant a project reference |
| 5 | **.NET local function** (`InvokeFunction`) | Complex .NET logic, custom code from source, custom pipeline components |
| 6 | **Azure Functions** (separate function app) | Truly external services — last resort |

Key rules:

- Every orchestration (source `type=orchestration`) MUST map to its own Logic Apps workflow — NEVER to a local function. See §6.
- Sub-orchestrations → child workflows invoked via `Workflow` / `InvokeWorkflow`.
- **XML processing rule**: for any XML parsing, validation, or structured access pattern, ALWAYS use the built-in XML Operations (`XmlParse`, `XmlValidation`, `XmlCompose`, `Xslt`) over `xpath()` or string manipulation. `XmlParse` validates and returns structured JSON; `xpath()` skips validation and is verbose.
- A `.NET local function` is **native** (`isLogicAppsNative=true`) to LA Standard. A `custom built-in connector` is NOT.

---

## 8. Scenario-Specific Action Overrides

These overrides are deterministic — apply them directly without asking the user.

### 8.1 XML Field Extraction

When extracting fields from an XML document:

- Use `XmlParse` built-in action with a schema — do NOT use `xpath()` expression when a schema exists.
- The `XmlParse` action exposes typed fields as tokens in the designer, which makes subsequent actions cleaner.

### 8.2 XML Schema Validation

When validating XML against a schema:

- Use `XmlValidation` built-in action — do NOT use custom code or skip validation.
- Reference schemas from `Artifacts/Schemas/` (Logic App artifacts) or Integration Account.

### 8.3 XML Transformation

When transforming XML documents:

- Use `Xslt` (Transform XML) built-in action with maps from `Artifacts/Maps/` for XML-native transforms — do NOT use `Compose` + string manipulation.
- For BizTalk `.btm` maps, the converted XSLT file goes in `Artifacts/Maps/`. For greenfield declarative transforms, Data Mapper artifacts live under `Artifacts/DataMapper/` and Liquid templates live under `Artifacts/Liquid/`.

### 8.3a JSON contract with XML-native transform

When the external contract is JSON **but** the runtime/native artifacts are XML (for example, `messages[].format: json` with an `x-xsdRef` / `nativeSchemaRef` and a `mappings[].engine: xslt` BizTalk map), you MUST insert an explicit bridge around the XML-native transform:

1. `XmlCompose` — convert inbound JSON to the XML shape defined by the request XSD.
2. `Xslt` or other XML-native action — run the BizTalk-derived XML transform against the composed XML.
3. `XmlParse` — convert the XML result back to structured JSON using the response XSD before returning JSON to the caller.

Rules:

- Do NOT pass raw JSON directly into an `Xslt` action that expects an XML root element.
- Do NOT return raw XML with `Content-Type: application/json`.
- Do NOT drop the `nativeSchemaRef` / XSD just because the public contract is JSON. In this hybrid case the XSD remains the runtime contract for the XML-native steps.
- Prefer the explicit bridge even when the JSON shape resembles the XML shape closely. The XSLT root match and namespace handling still require real XML.

### 8.4 Output XML Construction

When constructing/assembling XML output:

- Use `XmlCompose` action (Source: LogicApp or IntegrationAccount) — do NOT use `Compose` + `concat()` for XML construction.

### 8.5 EDI Decode Output Handling

> **⚠️ Sev-1 — runtime failure if missed.** The built-in `X12Decode` and `EdifactDecode` actions return **JSON** (a structured representation of the EDI document), NOT XML. Any downstream action that expects XML — `Xslt`, `XmlValidation`, `XmlParse`, an `InvokeFunction` calling `XmlDocument.LoadXml(...)`, or a BizTalk-derived map — will fail at runtime with `Data at the root level is invalid` or schema-binding errors.

Required pattern when the next consumer needs XML:

1. `EdifactDecode` (or `X12Decode`) — returns JSON.
2. `XmlCompose` — converts the decoded JSON back to the XML shape declared by the message schema. Reference the message's XSD via `Artifacts/Schemas/<Name>.xsd` (Source: `LogicApp`) or via Integration Account.
3. Downstream `Xslt` / `XmlValidation` / `InvokeFunction` consumes the composed XML.

Do NOT pass `body('EdifactDecode')` or `body('X12Decode')` directly into an XML-expecting action. Do NOT attempt to coerce the JSON with `xml(...)` expression — the BizTalk EDI schema namespaces and element ordering require a real `XmlCompose` against the typed schema.

If the downstream consumer is JSON-native (e.g. `Parse JSON`, a JSON `Compose`, a REST `Http` call with `application/json`), the `XmlCompose` bridge is unnecessary — pass the decode output directly.

### 8.6 JSON Parsing

When parsing JSON payloads:

- Use `Parse JSON` built-in action — do NOT use `json()` expression for structured access.
- `Parse JSON` exposes typed tokens for all properties, making downstream references cleaner and designer-friendly.

### 8.7 InvokeFunction retry policy

> **Rule**: Every `InvokeFunction` action that calls into a .NET local function MUST declare an explicit `retryPolicy` on its `inputs`. The Logic Apps runtime's default policy is "no retry" for `InvokeFunction`, so a missing `retryPolicy` means a transient exception (network blip, dependent-service 5xx, brief lock contention) becomes a workflow failure.

Default retry policy — copy verbatim from `templates/azure/reference-workflows/invoke-function-retry/workflow.json`:

```json
"<ActionName>": {
  "type": "InvokeFunction",
  "inputs": {
    "functionName": "<FunctionName>",
    "parameters": { "input": "@triggerBody()" },
    "retryPolicy": {
      "type": "exponential",
      "count": 4,
      "interval": "PT10S",
      "minimumInterval": "PT5S",
      "maximumInterval": "PT1H"
    }
  },
  "runAfter": {}
}
```

Tuning:

- `count`: 4 covers ~5 attempts total (initial + 4 retries) — sufficient for transient cloud failures. Increase to 6-8 only when the IR `nonFunctionals.retry.maxAttempts` says so.
- `interval`: `PT10S` is the **base** — exponential backoff doubles each attempt (10s, 20s, 40s, 80s).
- `type: exponential` is the default; use `type: fixed` only when the dependent system requires regular spacing (rare).
- `type: none` is forbidden unless the IR explicitly declares the action non-retryable AND the calling flow has its own outer retry/scope.

Anti-patterns:

- Omitting `retryPolicy` entirely (= no retry) — Sev-2.
- Setting `count: 1` "to be safe" — defeats the purpose; use `type: none` instead and document the reason.
- Wrapping the `InvokeFunction` in a `Scope` with `runAfter: Failed` and a manual retry loop — the platform retry is correct; manual loops re-invoke without backoff.

### 8.8 Retry policy on EVERY external hop (ServiceProvider, ApiConnection, Http)

`retryPolicy` is **not** just for `InvokeFunction`. **Every action that crosses a trust boundary MUST carry a `retryPolicy` in its `inputs`, mapped from the flow's IR `errorHandling.retry`** — this includes all `ServiceProvider` actions (FTP `getFtpFileContentV2`/`createFile`, FileSystem read/create, **Service Bus `sendMessage`**, **SQL `executeQuery`/`insertRow`**), `ApiConnection` connectors, and external `Http` calls. Same shape as §8.7:

```json
"retryPolicy": { "type": "exponential", "count": 4, "interval": "PT5S" }
```

Map the IR `errorHandling.retry` (`policy`/`maxAttempts`/`interval`) onto these fields. Triggers do not take a retryPolicy. Skip only when the IR explicitly declares the channel non-retryable (e.g. a one-shot send with an idempotency concern). **Omitting `retryPolicy` on a ServiceProvider/Http/ApiConnection action when the IR declares retry is a Critical review finding (Article VI)** — `azure-reviewer` checks every external hop, not just `InvokeFunction`. See `logic-apps-resilience-observability` skill §1.

### 8.9 Request trigger `relativePath` — sanitize placeholders

A `Request` trigger's `inputs.relativePath` (and any `{placeholder}` path segment) may contain **only letters, digits, and `_`** — **`-` (hyphen) is INVALID**. A literal segment carried over from a source path (or copied from a hyphenated public route / OpenAPI path like `/purchase-order`) that contains `.`, `-`, or other characters fails workflow creation AND is rejected by the unit-test host: *"The value 'purchase-order' provided in property 'inputs.relativePath' ... The placeholder 'purchase-order' has these invalid characters '-'. The placeholder can only be a letter, digit, or '_'."* (verified — `RunWorkflowAsync` throws `UnitTestWorkflowTemplateValidationError`).

When deriving the route from a BizTalk receive-location URL (e.g. `BTSHTTPReceive/BTSHTTPReceive.dll`) or from a hyphenated OpenAPI path, **sanitize it**: drop file extensions and replace every illegal char — including `-` — with `_`. Correct results: `purchase-order` → `purchase_order`, `make-purchase` → `make_purchase`, `BTSHTTPReceive/BTSHTTPReceive.dll` → `btshttpreceive`. **Do NOT emit `purchase-orders` or any value containing `-`.** Alternatively, if no parameterized routing is needed, OMIT `relativePath` entirely (the workflow is reachable at its default `/api/<workflowName>/...` route; the hyphenated public path is shaped by APIM/gateway, not the trigger). Record the original source path in a comment in the run summary, not in `relativePath`. The published OpenAPI path may keep hyphens (`/purchase-order`); the LA trigger `relativePath` may not — they are allowed to differ (the gateway maps between them).

---

## 9. Pre-Finalize Validation Checklist

Before storing workflow definitions, cross-check EVERY action against this table. If ANY row in the "DON'T" column matches your output, fix it before proceeding.

| Scenario                      | DO (correct)                                                   | DON'T (wrong — fix before storing)                          |
|-------------------------------|----------------------------------------------------------------|-------------------------------------------------------------|
| Trigger output assumption     | Verify trigger return type from reference                      | Assume trigger returns file/message content directly        |
| File/Blob/FTP trigger         | Add `getFtpFileContentV2`/`getFileContentV2`/`readBlob` after trigger | Use `triggerBody()` for content (it only has metadata) |
| `splitOn`                     | Only on Service Bus/Event Hubs/Queue batch triggers; flow Stateful | `splitOn` on FTP/FileSystem file trigger (→ NotImplementedException); `splitOn` on a Stateless workflow |
| Retry on external hop         | `retryPolicy` on EVERY ServiceProvider/Http/ApiConnection action from IR retry | Retry only on `InvokeFunction`; ServiceProvider/SB/SQL hops with no retry (Critical) |
| Request `relativePath`        | Sanitized route — letters/digits/`_` only; replace `-`→`_` (`purchase-order`→`purchase_order`), drop extensions, OR omit `relativePath` entirely (default route + APIM shapes the public path). See §8.9 | Any `-`/`.`/`{placeholder-with-hyphen}` in `relativePath` (rejected at creation AND by the unit-test host: `UnitTestWorkflowTemplateValidationError`); copying the hyphenated OpenAPI path verbatim into `relativePath` |
| `trackedProperties` scope     | Reference ONLY this action's own inputs/outputs, the trigger, `workflow()`, and parameters (see resilience-observability §4). For a run-wide correlation id when the business key lives in a `variable`, use `@workflow()?['run']?['name']` (the run id) — null-safe bracket form. | A `trackedProperties` expression calling another action's `outputs('Other')`/`body('Other')` **or `variables('x')`** (BOTH rejected at creation AND by the unit-test host: `TrackedPropertiesEvaluationFailed` / *"Tracked properties can only reference its own action's inputs and outputs, trigger inputs and outputs and parameters"*). `variables()` is NOT in the allowed set — a generated `loadRunId`/`businessDate` variable cannot be tracked directly; reference `@workflow()?['run']?['name']` instead. Also avoid the dotted `@workflow().run.name`/`@workflow().name` form — the unit-test host throws on it; use null-safe `@workflow()?['run']?['name']` / `@workflow()?['name']`. |
| Collection filter / project   | WDL has NO lambda. Filter a collection with a **`Query`** action (Filter array: `inputs.from` + `inputs.where` using `item()`); project/map fields with a **`Select`** action (`inputs.from` + `inputs.select`). Reference results via `body('Filter_x')` / `length(body('Filter_x'))` / `body('Select_x')`. | A JavaScript-style arrow lambda inside a WDL expression — `filter(variables('xs'), x => equals(x?['k'], true))` or `map(xs, x => x?['id'])`. WDL rejects `=>` (`UnitTestWorkflowTemplateValidationError`: *"the string character '=' … is not expected"*). There is no `filter()`/`map()` lambda function in Workflow Definition Language. |
| XML field extraction          | `XmlParse` action + schema                                    | `xpath()` expression when schema exists                     |
| XML validation                | `XmlValidation` action                                         | Skip validation or use custom code                          |
| XML transformation            | `Xslt` action + map file                                       | `Compose` + string concat                                   |
| JSON ↔ XML XSLT bridge        | `XmlCompose` → `Xslt` → `XmlParse` when contract is JSON but map/native schema is XML | Raw JSON into `Xslt` or raw XML returned as JSON            |
| XML output assembly           | `XmlCompose` action (Source: LogicApp or IntegrationAccount)   | `Compose` + `concat()` for XML                              |
| EDI decode → XML needed       | Add `XmlCompose` after `EdifactDecode`/`X12Decode`             | Pass JSON decode output directly to XML-expecting code      |
| Complex XML with .NET logic   | .NET local function                                             | `Compose` + `concat()` approximation                        |
| JSON parsing                  | `Parse JSON` action                                             | `json()` expression for structured access                   |
| Array trigger debatching      | `splitOn` on trigger                                            | `For_each` loop wrapping all actions                        |
| File trigger cleanup          | Do nothing (no delete)                                          | Delete/archive trigger input file                           |
| Sub-orchestration             | Separate workflow + `Workflow` action                           | Merge into parent or local function                         |
| Custom source code            | .NET local function                                             | Expressions or inline approximation                         |
| InvokeFunction retry          | Explicit `retryPolicy` (`exponential`, `count: 4`, `interval: PT10S`) on every `InvokeFunction.inputs` per §8.7 | Omit `retryPolicy` (default = no retry → transient failure becomes workflow failure) |
| Connector preference          | ServiceProvider (built-in)                                      | ApiConnection when built-in exists                          |
| Artifacts cross-reference     | Every Logic App artifact reference resolves on disk at the correct path: XSLT maps at `Artifacts/Maps/X.xsl`, Data Mapper artifacts at `Artifacts/DataMapper/X.lml`, Liquid templates at `Artifacts/Liquid/X.liquid`, and schemas at `Artifacts/Schemas/Y.xsd` | Reference a transform/schema artifact name with no corresponding file under `Artifacts/` (workflow 404s at runtime — Sev-1, fail-closed) |

---

_Adapted from the [Azure Logic Apps Migration Agent](https://github.com/Azure/logicapps-migration-agent) reference material._
