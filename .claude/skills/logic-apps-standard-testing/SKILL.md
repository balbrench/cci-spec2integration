---
name: logic-apps-standard-testing
description: Authoritative SDK contract and authoring rules for Logic Apps Standard unit tests (Microsoft.Azure.Workflows.UnitTesting / WebJobs.Tests.Extension, MSTest). Covers the exact ActionMock / TriggerMock / TestErrorInfo / UnitTestExecutor API, valid ErrorResponseCode members, which action types cannot be mocked, mock-output shapes per connector, happy-path coverage rules, parameters.json requirements, and the no-parallel-assemblies constraint. Consumed by azure-workflow-tester. Bundles the official Microsoft Test Framework reference docs under reference/.
---

# logic-apps-standard-testing skill

Authoritative grounding for generating Logic Apps Standard unit tests that **compile and pass on the first run**. The bundled `reference/` docs are the source of truth (mirrored from Microsoft Learn); this SKILL.md distils them into hard rules plus the gotchas the official docs don't state.

> **Provenance tags** below: **[DOC]** = stated in `reference/`; **[VERIFIED]** = confirmed by reflecting the shipped SDK assemblies and/or running the SDK in this repo (not documented, but real).

## reference/ contents

- `reference/Test Framework/` — the 16 official SDK class-definition docs (`action-mock-class-definition.md`, `test-error-info-class-definition.md`, `unit-test-executor-class-definition.md`, `test-workflow-status-enum-definition.md`, `trigger-mock-class-definition.md`, `test-workflow-run-*.md`, etc.). **Read `action-mock-class-definition.md` and `test-error-info-class-definition.md` before writing any mock.**
- `reference/How To/` — `test-logic-apps-mock-data-static-results.md`, `create-unit-tests-standard-workflow-definitions-visual-studio-code.md`, `create-unit-tests-standard-workflow-runs-visual-studio-code.md`.

## 1. The `ActionMock` / `TriggerMock` API contract [DOC: action-mock-class-definition.md]

**Namespace:** `Microsoft.Azure.Workflows.UnitTesting.Definitions`.

There are exactly three *public* constructors. Pass outputs **XOR** error — **there is no public 4-arg `(status, name, outputs, error)` constructor**; that overload is `internal` (JSON deserialization only). Calling it is the single most common generation bug.

```csharp
// Success with static outputs
public ActionMock(TestWorkflowStatus status, string name = null, MockOutput outputs = null)

// Failure with error info
public ActionMock(TestWorkflowStatus status, string name = null, TestErrorInfo error = null)

// Dynamic, status chosen at run time from execution context
public ActionMock(Func<TestExecutionContext, ActionMock> onGetActionMock, string name = null)
```

Properties `Name`, `Status`, `Outputs` (JToken), `Error` (TestErrorInfo) are all **get/set** [DOC]. So a single subclass that must support both success and failure has two clean options — **do not** invent a combined ctor:

```csharp
// Option A — status-conditional via the property (simplest for generated subclasses)
public sealed class SendFileActionMock : ActionMock
{
    public SendFileActionMock(TestWorkflowStatus status = TestWorkflowStatus.Succeeded,
                              SendFileMockOutput? outputs = null)
        : base(status, "Send_File",
               status == TestWorkflowStatus.Succeeded ? (outputs ?? new SendFileMockOutput()) : null)  // Failed ⇒ pass null outputs
    {
        if (status is TestWorkflowStatus.Failed or TestWorkflowStatus.TimedOut)
            this.Error = new TestErrorInfo(ErrorResponseCode.ServiceProviderActionFailed,
                                           "Simulated failure of 'Send_File' to exercise the error/DLQ branch.");
    }
}

// Option B — the callback ctor (when behaviour depends on inputs)
var mock = new ActionMock(ctx => /* return a success or failure ActionMock */, "Send_File");
```

## 2. `TestErrorInfo` [DOC: test-error-info-class-definition.md]

- **Namespace:** `Microsoft.Azure.Workflows.UnitTesting.ErrorResponses` — **not** `...Definitions`. Add `using Microsoft.Azure.Workflows.UnitTesting.ErrorResponses;`.
- ctor: `public TestErrorInfo(ErrorResponseCode code, string message, TestErrorInfo[] details = null, TestErrorResponseAdditionalInfo[] additionalInfo = null)` — the last two args are optional, so `new TestErrorInfo(code, message)` is valid.

## 3. `ErrorResponseCode` [VERIFIED]

- **Namespace:** `Microsoft.Azure.Workflows.Common.ErrorResponses` (a *different* assembly/namespace from `TestErrorInfo`). Add `using Microsoft.Azure.Workflows.Common.ErrorResponses;`.
- It is a large enum (~1390 members) but the member set is build-specific. **Confirmed-valid in the shipped assembly (use these):** `ServiceProviderActionFailed`, `ServerTimeout`, `BadRequest`, `InternalServerError`. Prefer `ServiceProviderActionFailed` for connector failures, `BadRequest` for validation/4xx, `InternalServerError` for 5xx, `ServerTimeout` for timeouts.
- **Confirmed-INVALID (do NOT use — they cause `CS0117 does not contain a definition`):** `RequestTimeout`, `None`, `ValidationError`. (The Microsoft doc examples show `ValidationError`/`NotFound`, but those are NOT present in the shipped `Microsoft.Azure.Workflows.Common.ErrorResponses.ErrorResponseCode` build — do not trust the doc examples for enum membership; stick to the confirmed-valid four unless you reflect the assembly to confirm another.)

## 4. `TestWorkflowStatus` [DOC: test-workflow-status-enum-definition.md]

Members: `Succeeded`, `Skipped`, `Cancelled`, `Failed`, `TimedOut`. **Mocks may only use `Succeeded` or `Failed`** [DOC: mock-data static-results — "You can create mock operations with only the Succeeded and Failed statuses"]. Use `TimedOut` only if a manifest explicitly supports it; prefer `Failed` + a `ServerTimeout` `TestErrorInfo` for timeout simulation.

## 5. Which actions **cannot** be mocked

The SDK throws `"the '<name>' action can't have a mock result. Actions with '<Type>' type don't support mock results"` for certain operation types. Do **not** put these in the `actionMocks` dictionary; let them execute.

- **Control / flow:** `If`, `Switch`, `Foreach`, `Until`, `Scope`, `Parallel`, and terminal `Response`. [DOC + VERIFIED]
- **Inline data-shaping built-ins:** `XmlCompose`, `XmlParse`, `Compose`, `ParseJson`, `Query`, `Select`, `Table` and similar expression-only actions. **[VERIFIED — `XmlCompose`/`XmlParse` confirmed in this repo's run]**. These run deterministically on their inputs; mocking them is rejected.

Mockable types include: `ServiceProvider` (FTP / FileSystem / Service Bus / SQL / etc.), `Http`, `InvokeFunction`, `Workflow` (child invoke), `Xslt` (the transform output **is** mockable — see §6), and managed `ApiConnection`.

## 5a. File-trigger flows are NOT executable in the unit-test host [VERIFIED — critical]

The unit-test host **cannot create a workflow whose trigger is a file-based service-provider trigger.** FTP `whenFtpFilesAreAddedOrModified`, FileSystem `whenFilesAreAdded`/`whenFilesAreAddedOrModified`, and (by the same mechanism) SFTP/Blob file triggers throw at workflow creation:

```
System.NotImplementedException: The method or operation is not implemented.
   at Microsoft.Azure.Workflows.ServiceProviders.Ftp.Extension.Providers.FtpServiceOperationsTriggerProvider.GetFunctionTriggerType()
```

`GetFunctionTriggerType()` is unimplemented in the shipped trigger providers, so `RunWorkflowAsync` fails before any action runs — **no amount of mocking helps.** Triggers that DO work in the unit-test host: **HTTP `Request`** and **Service Bus `receiveQueueMessages`** (and other message-batch triggers).

**Rule:** For a flow whose trigger is FTP/FileSystem/SFTP/Blob, do **NOT** generate an execution test (`RunWorkflowAsync`). Instead:
1. Emit a **structural test** that loads `app/<Flow>/workflow.json` and asserts the wiring — trigger `operationId`/`serviceProviderId`, the content-read action, the transform/route actions, each external action's `retryPolicy`, and the DLQ `runAfter` — without executing the workflow.
2. Note in the test class XML-doc and the run summary that runtime behaviour for this flow is validated via the `runtime-validation-and-testing` skill (`func start` + Azurite/real endpoint), not the unit-test SDK.
3. Still generate full execution tests for the flow's HTTP/Service-Bus-triggered siblings.

This is an SDK limitation for the unit-test host — but see the next paragraph: the same exception ALSO occurs in the deployed runtime, which IS a workflow-design concern.

> **⚠️ UPGRADE [VERIFIED at runtime 2026-05-31]:** the identical `GetFunctionTriggerType` `NotImplementedException` occurs in the **deployed Logic Apps Standard runtime**, not only the unit-test host. A flow that uses the native `whenFtpFilesAreAddedOrModified` / `whenFilesAreAddedOrModified` service-provider trigger fails to load with `WorkflowProcessingFailed ... 'The method or operation is not implemented.'`. So "validate via runtime E2E" does NOT rescue the native file trigger — the trigger never registers. The fix is a **compiler/IR design change**: file-intake flows must compile to a **Stateful `Recurrence` + list-files + per-file `getFileContentV2`** pattern (or an Event Grid/Blob-event trigger), per `workflow-json-rules` §4.1. Until then, file-intake flows are a known runtime limitation. The structural test above still applies; the E2E validation target becomes the Recurrence-based intake, not the native file trigger.

## 6. Mock output shapes per connector [VERIFIED]

The SDK validates output shape per operation type. Wrong shapes throw at run time.

- **Failed/TimedOut mocks carry NO `outputs`** — only `Error`. A Failed mock that still has outputs throws `"the '<X>' mock action shouldn't have the 'outputs' field defined when the status is 'Failed'"`. Pass `null` outputs for the non-success branch (see §1 dual-mode ctor).
- **`MockOutput` is a BARE marker class** [VERIFIED] — in the shipped SDK it has a **parameterless ctor and NO public properties** (no `Body`, `Headers`, or `StatusCode`). `new MockOutput { Body = ... }` does **NOT compile** (`CS0117: 'MockOutput' does not contain a definition for 'Body'`) — the Microsoft doc example showing `new MockOutput { StatusCode=…, Headers=…, Body=… }` is wrong for this build. **To supply outputs you MUST subclass `MockOutput` and declare the fields you need**; the subclass's public properties serialize into the action's `outputs` JToken:
  ```csharp
  public sealed class GetFileContentMockOutput : MockOutput { public JToken? Body { get; set; } }
  // ...
  : base(status, "Get_File_Content",
         status == TestWorkflowStatus.Succeeded ? new GetFileContentMockOutput { Body = "<Order/>" } : null)
  ```
  Declare one `*MockOutput : MockOutput` subclass per action (add `Headers`/`StatusCode : int?` only when the action actually surfaces them, e.g. HTTP). Never instantiate the bare `MockOutput` with an initializer.

- **`Xslt` (Transform) action** — `outputs.body` MUST be a **valid JSON object** (a `JObject`/`JToken`), never a bare XML string. Wrap the transformed markup, e.g. `new JObject { ["content"] = "<Root>…</Root>" }`. (`OperationMockValidation.XsltOutput` rejects a non-JSON body.)
- **`ServiceProvider` read (e.g. `getFtpFileContentV2`, `getFileContentV2`)** — a raw string body is accepted (downstream `xml(body(...))` / `xpath(...)` expect a string).
- **`InvokeFunction`** — `outputs.body` is the function's return value as a valid JSON object/array; it is read by `body('<Action>')`. Match the local function's actual return contract.
- **`Workflow` (child invoke)** — `outputs.body` is the child workflow's response payload.
- **Service Bus `sendMessage` / SQL `executeQuery`** — provide the result shape the downstream expressions read (e.g. `body('Send_Header_Insert')?['resultSets']?['Table1']`).

## 7. Happy-path coverage rule [VERIFIED]

`"An action failed. No dependent actions succeeded"` means an action on the executed path was **not mocked**, so it ran for real, failed, and cascaded. **Every mockable action on a test's success path must have a `Succeeded` mock with valid outputs** — especially every `InvokeFunction` and child `Workflow` action. Mock the leaf/outbound actions and every dependency they `runAfter`. Do **not** mock the control/inline actions from §5 (let them evaluate).

### 7a. EVERY mockable action in the workflow must be mocked — including the DLQ / error-Scope actions [VERIFIED]

> **⚠️ The SDK validates mocks for the WHOLE workflow before it runs, not just the success path.** `RunWorkflowAsync` throws `UnitTestMissingRequiredMockedActionError`: *"The unit test is missing a mock action for the '<name>' source action in the workflow. A unit test requires mocks for operations of type 'ServiceProvider'."* if **any** `ServiceProvider` / `InvokeFunction` / `Workflow` action anywhere in the definition lacks a mock — even an action that sits in a `runAfter: [Failed, TimedOut]` error-handling **Scope** (e.g. `Send_To_DLQ`) that will NOT execute on the happy path.

This is the single most common executable-test failure on flows generated by this pack, because every flow wraps its body in a Scope and adds a `Send_To_DLQ` Service Bus `sendMessage` action for Article VI. Rules:

- For **every** executable test (happy AND error path), enumerate **all** `ServiceProvider`, `InvokeFunction`, `Workflow`, **`Xslt`**, and **`Http`** actions in `app/<Flow>/workflow.json` — including those nested inside the DLQ/error Scope, branch `actions`/`else` blocks, and `Foreach`/`Until` bodies — and give each one an `actionMock`. The SDK **requires** a mock for `Xslt` too (`"A unit test requires mocks for operations of type 'Xslt'"` — verified), exactly like `ServiceProvider`. Do not reason "it's on the branch that won't run, so I'll skip it"; the validator does not care whether the action executes, only that a mock exists.
- **`XmlCompose` / `XmlParse` / `Compose` / `ParseJson` are NON-mockable (§5) — do NOT add a mock for them.** Mocking one throws `UnitTestUnsupportedMockedAction`: *"the '<name>' action can't have a mock result. Actions with 'XmlCompose' type don't support mock results"* (verified for both `XmlCompose` and `XmlParse`). They must **evaluate for real**. The trap: a schema-bound `XmlCompose`/`XmlParse` that evaluates against thin mock data then **fails its own schema validation** (`"An action failed. No dependent actions succeeded"`). You cannot mock that away — instead **shape the REQUIRED upstream mocks** (the `Xslt` / `InvokeFunction` / `ServiceProvider` actions that feed it, plus the trigger input the test controls) so the data flowing INTO the `XmlCompose`/`XmlParse` produces a schema-valid result. E.g. for a `Build_Success_Response` XmlCompose that reads `body('Get_Product')?['Price']` and `triggerBody()?[...]['customerId']`, give the `Get_Product` InvokeFunction mock a body with a correctly-typed `Price`/`Visits` and drive a valid `customerId` in the trigger mock — then let `Build_Success_Response` evaluate, and assert on the terminal `Response`/leaf status rather than the compose. This is the §7b consistency problem in its hardest form: the compose is unmockable, so its inputs must be made valid.
- The DLQ action (`Send_To_DLQ` and any per-flow error-file `createFile` in the catch Scope) gets a `Succeeded` mock on the happy path (it never fires, the mock is just to satisfy validation) and may get a `Succeeded` mock on the error path too (asserting it ran). It does NOT need a `Failed` mock.
- Concretely, a mock for the DLQ send is mandatory in the test for **every flow that has a DLQ Scope** — which, in this pack, is every flow. A test that mocks only the success-path leaves will fail with `UnitTestMissingRequiredMockedActionError` on the unmocked `Send_To_DLQ`.
- This is distinct from §7's "An action failed" cascade: that one is about an executed-but-unmocked action; this one is a pre-run validation gate over the entire definition.

Mocked action **names must exactly match** the action keys in the compiled `workflow.json` (a mismatch throws `KeyNotFoundException`). Always read `app/<Flow>/workflow.json` and copy names verbatim.

**Assertions follow the same name discipline AND a presence guard.** `run.Actions["X"]` throws `KeyNotFoundException` if action `X` did not execute on the path the test drove (e.g. it's on the branch NOT taken, or it's a `Compose`/control action the SDK doesn't surface in `run.Actions`). Rules:
- Assert only on actions that are **guaranteed to have run on that test's path**, using the **exact** `workflow.json` name.
- Prefer asserting on the **mocked leaf / ServiceProvider / InvokeFunction** action outputs (stable, present in `run.Actions`) rather than on `Compose`/`If`/`Switch` outputs (often absent or not surfaced).
- When an assertion targets an action that may or may not be present, guard it: `Assert.IsTrue(run.Actions.TryGetValue("X", out var a)); Assert.AreEqual(..., a.Outputs?[...]);` — never index `run.Actions["X"]` directly for a maybe-absent action.
- For a branch test, assert the **taken** branch's leaf ran and the **not-taken** branch's leaf is absent (`Assert.IsFalse(run.Actions.ContainsKey("<other-branch-leaf>"))` — **only if that leaf is a top-level action**; see the next bullet).
- **⚠️ `run.Actions` contains ONLY top-level actions — actions nested inside a `Scope` / `If` / `Switch` / `Foreach` are NOT present in `run.Actions` by their own name [VERIFIED].** Empirically, for a flow whose body is wrapped in a DLQ `Scope`, `run.Actions.Keys` is just the top-level set, e.g. `[Process_Scope, Return_To_Parent, Return_Error_To_Parent, Send_To_DLQ]` — `Get_Product`, the `If`, the `XmlCompose`, the branch leaves are all nested and **invisible**. **This pack wraps every flow body in a DLQ Scope (Article VI), so almost every business action is nested.** Consequences for assertions:
  - You **cannot** `run.Actions.TryGetValue("Get_Product", …)` for a Scope-nested action — it returns false even though the action ran. Asserting "the nested prefix/branch leaf ran" is impossible at this granularity.
  - Assert at the granularity the SDK exposes: the **top-level `Scope`** action (`Process_Scope` / `<Flow>_Scope`), the top-level `Send_To_DLQ`, and the terminal `Response`. On a genuine happy path the `Scope` is `Succeeded` and `Send_To_DLQ` did not run; on a forced error path the `Scope` is `Failed` and `Send_To_DLQ` ran `Succeeded`.
  - Because the top-level `Scope` status reflects the **entire** nested body (including any non-mockable schema-bound `XmlCompose`), a happy-path test that wants `Scope == Succeeded` **must** feed data valid enough for that compose to pass (the "full fixtures" lever) — there is no nested prefix to assert instead. This is why §7c E2E-defer, on a Scope-wrapped flow, can only assert `Assert.IsNotNull(run)` (it instantiated + executed — still catches graph/relativePath/trackedProperties/mock-gate regressions) plus structural wiring; it cannot assert routing, because the branch leaves are nested and invisible.

### 7b. Mock body and assertion MUST be consistent — author them together [VERIFIED]

Once §7a forces you to mock a transform/leaf action (`Xslt`/`InvokeFunction`/`ServiceProvider`/`Workflow`) with a *placeholder* `Succeeded` body (so the whole-workflow validation gate passes), a value assertion against that same action's output — or against the workflow's final `Response`/output that is *derived from* it (often through a non-mockable `XmlCompose`/`XmlParse` that evaluates the mock data for real) — will then fail with `Assert.AreEqual`/`Assert.IsTrue`, because the placeholder body does not contain (or is not schema-valid enough to produce) the asserted value. This is the dominant residual failure after §7a is applied: the workflow runs cleanly, but `Expected:<...> Actual:<...>` (or a status `Succeeded` expectation against an action whose mocked input made it fail downstream).

For **every** mocked action, the mock body and the test's assertions must be written as a pair. Pick ONE of these per action and keep them consistent:

1. **Shape the mock body to the asserted value.** If the test asserts the final response contains `price=42.50`, the mocked upstream (`Get_Product` / `Build_Success_Response`) body must actually carry `42.50`, propagated through to the asserted field. Trace the asserted value back to whichever mocked action produces it and put the real value in that mock.
2. **Assert only status/presence, not value, on placeholder-mocked actions.** If you keep a minimal placeholder body, downgrade the assertion to `Assert.IsTrue(run.Actions.TryGetValue("X", out var a)); Assert.AreEqual("Succeeded", a.Status);` — do NOT also assert a specific output value the placeholder doesn't carry.

**Never mix a placeholder mock body with a specific-value assertion** — that combination is a guaranteed `Assert` failure even though the workflow executed correctly. When in doubt, prefer (2) for `Xslt` transform intermediates (their real output fidelity is a runtime-E2E concern, §5a) and reserve (1) for the one or two business-outcome fields the test genuinely exists to prove. Remember a non-mockable `XmlCompose`/`XmlParse` downstream of your mock will still evaluate the mock data for real — so even under strategy (2) the mock body must be *schema-valid enough* for that compose/parse to succeed, even if you don't assert its exact value. A child-`Workflow` (`Call_*`) mock must carry whatever shape the parent reads from its response (e.g. `Body.status`), or the parent's post-call actions fail.

### 7c. E2E-defer: when a non-mockable schema-bound `XmlCompose`/`XmlParse` sits on the critical path [STANDARD]

This is the **default resolution** when a flow's happy path must pass *through* a non-mockable, schema-bound `XmlCompose`/`XmlParse` (validates its output against an XSD) and you cannot cheaply hand-craft mock inputs that make that real validation succeed. Rather than fabricate brittle schema-perfect fixtures (the "full fixtures" alternative — valid but high-maintenance), **scope the executable unit test to what the host verifies deterministically and defer the XML-schema-validity to the runtime E2E gate** (`runtime-validation-and-testing` skill — `func host start` + Azurite + real/stub endpoints, where real data is schema-valid by construction). This mirrors §5a's structural+E2E split for file-trigger flows.

Apply it **only** when a *schema-bound* `XmlCompose`/`XmlParse` is genuinely on the critical path. Do NOT apply it to dodge a fixable mock-data problem: a `Compose` that merely `base64ToString`s the trigger body (no XSD) succeeds with any valid base64 — fix the mock data and assert fully. Reserve E2E-defer for the true XSD-validation case.

The E2E-deferred executable test (still a real `RunWorkflowAsync`, NOT converted to structural) asserts only what the SDK exposes for a Scope-wrapped flow (recall from §7a that nested actions are invisible — there is no nested prefix or branch leaf to assert):
- **It instantiated and executed:** `Assert.IsNotNull(run)`. This alone catches the highest-value regressions — workflow-won't-instantiate, bad `runAfter` graph, wrong `operationId`, invalid `relativePath`, illegal `trackedProperties`, and the §7a missing-mock gate — all of which throw from `RunWorkflowAsync` before a run object is returned. (If those throw, the test fails here, which is exactly what you want.)
- **Structural wiring** (do this in a paired structural test or inline by loading `workflow.json`): the trigger `operationId`, the `XmlCompose`/`XmlParse` action exists with the correct `schema.name`/`source`, the transform map reference, each external action's `retryPolicy`, and the top-level `Send_To_DLQ` `runAfter`. This is where routing/wiring coverage actually lives for Scope-wrapped flows, since it can't be asserted from `run.Actions`.

It must **NOT**:
- assert the workflow's **terminal status** or the top-level **`Scope` status** is `Succeeded` (the Scope wraps the non-mockable compose, so on thin mock data it is `Failed` — a *test-fixture* limitation, not a workflow defect; don't assert through it), nor
- try to assert a nested action ran / a branch was taken (impossible — §7a), nor
- assert the composed/parsed XML's content or schema-validity (the deferred E2E concern).

(If you DO want top-level `Scope == Succeeded` + routing proven, that requires feeding compose-valid data — the "full fixtures" path — because the Scope status is the only window into the nested body. E2E-defer deliberately trades that away for `IsNotNull` + structural + E2E.)

Document the deferral in the test method's XML-doc comment and in `TEST-REPORT.md`: *"<Flow> happy-path XML composition (<ActionName> → <Schema>.xsd) is validated by the runtime E2E gate, not this unit test, because XmlCompose is non-mockable (§5) and runs against real data only."* The result: the test stays green and honestly proves run + routing + wiring, while the one thing the unit host cannot do is explicitly owned by E2E. **Coverage is relocated, not dropped** — which makes the E2E gate non-optional for these flows.

## 8. `parameters.json` requirement [VERIFIED]

The unit-test template validator validates workflow parameters. Every app-level `parameters.json` entry must be `{ "type": "<T>", "value": <v> }` — a `{ "value": … }`-only entry throws `"the parameter '<name>' … the 'type' property is not specified"`. Likewise every `@parameters('x')` referenced in a workflow must appear in that workflow's `definition.parameters` with a `type`. (This is also required for correct runtime behaviour, not just tests.) Reserved names containing `$` (e.g. `$connections`) are rejected — emit a test-only params file without them if present.

## 9. No parallel test assemblies [VERIFIED]

The unit-test host is **not safe to run multiple test assemblies concurrently** (shared on-disk working state) — a flow that passes in isolation can flap when the whole `.sln` runs in parallel. Emit a `.runsettings` at `tests-mstest/` and reference it from CI / `dotnet test --settings`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<RunSettings>
  <RunConfiguration>
    <MaxCpuCount>1</MaxCpuCount>
  </RunConfiguration>
</RunSettings>
```

`MaxCpuCount=1` and `[assembly: DoNotParallelize]` are necessary but **NOT sufficient** [VERIFIED]. Keep them — `[assembly: DoNotParallelize]` (MSTest) serializes **within** an assembly, and `MaxCpuCount=1` limits cores. **Do NOT add an `<MSTest><Parallelize><Scope>None</Scope></Parallelize></MSTest>` block — `None` is not a valid MSTest scope (only `ClassLevel`/`MethodLevel` are) and an invalid scope breaks test discovery entirely ("No test is available in …").**

⚠️ **But a single `dotnet test <Solution>.sln` (or any one invocation that loads all the flow test DLLs into one run) STILL fails even with `MaxCpuCount=1`** [VERIFIED in this repo: every flow project passes 5/5, 4/4, 2/2… **in isolation**, but the same tests flap with 2 failures per project when run via `dotnet test LogicAppTests.sln`]. The `UnitTestExecutor` shares process/working-directory state, so co-hosting multiple flow assemblies in one test host collides regardless of core count. The only robust isolation is a **separate process per flow project**:

```bash
# CORRECT — one dotnet test invocation per flow project (separate processes, sequential):
for p in tests-mstest/*/*.Tests.csproj; do
  dotnet test "$p" --settings tests-mstest/.runsettings --no-build || exit 1
done
# WRONG — co-hosts all flow assemblies in one run, flaky:
# dotnet test tests-mstest/LogicAppTests.sln --settings tests-mstest/.runsettings
```

CI (and the `/test-azure` runner) MUST loop per-project, not run the solution in one `dotnet test`. The `.sln` is fine for build/restore (`dotnet build LogicAppTests.sln`), just not for a single combined `dotnet test`.

## 10. `UnitTestExecutor` & `testSettings.config` [DOC: unit-test-executor-class-definition.md]

`UnitTestExecutor(workflowFilePath, connectionsFilePath, parametersFilePath, localSettingsFilePath)` then `RunWorkflowAsync(testMock)`.

**csproj `CopyToOutputDirectory` — required entries [VERIFIED]:**
```xml
<None Include="..\..\app\<FlowName>\workflow.json" Link="app\<FlowName>\workflow.json">
  <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
</None>
<None Include="..\..\app\host.json" Link="app\host.json">
  <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
</None>
<None Include="..\..\app\connections.json" Link="app\connections.json">
  <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
</None>
<None Include="..\..\app\test-parameters.json" Link="app\parameters.json">
  <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
</None>
<None Include="..\..\app\local.settings.json" Link="app\local.settings.json">
  <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
</None>
<!-- REQUIRED when the flow has InvokeFunction actions: copies compiled local-function DLLs -->
<None Include="..\..\app\lib\custom\**\*" Link="app\lib\custom\%(RecursiveDir)%(Filename)%(Extension)">
  <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
</None>
```

The `lib\custom\**\*` entry is **mandatory** for any flow that contains `InvokeFunction` actions. Without it, the test host cannot find the local-function DLLs and throws `NullReferenceException` inside `ExecuteWorkflow` — the error does not mention DLLs; it appears to be an unrelated crash. Include it for all test projects regardless of whether the specific flow under test uses local functions, since `connections.json` is shared across all flows and the SDK loads the full custom-code path at startup.

`WorkspacePath` in `testSettings.config` is relative to the test binary dir (`bin/Debug/net8.0`) and points at the real `app/`. For `stateful: false` flows, `local.settings.json` must carry `"Workflows.<Flow>.OperationOptions": "WithStatelessRunHistory"`.

**`UnitTestExecutor` path resolution [VERIFIED]:** `Path.GetFullPath("app/...")` resolves from `Environment.CurrentDirectory`, which is `bin/Debug/net8.0/` when the test host runs — not the repository root. These paths therefore resolve to the `CopyToOutputDirectory` output, NOT the source tree. Never use `Path.Combine(assemblyDir, "../../../../../app/...")` — this points to the source tree where the SDK may not find all required artefacts.

**`ILoggerFactory` null-safety in local functions [VERIFIED]:** The Logic Apps Standard unit-test host does not inject `ILoggerFactory` into local function constructors. Every local function that takes `ILoggerFactory loggerFactory` in its constructor MUST use a null-safe pattern:
```csharp
public MyFunction(ILoggerFactory? loggerFactory = null)
{
    _logger = loggerFactory?.CreateLogger<MyFunction>()
              ?? Microsoft.Extensions.Logging.Abstractions.NullLogger<MyFunction>.Instance;
}
```
Omitting the null guard causes `NullReferenceException` in `ExecuteWorkflow` — the crash is attributed to the SDK, not to the constructor, making it hard to diagnose.

## 11. Error-path tests that exhaust retries — run a fast-retry copy [VERIFIED]

The unit-test host **honours each action's `retryPolicy` in real time**. An executable error-path test that mocks an external action as `Failed` to drive the DLQ branch will make the host actually wait out the full backoff — for the IR-typical `{ exponential, count: 5, interval: PT10S, maximumInterval: PT1M }` this exceeds the SDK's internal wait and the test dies with `Microsoft.Azure.Workflows.UnitTesting.Utilities.WaitTimeOutException: Exceeded maximum wait time` (observed: ~26 min then failure). The committed `workflow.json` must keep its **IR-declared production retry policy** — do NOT weaken it to make the test pass.

Instead, apply the runtime-validation §3 adaptation **inside the test**: write a fast-retry copy of the workflow (every `retryPolicy` shrunk to `count: 1`, all intervals `PT1S`) into a sibling flow folder under the test output, and point the `UnitTestExecutor` at that copy for the retry-exhaustion test only. The DLQ routing (`Scope` Failed → `Send_To_DLQ` Succeeded) is identical; only the wait shrinks to seconds. The happy-path test runs against the real `workflow.json` unchanged.

```csharp
// Sibling folder so the SDK's app-root inference (parent-of-flow) still finds the shared
// app/connections.json + parameters.json + local.settings.json.
private static string FastRetryWorkflow()
{
    var wf = JObject.Parse(File.ReadAllText(Path.GetFullPath("app/<Flow>/workflow.json")));
    void Shrink(JToken t)
    {
        if (t is JObject o)
        {
            if (o["retryPolicy"] is JObject rp)
            { rp["count"] = 1; rp["interval"] = "PT1S"; rp["minimumInterval"] = "PT1S"; rp["maximumInterval"] = "PT1S"; }
            foreach (var p in o.Properties()) Shrink(p.Value);
        }
        else if (t is JArray a) { foreach (var i in a) Shrink(i); }
    }
    Shrink(wf);
    var dir = Path.GetFullPath("app/<Flow>_FastRetry");
    Directory.CreateDirectory(dir);
    File.WriteAllText(Path.Combine(dir, "workflow.json"), wf.ToString());
    return "app/<Flow>_FastRetry/workflow.json";   // pass to the executor's workflowFilePath
}
```

Document the adaptation in the test XML-doc and `TEST-REPORT.md` (runtime-validation §3 requires recording reduced durations). This keeps the committed workflow IR-faithful while the error-path test runs in seconds.

## Pre-emit checklist

1. Read `app/<Flow>/workflow.json`; copy action names verbatim; bucket each action: mockable vs §5-excluded.
2. Mock every mockable action on each test path as `Succeeded` (or `Failed` for the error path) — outputs shaped per §6.
3. Failed mocks: `ActionMock.Error` (or the error ctor) with a valid `ErrorResponseCode` (§3); correct usings (§2, §3).
4. `parameters.json` typed (§8); `.runsettings` emitted (§9); stateless option set (§10).
5. Never use the internal 4-arg `ActionMock` ctor (§1); never mock `XmlCompose`/`XmlParse`/control/`Response` (§5).
6. Any executable test that drives a `Failed` external action into the DLQ branch uses a fast-retry workflow copy (§11) — never wait out the production `retryPolicy`, never weaken the committed `workflow.json`.
