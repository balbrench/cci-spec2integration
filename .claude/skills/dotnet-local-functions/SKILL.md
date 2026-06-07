---
name: dotnet-local-functions
description: Patterns and rules for creating .NET local functions (Custom Code actions) in Azure Logic Apps Standard. Covers InvokeFunction action JSON structure, project layout, when to use local functions vs Azure Functions vs inline code, and migration from BizTalk custom code. Adapted from the Azure Logic Apps Migration Agent reference.
---

# .NET Local Functions for Azure Logic Apps Standard

> **Purpose**: Reference guide for generating .NET local functions that run in-process within a Logic Apps Standard workflow. Use this when the IR contains artifacts with `migrationHint: local-function` or when BizTalk custom code needs to be migrated.

---

## 1. When to Use Each Custom Code Option

| Option                     | Use When                                                                                   | Latency    | Hosting          |
|----------------------------|--------------------------------------------------------------------------------------------|------------|------------------|
| **Built-in action**        | XML Parse, Validate XML, XSLT, Flat File, Compose, Parse JSON cover the need               | Lowest     | In-process       |
| **WDL expression**         | Simple string/math/date/logical operations (`@{concat(...)}`, `@{add(...)}`, etc.)          | Lowest     | In-process       |
| **C# Inline Code action**  | Short multi-line C# logic: regex, simple parsing, formatting (< 50 lines)                   | Low        | In-process       |
| **.NET local function**    | Reusable business logic, DB access, complex validation, external API wrappers               | Low        | In-process       |
| **Azure Function**         | Heavy compute, long-running (> 10 min), shared across multiple apps, needs independent scaling | Medium     | Separate process |

> **Rule**: Choose the option highest on this list that meets the requirement. Never use Azure Functions when a local function suffices. Never use a local function when a built-in action or expression suffices.

---

## 2. Project Structure

Logic Apps Standard custom code uses the **in-process WebJobs SDK** pattern (NOT the isolated worker model used by general Azure Functions). The custom-code project lives **as a sibling to the Logic Apps `app/` project** and publishes its build output INTO `app/lib/custom/net8/`. The Logic Apps in-process host (`FUNCTIONS_WORKER_RUNTIME=dotnet` + `FUNCTIONS_INPROC_NET8_ENABLED=1`) then loads those DLLs and exposes them to `InvokeFunction` actions.

There is **no `Program.cs`** and **no `HostBuilder`** — the Logic Apps host owns the process. Each function is an **instance class** with `ILoggerFactory` constructor injection, NOT a static class.

```
specs/<domain>/NNN-<slug>/
├── app/                                # Deployable Logic Apps Standard project
│   ├── host.json
│   ├── connections.json
│   ├── parameters.json
│   ├── local.settings.json             # FUNCTIONS_WORKER_RUNTIME=dotnet (in-proc)
│   ├── <FlowOneName>/
│   │   └── workflow.json
│   ├── <FlowTwoName>/
│   │   └── workflow.json
│   └── lib/custom/net8/                # ← Custom-code DLLs land here at build time
│       └── <ProjectName>.dll
│
└── Functions/                          # ← Sibling .NET project (custom code)
    ├── <ProjectName>.csproj            # LogicAppFolderToPublish=$(MSBuildProjectDirectory)\..\app
    ├── <FunctionName>.cs               # Instance class, ILoggerFactory ctor, [Function]
    ├── Helpers/
    │   └── <Helper>.cs
    └── Models/
        └── <ModelName>.cs
```

### Required .csproj template

The csproj is .NET 8, **library output**, with a post-build `Publish` target so a plain `dotnet build` deposits the DLLs into `app/lib/custom/net8/`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <IsPackable>false</IsPackable>
    <TargetFramework>net8</TargetFramework>
    <AzureFunctionsVersion>v4</AzureFunctionsVersion>
    <OutputType>Library</OutputType>
    <PlatformTarget>AnyCPU</PlatformTarget>
    <RootNamespace><ProjectName>.Functions</RootNamespace>
    <LogicAppFolderToPublish>$(MSBuildProjectDirectory)\..\<logicAppName></LogicAppFolderToPublish>
    <CopyToOutputDirectory>Always</CopyToOutputDirectory>
    <SelfContained>false</SelfContained>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <!-- REQUIRED: route the Worker SDK publish to the no-build copy path. Without this the
         default publish builds and publishes a temp WorkerExtensions.csproj into a `publishout`
         dir whose <Move> step collides on transitively-pulled assemblies (e.g. NCrontab.Signed.dll
         via Azure.Identity/Microsoft.Data.SqlClient) → hard build break MSB3677 "Cannot create a
         file when that file already exists". The Logic Apps in-proc custom-code model does not use
         the isolated-worker extensions assembly, so the no-build copy path is correct. -->
    <_FunctionsExtensionsFullPublish>false</_FunctionsExtensionsFullPublish>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.Azure.Functions.Worker.Extensions.Abstractions" Version="1.3.0" />
    <PackageReference Include="Microsoft.Azure.Functions.Worker.Sdk" Version="1.15.1" />
    <!-- Marker package the Logic Apps in-proc host probes for to detect custom code. -->
    <PackageReference Include="Microsoft.Azure.Workflows.WebJobs.Sdk" Version="1.3.0" />
    <PackageReference Include="Microsoft.Extensions.Logging.Abstractions" Version="6.0.0" />
    <PackageReference Include="Microsoft.Extensions.Logging" Version="6.0.0" />
  </ItemGroup>
  <!-- Publish (which copies the DLLs into <logicAppName>/lib/custom/net8/) must run ONCE, in the
       same MSBuild instance. Use <CallTarget>, NOT a nested <MSBuild ... IsPublishing=true> call —
       the re-invocation double-triggers the publish pipeline and is what surfaces the MSB3677 race. -->
  <Target Name="TriggerPublishOnBuild" AfterTargets="Build" Condition="'$(IsPublishing)' != 'true'">
    <CallTarget Targets="Publish" />
  </Target>
</Project>
```

> **Do NOT** add `Microsoft.Azure.Functions.Worker` (isolated worker host) or `Microsoft.Azure.Workflows.WebJobs.Extension` — those are wrong host models for Logic Apps Standard custom code. The required marker package is `Microsoft.Azure.Workflows.WebJobs.Sdk`.

> **Build gate:** after emitting this project, `dotnet build <ProjectName>.csproj -c Debug` MUST exit 0 and the DLLs must land in `<logicAppName>/lib/custom/net8/`. If you see `MSB3677 … NCrontab.Signed.dll … Cannot create a file when that file already exists`, the `_FunctionsExtensionsFullPublish=false` property or the `<CallTarget>` form above is missing — both are mandatory, not optional.

> **TFM must be `net8`** (the bare token, NOT `net8.0`) — this is the Logic Apps Standard custom-code convention. The in-proc host writes `"Language": "net8"` into the generated `function.json`; using `net8.0` produces a TFM moniker the runtime probe does not recognise. Reference: balbrench/logicapps-migration-agent `dotnet-local-functions-logic-apps` skill, Quick Reference Card.

---

## 3. Local Function Class Pattern

Each local function is an **instance class** that takes `ILoggerFactory` via constructor injection. The method is decorated with `[Function("<FunctionName>")]` and the input parameter with `[WorkflowActionTrigger]` (imported from `Microsoft.Azure.Functions.Extensions.Workflows`, NOT `Microsoft.Azure.Functions.Worker.Extensions.Workflows` and NOT `Microsoft.Azure.Workflows.Worker`). The method receives a `string` (serialized JSON input from the workflow) and returns a `string` (serialized JSON output).

```csharp
using Microsoft.Azure.Functions.Extensions.Workflows;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;
using System.Text.Json;

namespace <ProjectName>.Functions;

public class <FunctionName>
{
    private readonly ILogger<<FunctionName>> logger;

    public <FunctionName>(ILoggerFactory loggerFactory)
    {
        this.logger = loggerFactory.CreateLogger<<FunctionName>>();
    }

    [Function("<FunctionName>")]
    public string Run([WorkflowActionTrigger] string input)
    {
        this.logger.LogInformation("Executing <FunctionName>");

        var request = JsonSerializer.Deserialize<InputModel>(input)
            ?? throw new InvalidOperationException("Input could not be deserialized.");

        var result = new OutputModel
        {
            // ... populate from request
        };

        return JsonSerializer.Serialize(result);
    }
}

// Input/Output models — keep in Models/ folder, one type per file.
public class InputModel
{
    // Properties matching the JSON passed from workflow
}

public class OutputModel
{
    // Properties returned to the workflow
}
```

### Key Rules

1. **Instance class with `ILoggerFactory` ctor**: NOT static. The Logic Apps in-process host instantiates each class per invocation; static methods are not discovered.
2. **`[WorkflowActionTrigger]`**: The input parameter must use this attribute.
   Import it from `Microsoft.Azure.Functions.Extensions.Workflows` — NOT `Microsoft.Azure.Functions.Worker.Extensions.Workflows` and NOT `Microsoft.Azure.Workflows.Worker`.
3. **JSON in, JSON out**: Input and output are always JSON strings. Deserialize on entry, serialize on exit.
4. **Logging**: Capture `ILogger<T>` from the injected `ILoggerFactory` in the constructor and log through it. Do NOT use `FunctionContext.GetLogger()` — that is the isolated-worker pattern and the in-proc host does not surface the FunctionContext the same way.
5. **No async I/O by default**: Local functions run synchronously. For async scenarios, use `Task<string>` return type.
6. **Error handling**: Throw exceptions to signal failure — the workflow will catch them via `runAfter: [Failed]`.
7. **No `Program.cs`, no `HostBuilder`**: the Logic Apps host owns the process. Adding `ConfigureFunctionsWorkerDefaults()` puts you on the wrong host model and breaks `InvokeFunction` discovery.

---

## 4. Calling Local Functions from workflow.json

### 4.1 InvokeFunction Action

```json
{
  "Call_<FunctionName>": {
    "type": "InvokeFunction",
    "inputs": {
      "functionName": "<FunctionName>",
      "parameters": {
        "param1": "@body('Previous_Action')?['field1']",
        "param2": "@variables('myVar')"
      }
    },
    "runAfter": {
      "Previous_Action": ["Succeeded"]
    }
  }
}
```

### 4.2 Accessing Function Output

After the `InvokeFunction` action completes, access the output:

```
@body('Call_<FunctionName>')
```

If the function returns a JSON object, access individual fields:

```
@body('Call_<FunctionName>')?['fieldName']
```

### 4.3 Error Handling

Use `runAfter` with `Failed` status to handle function errors:

```json
{
  "Handle_Error": {
    "type": "Compose",
    "inputs": {
      "error": "@body('Call_<FunctionName>')",
      "status": "Failed"
    },
    "runAfter": {
      "Call_<FunctionName>": ["Failed"]
    }
  }
}
```

---

## 5. BizTalk Custom Code → Local Function Migration

### 5.1 Helper Class (from Orchestration)

**BizTalk**: `MyHelper.DoSomething(msg)` called from XLANG/s expression shape.

**Logic Apps**:
1. Create `Functions/MyHelper.cs` with the business logic.
2. Add `InvokeFunction` action in the workflow where the expression shape was.
3. Pass the message body as JSON input.
4. Use the function output in subsequent actions.

### 5.2 Custom Pipeline Component

**BizTalk**: `MyPipelineComponent.Execute(context)` in receive/send pipeline.

**Logic Apps**:
1. Extract the `Execute()` logic into `Functions/MyPipelineComponent.cs`.
2. Place the `InvokeFunction` action at the position where the pipeline ran:
   - Receive pipeline → immediately after the trigger (before business logic).
   - Send pipeline → immediately before the send action.
3. Pass the raw message as input; return the processed message.

### 5.3 Custom Functoid (incl. BizTalk Scripting Functoid)

**BizTalk**: Custom functoid called from a BizTalk map. The BizTalk Scripting functoid compiles to inline C# inside `<msxsl:script implements-prefix="userCSharp">` blocks within the generated XSLT.

**Logic Apps Standard**: the `Xslt` built-in action runs maps with scripting enabled, so **BizTalk-compiled XSLT runs as-is** through `Artifacts/Maps/<MapName>.xsl` + an `Xslt` action — including `<msxsl:script>` / `userCSharp` blocks. Do NOT wrap scripted XSLT in a local function. A local function is only justified when the scripting block calls something the runtime cannot do (file I/O, network, etc.) — in which case extract that one call, not the whole map.

### 5.4 Validation Logic

**BizTalk**: Custom validator class called from orchestration or pipeline.

**Logic Apps**:
1. Create `Functions/MyValidator.cs`.
2. Add `InvokeFunction` action before the business logic actions.
3. Check the validation result with a `Condition` action:
   - True branch → continue processing.
   - False branch → `Terminate` with error or route to DLQ.

### 5.5 Database Access Helper

**BizTalk**: C# class using `SqlConnection` to read/write data.

**Logic Apps** (choose one):
- **Simple CRUD**: Use the SQL Server built-in connector (`/serviceProviders/sql`) with `executeQuery` or `executeStoredProcedure` actions.
- **Complex multi-step DB logic**: Create `Functions/MyRepository.cs`. Use connection string from app settings (never hardcode). Call via `InvokeFunction`.

> **Security**: Connection strings must come from `@appsetting('SqlConnectionString')` which references Azure Key Vault. Never embed credentials in function code.

---

## 6. Testing Local Functions

### Unit Testing

Local functions should have unit tests in the test project:

```csharp
[TestClass]
public class MyFunctionTests
{
    [TestMethod]
    public void Run_ValidInput_ReturnsExpectedOutput()
    {
        // Arrange
        var input = JsonSerializer.Serialize(new InputModel { /* ... */ });

        // Act
        var result = MyFunction.Run(input, CreateMockContext());

        // Assert
        var output = JsonSerializer.Deserialize<OutputModel>(result);
        Assert.AreEqual("expected", output.SomeField);
    }

    private static FunctionContext CreateMockContext()
    {
        // Create a mock FunctionContext for testing
        // Use Moq or similar
    }
}
```

### Integration Testing with Workflow

The workflow-level test (via Logic Apps unit testing SDK) should:
1. Mock the `InvokeFunction` action output for happy path.
2. Mock the `InvokeFunction` action to throw for error path.
3. Verify the workflow routes correctly based on function output.

**[VERIFIED] Test csproj must copy `lib/custom` to output.** Any test project that covers a flow with `InvokeFunction` actions must include this `<ItemGroup>` entry in its `.csproj` so the compiled DLLs are available at `bin/Debug/net8.0/app/lib/custom/net8/` when `UnitTestExecutor` initialises:

```xml
<None Include="..\..\app\lib\custom\**\*" Link="app\lib\custom\%(RecursiveDir)%(Filename)%(Extension)">
  <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
</None>
```

Without this entry, `UnitTestExecutor.RunWorkflowAsync` throws `NullReferenceException` inside `ExecuteWorkflow` — the error does not mention DLLs and is difficult to diagnose.

**[VERIFIED] `ILoggerFactory` must be null-safe in unit test context.** The Logic Apps Standard unit-test host does not inject `ILoggerFactory`. Every local function constructor must use:

```csharp
public MyFunction(ILoggerFactory? loggerFactory = null)
{
    _logger = loggerFactory?.CreateLogger<MyFunction>()
              ?? Microsoft.Extensions.Logging.Abstractions.NullLogger<MyFunction>.Instance;
}
```

The production runtime always injects a real `ILoggerFactory`; the null-safe pattern is a no-op in production and prevents the test crash.

---

## 7. Deployment Considerations

### Local Functions in CI/CD

- Local functions are deployed **with** the Logic App (same deployment unit).
- The `.csproj` must be built before `func azure functionapp publish` or `azd deploy`.
- `host.json` must include the extension bundle for workflow support.

### App Settings for Functions

Local functions access app settings via `Environment.GetEnvironmentVariable()`:

```csharp
var connectionString = Environment.GetEnvironmentVariable("SqlConnectionString");
```

These settings are managed in:
- `local.settings.json` (local development)
- `appsettings.{env}.json` (deployment environments)
- Azure Key Vault references for secrets

### Performance

- Local functions run **in-process** with the Logic Apps runtime.
- Cold start: minimal (shared process with the workflow runtime).
- Memory: shared with the Logic Apps host. Avoid large in-memory objects.
- Timeout: governed by the Logic Apps action timeout (default 5 minutes for synchronous).

---

## 8. Common Patterns

### Pattern: Validate and Route

```json
{
  "Validate_Input": {
    "type": "InvokeFunction",
    "inputs": {
      "functionName": "ValidateOrder",
      "parameters": {
        "orderData": "@triggerBody()"
      }
    },
    "runAfter": {}
  },
  "Check_Validation": {
    "type": "If",
    "expression": {
      "and": [
        { "equals": ["@body('Validate_Input')?['isValid']", true] }
      ]
    },
    "actions": {
      "Process_Order": { "..." : "..." }
    },
    "else": {
      "actions": {
        "Send_To_DLQ": { "..." : "..." }
      }
    },
    "runAfter": {
      "Validate_Input": ["Succeeded"]
    }
  }
}
```

### Pattern: Enrich from Database

```json
{
  "Lookup_Customer": {
    "type": "InvokeFunction",
    "inputs": {
      "functionName": "CustomerLookup",
      "parameters": {
        "customerId": "@triggerBody()?['customerId']"
      }
    },
    "runAfter": {}
  },
  "Merge_Customer_Data": {
    "type": "Compose",
    "inputs": {
      "order": "@triggerBody()",
      "customer": "@body('Lookup_Customer')"
    },
    "runAfter": {
      "Lookup_Customer": ["Succeeded"]
    }
  }
}
```

### Pattern: Transform with Custom Logic

```json
{
  "Transform_Message": {
    "type": "InvokeFunction",
    "inputs": {
      "functionName": "TransformPurchaseOrder",
      "parameters": {
        "sourceMessage": "@body('Parse_XML')",
        "transformConfig": "@parameters('transformConfig')"
      }
    },
    "runAfter": {
      "Parse_XML": ["Succeeded"]
    }
  }
}
```

---

_Adapted from the [Azure Logic Apps Migration Agent](https://github.com/Azure/logicapps-migration-agent) reference material._
