---
name: logicapp-standard-layout
description: Canonical file layout and naming conventions for a Logic Apps Standard solution produced by this pack.
---

# Logic Apps Standard layout

This layout is what the Azure Logic Apps Standard VS Code extension expects when you open the project root folder. Each flow lives in its own folder at the project root; there is no `src/` wrapper. The extension scans the project root for folders containing `workflow.json` to populate the designer.

The integration folder contains both the pipeline artifacts (spec/ir/contracts/reports; read-only inputs) and the deployable Logic Apps Standard solution under `app/`. A `.code-workspace` file at the integration root opens the logic-app folder, and the sibling `Functions/` C# project when present, in VS Code so the Azure Logic Apps Standard extension attaches to the deployable project without exposing the surrounding pipeline folders.

```text
specs/<domain>/NNN-<slug>/                 # Integration folder (mixed: pipeline + solution)
|-- spec.md, data-model.md, integration-ir.yaml,
|   plan.md, research.md, tasks.md,
|   clarifications.md, status.json,
|   *-report.{md,json},
|   contracts/, mappings/, artifacts/      # Pipeline-only artifacts (not deployed)
|
|-- <slug>.code-workspace                  # Workspace: ./app (+ ./Functions when sibling project exists)
|-- azure.yaml                             # azd: infra only for Logic Apps Standard; add services only for stand-alone Function Apps
|
|-- app/                                   # Deployable Logic Apps Standard project (the VS Code project)
|   |
|   |-- host.json                          # Logic Apps runtime config (extensionBundle, logging)
|   |-- connections.json                   # serviceProviderConnections + managedApiConnections
|   |-- parameters.json                    # Workflow-level runtime parameters (@parameters(...))
|   |-- appsettings.dev.json
|   |-- appsettings.prod.json
|   |-- local.settings.json                # Local dev only; never deployed, never real secrets
|   |-- identity-role-assignments.json     # Consumed by azure-bicep-author
|   |-- global.json                        # Pins .NET 8 SDK
|   |-- .funcignore                        # Excludes from func deploy (e.g. tests/, *.md)
|   |-- .gitignore                         # Azurite state, bin/, obj/, .azure/
|   |
|   |-- workflow-designtime/               # Required for VS Code Logic Apps designer
|   |   |-- host.json                      # Designer host scaffold; must enable Runtime.WorkflowOperationDiscoveryHostMode
|   |   `-- local.settings.json            # FUNCTIONS_WORKER_RUNTIME=node plus local Azurite settings (designer-only)
|   |
|   |-- .vscode/
|   |   |-- settings.json                  # azureLogicAppsStandard.* project settings
|   |   |-- launch.json                    # customCodeRuntime: coreclr (net8) or clr (net472)
|   |   |-- tasks.json                     # Owned by VS Code LA Standard extension; do not customise
|   |   `-- extensions.json                # Recommends vscode-azurelogicapps + vscode-azurefunctions
|   |
|   |-- Artifacts/                         # Artifact store referenced by Xslt / FlatFileDecoding / XmlValidation actions
|   |   |-- Maps/                          # XSLT files lifted from BizTalk .btm; BizTalk scripted XSLT is supported by built-in Xslt action
|   |   |   `-- <MapName>.xsl
|   |   |-- DataMapper/                    # Greenfield Logic Apps Data Mapper artifacts
|   |   |   `-- <MapName>.lml
|   |   |-- Liquid/                        # Liquid templates for declarative template-style transforms
|   |   |   `-- <MapName>.liquid
|   |   `-- Schemas/                       # XSDs / flat-file XSDs for XmlValidation + FlatFileDecoding
|   |       `-- <SchemaName>.xsd
|   |
|   |-- lib/custom/net8/                   # Output drop for sibling Functions/ project (do not hand-edit; published by csproj's TriggerPublishOnBuild target)
|   |
|   |-- <FlowName>/                        # One folder per flow at project root; no src/ wrapper
|   |   `-- workflow.json
|   |-- <AnotherFlow>/
|   |   `-- workflow.json
|   |
|   |-- tests/                             # JSON request fixtures for the designer's "Run with payload"
|   |   |-- happy-request.json
|   |   `-- bad-request.json
|   |
|   `-- .github/workflows/                 # CI/CD lives inside the logic-app folder so it activates when published standalone
|       |-- pr-validate.yml
|       `-- deploy.yml
|
|-- Functions/                             # Sibling .NET 8 in-process WebJobs SDK project (only when InvokeFunction actions exist)
|   |-- <ProjectName>.csproj               # TargetFramework: net8 (not net8.0); LogicAppFolderToPublish=$(MSBuildProjectDirectory)\..\app
|   |-- <FunctionName>.cs                  # Instance class with [Function(...)] from Microsoft.Azure.Functions.Worker + [WorkflowActionTrigger]
|   |-- Helpers/                           # Shared helpers (optional)
|   |   `-- <Helper>.cs
|   `-- Models/                            # POCOs for input/output JSON shapes
|       `-- <ModelName>.cs
|
|-- infra/                                 # Bicep; outside app/ so azd reads it from the integration root
|   |-- main.bicep
|   |-- parameters.dev.bicepparam
|   |-- parameters.prod.bicepparam
|   `-- modules/
|       |-- logicapp.bicep
|       |-- functionapp.bicep
|       |-- servicebus.bicep
|       |-- storage.bicep
|       |-- identity.bicep
|       |-- keyvault.bicep
|       `-- monitoring.bicep
|
|-- tests/                                 # IR flow-test fixtures (vendor-neutral) — distinct from app/tests/ AND tests-mstest/
|   `-- fixtures/                          # input payloads referenced by integration-ir.yaml flows[].tests[].trigger.path
|                                          # (e.g. tests/fixtures/payment-inbound.xml); consumed by /test-flows
|
`-- tests-mstest/                          # MSTest unit tests; separated so they do not collide with app/tests/ JSON fixtures and do not get bundled into the func deploy package
    |-- Directory.Build.props              # Pins Microsoft.Azure.Workflows.WebJobs.Tests.Extension
    |-- global.json                        # Pins .NET 8 SDK
    `-- <FlowName>.Tests/
        |-- <FlowName>.Tests.csproj
        |-- <FlowName>Tests.cs             # MSTest class (UnitTestExecutor pattern)
        |-- testSettings.config            # XML; WorkspacePath, LogicAppName, WorkflowName
        |-- fixtures/                      # JSON fixtures from OpenAPI/AsyncAPI examples
        `-- Mocks/
            `-- <FlowName>/
                |-- <TriggerName>TriggerMock.cs
                `-- <ActionName>ActionMock.cs
```

## VS Code opening conventions

| To do | Open |
|---|---|
| Edit workflows with the LA Standard designer; F5 to debug | `app/` (Open Folder...) |
| Open the generated Logic App project with VS Code workspace settings applied | `<slug>.code-workspace` (Open Workspace...) |
| Build/run MSTest unit tests | `tests-mstest/` (or via `dotnet test` from any shell) |

The `app/` folder is the deployable unit. `cd app && func host start` runs the Logic App locally. `cd .. && azd provision` deploys the infrastructure from `azure.yaml`; the Logic App content is then packaged from `app/` and deployed separately. If a sibling `Functions/` project exists, build it first so `app/lib/custom/net8/` contains the published DLLs.

## Why NOT `src/`?

The Azure Logic Apps Standard VS Code extension activates on `host.json` and scans the same folder for child folders containing `workflow.json`. Wrapping flows under `src/` hides them from the designer. There is no equivalent of `<Compile Include="src/**" />` for workflows; the project root is where flows go.

## Naming

- Resource groups: `rg-<workload>-<env>-<region>`.
- Logic App: `lapp-<workload>-<env>-<region>`.
- Service Bus namespace: `sb-<workload>-<env>-<region>`.
- Storage account: `st<workload><env><region>` (no separators, lowercase, <= 24 chars).
- User-assigned MI: `mi-<workload>-<env>`.
- Key Vault: `kv-<workload>-<env>` (<= 24 chars).

## Tags

Every resource carries:

```text
workload: <IR metadata.name>
env:      <dev | prod>
owner:    <IR metadata.owner>
domain:   <IR metadata.domain>
```

## connections.json structure

Built-in connectors (Service Bus, Blob, SQL, Event Grid, etc.) go under `serviceProviderConnections`.
Legacy/OAuth2 managed API connectors go under `managedApiConnections`.
Never put built-in connectors under `managedApiConnections`.

```json
{
  "managedApiConnections": {},
  "serviceProviderConnections": {
    "<channel-name>": {
      "serviceProvider": { "id": "/serviceProviders/serviceBus" },
      "displayName": "<channel-name>",
      "parameterValues": {
        "connectionString": "@appsetting('<CHANNEL>_CONNECTION_STRING')"
      }
    }
  }
}
```

## workflow.json action structure for built-in connectors

Use `type: ServiceProvider`; never managed API connection reference format:

```json
{
  "type": "ServiceProvider",
  "inputs": {
    "serviceProviderConfiguration": {
      "connectionName": "<channel-name>",
      "operationId": "sendMessage",
      "serviceProviderId": "/serviceProviders/serviceBus"
    },
    "parameters": { "entityName": "@parameters('<channel-name>QueueName')" }
  }
}
```

## host.json Tuning by Workload

The default `host.json` is conservative. Tune these settings based on IR `nonFunctionals` and channel types.

### Service Bus Concurrency

For flows triggered by Service Bus queues/topics, tune message handler settings:

```json
{
  "extensions": {
    "serviceBus": {
      "messageHandlerOptions": {
        "maxConcurrentCalls": 16,
        "autoComplete": true
      },
      "prefetchCount": 0,
      "batchOptions": {
        "maxMessageCount": 1000,
        "operationTimeout": "00:01:00"
      }
    }
  }
}
```

| IR `nonFunctionals` | host.json setting | Guidance |
|---|---|---|
| `rps <= 10` | `maxConcurrentCalls: 1` | Single-threaded processing; lowest resource usage |
| `rps 10-50` | `maxConcurrentCalls: 8` | Moderate parallelism |
| `rps 50-200` | `maxConcurrentCalls: 16-32` | Scale up App Service Plan to WS2+ |
| `rps > 200` | `maxConcurrentCalls: 32-64` | Requires WS3 + `alwaysOn: true`; consider partitioned queues |
| `delivery: exactly-once` | `autoComplete: false` | Must manually complete after processing (peek-lock) |
| `ordering: fifo` | `maxConcurrentCalls: 1` | Session-enabled queue; single processor per session |

### Workflow Concurrency

```json
{
  "extensions": {
    "workflow": {
      "settings": {
        "Runtime.Trigger.MaximumRunDurationInSeconds": "3600",
        "Runtime.Trigger.MaximumWaitingRuns": "100"
      }
    }
  }
}
```

| IR `nonFunctionals` | Setting | Guidance |
|---|---|---|
| High throughput, short-lived flows | `MaximumWaitingRuns: 200` | Queue more runs while current ones complete |
| Long-running flows (saga, aggregator) | `MaximumRunDurationInSeconds: 86400` | Allow runs up to 24h |
| Strict ordering required | Trigger `runtimeConfiguration.concurrency.runs: 1` | Serialize in `workflow.json`, not `host.json` |

### Logging Levels by Environment

```json
// Production - reduce noise, keep diagnostics
{
  "logging": {
    "logLevel": {
      "default": "Warning",
      "Host.Results": "Information",
      "Host.Triggers.Workflows": "Warning",
      "Function": "Warning"
    }
  }
}

// Development - verbose for debugging
{
  "logging": {
    "logLevel": {
      "default": "Information",
      "Host.Results": "Information",
      "Host.Triggers.Workflows": "Debug",
      "Function": "Debug",
      "Host.Aggregator": "Trace"
    }
  }
}
```

### Scaling Settings (via Bicep, not host.json)

| IR `nonFunctionals` | App Service Plan | Settings |
|---|---|---|
| `rps <= 20` | WS1 | `alwaysOn: false` |
| `rps <= 100` | WS2 | `alwaysOn: true` |
| `rps > 100` | WS3 | `alwaysOn: true`, consider scale-out rules |
| `p95LatencyMs <= 500` | WS2+ | `alwaysOn: true` (avoids cold start) |

## Local development prerequisites

To run locally with `func host start` (or F5 in VS Code):
- Azure Functions Core Tools v4
- Azurite (local Storage emulator; `Ctrl+Shift+P -> Azurite: Start`)
- .NET 8 SDK
- VS Code with `ms-azuretools.vscode-azurelogicapps` extension

## Required `local.settings.json` keys (runtime)

These keys MUST be present in `app/local.settings.json` from scaffold time. Missing any of them causes obscure runtime failures the moment a workflow or local function is added later.

| Setting | Value | Why |
|---|---|---|
| `AzureWebJobsStorage` | `UseDevelopmentStorage=true` | Routes runtime storage to Azurite for local dev. |
| `FUNCTIONS_WORKER_RUNTIME` | `dotnet` | Logic Apps Standard always uses `dotnet` (in-process). Never use `dotnet-isolated`; that breaks `InvokeFunction` action discovery. |
| `FUNCTIONS_INPROC_NET8_ENABLED` | `1` | Loads .NET 8 in-process host so custom-code DLLs from `lib/custom/net8/` are picked up. Required even before any local function exists. |
| `APP_KIND` | `workflowapp` | Identifies this as a Logic App Standard site (lowercase `app`; `WorkflowApp` and `WorkflowAPP` do not work). |
| `AzureWebJobsFeatureFlags` | `EnableMultiLanguageWorker` | Allows the workflow engine and custom code worker to run side-by-side. |
| `ProjectDirectoryPath` | Absolute path to `app/` | Tells `func host start` where to discover `workflow.json` files. Local-only; never set this in cloud app settings. |
| `WORKFLOWS_SUBSCRIPTION_ID` | `""` (empty for local) | Required key; populated by Bicep in cloud. |

The design-time `app/workflow-designtime/local.settings.json` is intentionally different; it sets `FUNCTIONS_WORKER_RUNTIME=node` (not `dotnet`), because the designer's operation-discovery host runs on Node.js. It must also include `AzureWebJobsStorage=UseDevelopmentStorage=true` and `AzureWebJobsSecretStorageType=Files` so the design-time host can boot cleanly against Azurite. Do not "fix" this to `dotnet`.

The design-time `app/workflow-designtime/host.json` must remain minimal, but it still needs `extensions.workflow.settings.Runtime.WorkflowOperationDiscoveryHostMode=true`; without that flag the VS Code designer can fail to enumerate operations even when `func host start` works from the project root.

## Required cloud-only app settings (Bicep)

When the same `app/` is deployed to Azure, these additional settings are required on the Logic App resource:

| Setting | Value | Notes |
|---|---|---|
| `WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` | Storage account conn string | Required on WS1 plan; runtime will not start without it. |
| `WEBSITE_CONTENTSHARE` | Logic App name (e.g. `lapp-orders-prod-eus`) | Azure auto-creates this Files share for runtime content. |
| `FUNCTIONS_EXTENSION_VERSION` | `~4` | Pinning to `~4`; `~3` is unsupported by the Workflows extension bundle. |

See `logicapp-cloud-deployment` skill for the full Bicep template and the full set of restrictions on `mountPath`, content deploy, and `@secure()` parameters.

## Do-not

- Do not put multiple flows in one `workflow.json`.
- Do not wrap flow folders under `src/`, `workflows/`, or any other parent; flows must sit at the project root, the folder containing `host.json`.
- Do not put MSTest project files under `app/tests/`; that folder is reserved for the designer's JSON request fixtures. MSTest goes in the sibling `tests-mstest/` directory.
- There are **three** distinct test locations — keep them straight: (1) `app/tests/` = the Logic Apps designer's "Run with payload" JSON fixtures (inside the deployable `app/`); (2) `tests-mstest/<Flow>.Tests/fixtures/` = fixtures for the compiled-workflow MSTest suite; (3) `tests/fixtures/` (integration-folder root) = the **vendor-neutral IR flow-test fixtures** referenced by `integration-ir.yaml` `flows[].tests[].trigger.path` and consumed by `/test-flows`. Flow-test fixtures belong in (3), **never** in `app/tests/fixtures/`.
- Do not use `managedApiConnections` for connectors that have a built-in `serviceProviderConnections` equivalent.
- Do not reference connection strings or keys directly; always `@appsetting(...)` -> Key Vault reference.
- Do not check in `local.settings.json` with real values.
- Do not put Bicep parameter default values that vary per environment inside the module file; use `.bicepparam` files.
- Do not omit `workflow-designtime/`; without it the VS Code designer cannot open workflows.
- Do not omit `Runtime.WorkflowOperationDiscoveryHostMode` from `workflow-designtime/host.json`, and do not omit `AzureWebJobsStorage` / `AzureWebJobsSecretStorageType` from `workflow-designtime/local.settings.json`; the local runtime may still start while the designer remains broken.
- Do not omit `Artifacts/Maps/`, `Artifacts/DataMapper/`, `Artifacts/Liquid/`, or `Artifacts/Schemas/` when the compiled workflow references XSLT maps, Data Mapper artifacts, Liquid templates, or XML/flat-file schemas; the runtime actions reference files at those exact paths.
- Do not use `testConfiguration.json`; the Microsoft SDK uses `testSettings.config` (XML).