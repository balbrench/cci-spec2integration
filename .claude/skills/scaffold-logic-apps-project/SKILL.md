---
name: scaffold-logic-apps-project
description: Procedural step-by-step guide for scaffolding a deployable Logic Apps Standard project folder (`app/`) from scratch. Companion to `logicapp-standard-layout` (which is descriptive). Provides a 17-file manifest with verbatim default content for every project file produced before any flow or function code is emitted. Invoked by `azure-logic-apps-compiler` as a mandatory pre-emission step. Adapted from the Azure Logic Apps Migration Agent reference.
---

# Scaffold a Logic Apps Standard project

> **When**: Run this BEFORE emitting any `<FlowName>/workflow.json` or any sibling `Functions/*.cs`. The scaffold puts every file the LA Standard runtime + VS Code extension expect in place, so flows can be added incrementally without retro-fixing project plumbing.
>
> **Where**: The project root is `<integrationFolder>/app/` (e.g. `specs/<domain>/001-<slug>/app/`).

## 0. Prerequisites

- `<integrationFolder>` exists.
- `integration-ir.yaml` validates and the IA-decision (`logic-apps-planning-rules` section 1) is recorded.
- `azure.yaml` at the integration root references `./app` (or will be created in step 8).

## 1. Procedure (8 steps)

1. **Create folders** -> `app/`, `app/Artifacts/Maps/`, `app/Artifacts/DataMapper/`, `app/Artifacts/Liquid/`, `app/Artifacts/Schemas/`, `app/lib/custom/net8/`, `app/workflow-designtime/`, `app/.vscode/`, `app/tests/`.
2. **Emit runtime files** -> `host.json`, `connections.json` (bare), `parameters.json` (bare), `local.settings.json`.
3. **Emit per-environment app settings** -> `appsettings.dev.json`, `appsettings.prod.json`. These are merged into the deployed app's settings by Bicep.
4. **Emit identity wiring** -> `identity-role-assignments.json` (consumed later by `azure-bicep-author`).
5. **Emit toolchain pins** -> `global.json` (`.NET 8`), `.funcignore`, `.gitignore`.
6. **Emit designer support** -> `workflow-designtime/host.json`, `workflow-designtime/local.settings.json`. Required by the VS Code Logic Apps Standard extension; without these the designer fails to load.
7. **Emit VS Code workspace files** -> `.vscode/settings.json`, `.vscode/launch.json`, `.vscode/extensions.json`, `.vscode/tasks.json`. The Logic Apps Standard extension does not reliably auto-create `tasks.json`; emit the standard `func: host start` task up front so F5 and design-time startup are consistent.
8. **Emit integration-root files (one level up)** -> `<integrationFolder>/azure.yaml` and `<integrationFolder>/<slug>.code-workspace` if not already present.

After step 8 the project boots locally with `func host start` and opens cleanly in VS Code via Open Folder. Flows and functions can now be added.

## 2. File manifest (18 files)

| # | Path (relative to `app/` unless noted) | Owner | Notes |
|---|---|---|---|
| 1 | `host.json` | scaffold | Extension bundle pin |
| 2 | `connections.json` | scaffold (bare) | Filled by `azure-connections-binder` |
| 3 | `parameters.json` | scaffold (bare) | Filled per-flow by compiler |
| 4 | `local.settings.json` | scaffold | Local dev only - never deployed |
| 5 | `appsettings.dev.json` | scaffold | Merged at deploy by Bicep |
| 6 | `appsettings.prod.json` | scaffold | Merged at deploy by Bicep |
| 7 | `identity-role-assignments.json` | scaffold (bare) | Filled by binder |
| 8 | `global.json` | scaffold | Pins `.NET 8.0.x` |
| 9 | `.funcignore` | scaffold | Excludes from `func` deploy |
| 10 | `.gitignore` | scaffold | bin/obj/.azure/Azurite |
| 11 | `workflow-designtime/host.json` | scaffold | Designer mode |
| 12 | `workflow-designtime/local.settings.json` | scaffold | `node` runtime - designer-only, intentional |
| 13 | `.vscode/settings.json` | scaffold | LA Standard extension settings |
| 14 | `.vscode/launch.json` | scaffold | F5 debugging |
| 15 | `.vscode/extensions.json` | scaffold | Recommended extensions |
| 16 | `.vscode/tasks.json` | scaffold | Standard `func: host start` task for VS Code |
| 17 | `../azure.yaml` (integration root) | scaffold | azd service map |
| 18 | `../<slug>.code-workspace` (integration root) | scaffold | Workspace file |

**Folders also created (no file content):** `Artifacts/Maps/`, `Artifacts/DataMapper/`, `Artifacts/Liquid/`, `Artifacts/Schemas/`, `lib/custom/net8/`, `tests/`.

## 3. Verbatim file content

### 3.1 `host.json`

```json
{
  "version": "2.0",
  "extensionBundle": {
    "id": "Microsoft.Azure.Functions.ExtensionBundle.Workflows",
    "version": "[1.*, 2.0.0)"
  },
  "extensions": {
    "workflow": {
      "settings": {
        "Runtime.Backend.VariableOperation.MaximumStatelessVariableSize": "1024000"
      }
    }
  },
  "logging": {
    "logLevel": {
      "default": "Information",
      "Host.Function.Console": "Trace"
    },
    "applicationInsights": {
      "samplingSettings": {
        "isEnabled": true,
        "excludedTypes": "Request"
      }
    }
  }
}
```

### 3.2 `connections.json` (bare)

```json
{
  "managedApiConnections": {},
  "serviceProviderConnections": {}
}
```

### 3.3 `parameters.json` (bare)

```json
{}
```

### 3.4 `local.settings.json`

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_INPROC_NET8_ENABLED": "1",
    "FUNCTIONS_WORKER_RUNTIME": "dotnet",
    "APP_KIND": "workflowapp",
    "AzureWebJobsFeatureFlags": "EnableMultiLanguageWorker",
    "ProjectDirectoryPath": "<absolute-path-to-logicAppName-folder>",
    "WORKFLOWS_SUBSCRIPTION_ID": ""
  }
}
```

> Never check real secrets into `local.settings.json`. Local-only values live here; deployment values come from `appsettings.<env>.json` + Bicep `@secure()` parameters.

### 3.5 `appsettings.dev.json`

```json
{
  "FUNCTIONS_INPROC_NET8_ENABLED": "1",
  "FUNCTIONS_WORKER_RUNTIME": "dotnet",
  "FUNCTIONS_EXTENSION_VERSION": "~4",
  "AzureWebJobsStorage__accountName": "<set-by-bicep>",
  "WEBSITE_CONTENTSHARE": "<set-by-bicep>",
  "APPLICATIONINSIGHTS_CONNECTION_STRING": "<set-by-bicep>",
  "WORKFLOWS_TENANT_ID": "<set-by-bicep>",
  "WORKFLOWS_SUBSCRIPTION_ID": "<set-by-bicep>",
  "WORKFLOWS_RESOURCE_GROUP_NAME": "<set-by-bicep>",
  "WORKFLOWS_LOCATION_NAME": "<set-by-bicep>"
}
```

### 3.6 `appsettings.prod.json`

Same shape as `appsettings.dev.json`. Bicep emits both via `parameters.<env>.bicepparam`.

### 3.7 `identity-role-assignments.json` (bare)

```json
{
  "identity": {
    "type": "UserAssigned"
  },
  "roleAssignments": []
}
```

### 3.8 `global.json`

```json
{
  "sdk": {
    "version": "8.0.100",
    "rollForward": "latestFeature"
  }
}
```

### 3.9 `.funcignore`

```
*.md
.git*
.vscode
local.settings.json
test
tests
tests-mstest
appsettings.*.json
.azure
.github
```

### 3.10 `.gitignore`

```
bin/
obj/
.azure/
.azurite/
__azurite_*
__blobstorage__/
__queuestorage__/
local.settings.json
*.user
```

### 3.11 `workflow-designtime/host.json`

```json
{
  "version": "2.0",
  "extensionBundle": {
    "id": "Microsoft.Azure.Functions.ExtensionBundle.Workflows",
    "version": "[1.*, 2.0.0)"
  },
  "extensions": {
    "workflow": {
      "settings": {
        "Runtime.WorkflowOperationDiscoveryHostMode": "true"
      }
    }
  }
}
```

Keep this file minimal, but include `Runtime.WorkflowOperationDiscoveryHostMode`; the VS Code designer relies on it to enumerate operations from the design-time host.

### 3.12 `workflow-designtime/local.settings.json`

```json
{
  "IsEncrypted": false,
  "Values": {
    "APP_KIND": "workflowapp",
    "ProjectDirectoryPath": "<absolute-path-to-logicAppName-folder>",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "AzureWebJobsSecretStorageType": "Files"
  }
}
```

> `FUNCTIONS_WORKER_RUNTIME=node` is intentional and required for the **designtime host only** - it does NOT affect the deployed app. The Logic Apps designer extension uses the Node-based designtime host to provide the visual designer; the runtime app uses in-process `dotnet` (per `local.settings.json`).

### 3.13 `.vscode/settings.json`

```json
{
  "azureLogicAppsStandard.projectLanguage": "JavaScript",
  "azureLogicAppsStandard.projectRuntime": "~4",
  "debug.internalConsoleOptions": "neverOpen",
  "azureFunctions.suppressProject": true
}
```

### 3.14 `.vscode/launch.json`

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run/Debug logic app in app/ with local functions",
      "type": "logicapp",
      "request": "launch",
      "funcRuntime": "coreclr",
      "customCodeRuntime": "coreclr",
      "isCodeless": true
    }
  ]
}
```

> Keep the debug label generic. The workspace already targets the fixed `app/` project root.

### 3.15 `.vscode/extensions.json`

```json
{
  "recommendations": [
    "ms-azuretools.vscode-azurelogicapps",
    "ms-azuretools.vscode-azurefunctions",
    "ms-dotnettools.csharp"
  ]
}
```

### 3.16 `.vscode/tasks.json`

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "generateDebugSymbols",
      "command": "${config:azureLogicAppsStandard.dotnetBinaryPath}",
      "args": ["${input:getDebugSymbolDll}"],
      "type": "process",
      "problemMatcher": "$msCompile"
    },
    {
      "type": "shell",
      "command": "${config:azureLogicAppsStandard.funcCoreToolsBinaryPath}",
      "args": ["host", "start"],
      "options": {
        "env": {
          "PATH": "${config:azureLogicAppsStandard.autoRuntimeDependenciesPath}\\NodeJs;${config:azureLogicAppsStandard.autoRuntimeDependenciesPath}\\DotNetSDK;$env:PATH"
        }
      },
      "problemMatcher": "$func-watch",
      "isBackground": true,
      "label": "func: host start",
      "group": {
        "kind": "build",
        "isDefault": true
      }
    }
  ],
  "inputs": [
    {
      "id": "getDebugSymbolDll",
      "type": "command",
      "command": "azureLogicAppsStandard.getDebugSymbolDll"
    }
  ]
}
```

### 3.17 `../azure.yaml` (integration root)

```yaml
name: <slug>
metadata:
  template: spec2integration-azure@1.0.0
# Add services only for stand-alone Function Apps. Logic Apps Standard
# content under ./app is package-deployed separately.
```

### 3.18 `../<slug>.code-workspace` (integration root)

```jsonc
{
  "folders": [
    { "name": "logicapp", "path": "app" }
    // Add: { "name": "Functions", "path": "Functions" }   when sibling project exists
    // Add: { "name": "tests-mstest", "path": "tests-mstest" }   when MSTest project exists
  ],
  "settings": {}
}
```

## 4. DO / DON'T

| Do | Don't |
|---|---|
| Keep flows at the project root (`app/<FlowName>/workflow.json`) | Wrap flows under `src/` - the LA Standard designer scans the project root and will not find them |
| Leave `connections.json` / `parameters.json` empty in the scaffold | Pre-populate these in the scaffold - they are filled by `azure-connections-binder` from the IR |
| Use in-process `dotnet` + `FUNCTIONS_INPROC_NET8_ENABLED=1` in `local.settings.json` | Use `dotnet-isolated` or `node` in the runtime `local.settings.json` |
| Emit `.vscode/tasks.json` with the standard `func: host start` task | Assume the LA Standard extension will auto-create it reliably |
| Pin `global.json` to `.NET 8.0.100` | Use `.NET 8.0` floating versions - older SDKs miss in-process WebJobs SDK templates |
| Place `Artifacts/Maps/<name>.xsl`, `Artifacts/DataMapper/<name>.lml`, `Artifacts/Liquid/<name>.liquid`, and `Artifacts/Schemas/<name>.xsd` for IR-declared transform/schema artifacts | Reference an `Artifacts/` transform/schema name with no file on disk (Sev-1 - workflow 404s at runtime) |

## 5. Verification gate

Before handing off to `azure-logic-apps-compiler` for flow emission, the scaffold MUST:

- [ ] All 18 files exist with the content above (or the agent's filled-in equivalents).
- [ ] `host.json` parses and contains the `Workflows` extension bundle reference.
- [ ] `workflow-designtime/host.json` sets `extensions.workflow.settings.Runtime.WorkflowOperationDiscoveryHostMode=true`.
- [ ] `local.settings.json` contains exactly the scaffolded Logic Apps runtime keys shown above, including `FUNCTIONS_WORKER_RUNTIME=dotnet`, `FUNCTIONS_INPROC_NET8_ENABLED=1`, `APP_KIND=workflowapp`, and an empty `WORKFLOWS_SUBSCRIPTION_ID`.
- [ ] `workflow-designtime/local.settings.json` `FUNCTIONS_WORKER_RUNTIME=node`.
- [ ] `workflow-designtime/local.settings.json` matches the reference scaffold shape above, including `APP_KIND=workflowapp`, `ProjectDirectoryPath`, `FUNCTIONS_WORKER_RUNTIME=node`, `AzureWebJobsStorage=UseDevelopmentStorage=true`, and `AzureWebJobsSecretStorageType=Files`.
- [ ] `.vscode/launch.json` uses the `logicapp` launch configuration shape shown above.
- [ ] `global.json` pins `.NET 8.0.x`.
- [ ] `azure.yaml` (integration root) points `infra.path` at `./infra` and does not model the Logic Apps Standard folder as an azd service.
- [ ] `Artifacts/Maps/`, `Artifacts/DataMapper/`, `Artifacts/Liquid/`, `Artifacts/Schemas/`, `lib/custom/net8/`, `tests/`, `workflow-designtime/`, `.vscode/` directories exist.

If any check fails, fix it before generating the first `workflow.json`.

---

_Adapted from the [Azure Logic Apps Migration Agent](https://github.com/Azure/logicapps-migration-agent) reference material._





