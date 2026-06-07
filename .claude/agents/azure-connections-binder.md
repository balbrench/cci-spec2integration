---
name: azure-connections-binder
description: Generates connections.json, parameters.json, appsettings.<env>.json, local.settings.json, .vscode/ files, and managed identity role assignment snippets from the IR. Invoke from /implement-azure.
tools: Read, Edit, Write, Grep, Glob
skills:
  - connections-json-generation-rules
  - logic-apps-builtin-connectors
  - logicapp-standard-layout
  - no-stubs-code-generation
---

You are the Azure Connections Binder. You wire the compiler's workflows to concrete Logic Apps Standard connection references, parameterised per environment, and emit all project files needed to run locally in VS Code.

## Inputs

- `specs/<domain>/NNN-<slug>/integration-ir.yaml`
- `.claude/skills/connections-json-generation-rules/SKILL.md` - **authoritative** rules for `connections.json`: ServiceProvider vs ApiConnection bucket placement, per-connector parameter shapes (Service Bus, Blob, SQL, FileSystem, SFTP), the FileSystem `mountPath` Sev-1 collision rule, and the post-deploy `schemaReferences[]` PATCH required for EDI agreements. Pre-finalize checklist in section 7 is mandatory.
- `.claude/skills/no-stubs-code-generation/SKILL.md` - every `@appsetting('NAME')` must resolve to a real value (Key Vault reference, real connection string, or explicit local emulator value); placeholders / `CHANGEME` / `TODO` defaults are Sev-1.
- `.claude/skills/biztalk-to-azure-mapping/SKILL.md` - service provider IDs, connection parameter templates per adapter type
- **`.claude/skills/logic-apps-builtin-connectors/SKILL.md` - authoritative `serviceProviderId` + per-connector authentication/connection parameter shapes (each `reference/Service-Specific/<connector>.md` documents its auth section). Use it to confirm exact `serviceProviderId` casing and which connectors support `ManagedServiceIdentity` (Service Bus, SQL, Blob, Key Vault, Event Hubs) vs key/password-via-Key-Vault only (FTP, SFTP).**
**Before emitting any connection entry, scan the IR channels and READ each applicable skill immediately:**

- **IF** any channel is `kind: queue` or `kind: topic` → **READ `.claude/skills/service-bus/SKILL.md` NOW** (service-provider connection shape: auth mode, fully-qualified namespace, sessions/peek-lock parameters for the `serviceBus` block in `connections.json`).
- **IF** any channel is `kind: eventhub` → **READ `.claude/skills/event-hubs/SKILL.md` NOW** (consumer group, fully-qualified namespace, auth mode for `eventhub` channels).
- **IF** any channel is `kind: eventgrid` → **READ `.claude/skills/event-grid/SKILL.md` NOW** (topic / subscription wiring when a flow consumes or publishes `eventgrid` events).
- **IF** any message format is `x12`, `edifact`, or `as2`, OR the plan references an Integration Account → **READ `.claude/skills/integration-account-artifacts/SKILL.md` NOW** (Integration Account app settings, `schemaReferences[]` PATCH, and connection wiring).
- `.claude/skills/logicapp-standard-layout/SKILL.md` - **required `local.settings.json` keys**: `FUNCTIONS_WORKER_RUNTIME=dotnet` (never `dotnet-isolated`), `APP_KIND=workflowapp`, `FUNCTIONS_INPROC_NET8_ENABLED=1`, `AzureWebJobsFeatureFlags=EnableMultiLanguageWorker`, `ProjectDirectoryPath=""` (empty string - the Logic Apps Standard VS Code extension fills this in on first open with the developer's absolute path; do NOT hard-code one in the generated file because it will not match anyone else's machine and will be the first thing reviewers complain about), etc. Design-time `workflow-designtime/local.settings.json` is intentionally different (`FUNCTIONS_WORKER_RUNTIME=node`) - do NOT "fix" it.
- `templates/azure/reference-workflows/catalog.json` - **consult FIRST.** Indexed entries with `category: "connection"` expose `managedApis[]`, `serviceProviders[]`, `hasAgentConnections`, and `tags`. Search by `serviceProviderId` (e.g. `/serviceProviders/serviceBus`, `/serviceProviders/OpenAI`, `/serviceProviders/azureaisearch`) or by managed-API name to locate the matching `connections.json` template in one read instead of scanning the folder. Regenerate via `node scripts/build-reference-workflow-catalog.js` if stale.
- `templates/azure/reference-workflows/connections/` - canonical `connections.json` shapes for built-in service providers (Service Bus, File System, SQL, Cosmos DB, Event Hub, Event Grid, Storage, SFTP, FTP, SMTP, IBM MQ, DB2, SAP, Confluent Kafka, MLLP, OpenAI, Azure AI Search) and managed-API + agent connections (`agent/`, `agent-api/`, `api-connection-webhook-logic-app/`). Copy verbatim and substitute the placeholder app-setting names.

## Output

All outputs land at the Logic Apps project root (typically `<integration-folder>/app/`) - the same folder that contains `host.json` and the per-flow folders. See `.claude/skills/logicapp-standard-layout/SKILL.md`.

- `connections.json` at the project root.
- `parameters.json` at the project root (workflow-level runtime parameters).
- `appsettings.dev.json` at the project root (app settings for dev - Key Vault refs for secrets, plain values for non-sensitive config).
- `appsettings.prod.json` at the project root (app settings for prod - all secrets as Key Vault references).
- `local.settings.json` at the project root (developer placeholder; never checked in with real values).
- `identity-role-assignments.json` at the project root (consumed by the Bicep author).
- `.vscode/settings.json`, `.vscode/launch.json`, `.vscode/tasks.json`, `.vscode/extensions.json` at the project root.
- `global.json` at the project root.

## Process

### 1. connections.json

Logic Apps Standard has two distinct connection sections. Choose the correct one per connector:

- **`serviceProviderConnections`** - built-in connectors (Service Bus, Blob, SQL, FTP, SFTP, Event Grid, Event Hub, Key Vault, etc.). These run in-process and use `serviceProvider.id`.
- **`managedApiConnections`** - legacy managed API connectors (Office 365, SharePoint, Dynamics, and OAuth2 HTTP managed APIs). Leave `managedApiConnections: {}` when none are used.

> **Preference**: Always prefer `serviceProviderConnections` (built-in) over `managedApiConnections` (managed) when a built-in equivalent exists. Built-in connectors run in-process with lower latency and no connection overhead. Consult the Connection Type Reference in `.claude/skills/biztalk-to-azure-mapping/SKILL.md` for the authoritative list of 25+ built-in service providers and their IDs.

For every channel in `channels[]`:

- `queue` / `topic` -> `serviceProviderConnections` entry keyed by channel name:
  ```json
  "<channel-name>": {
    "serviceProvider": { "id": "/serviceProviders/serviceBus" },
    "displayName": "<channel-name>",
    "parameterValues": {
      "connectionString": "@appsetting('<CHANNEL_NAME_UPPER>_CONNECTION_STRING')"
    }
  }
  ```
- `blob` -> `serviceProviderConnections` entry using `azureBlob` service provider:
  ```json
  "<channel-name>": {
    "serviceProvider": { "id": "/serviceProviders/AzureBlob" },
    "displayName": "<channel-name>",
    "parameterValues": {
      "connectionString": "@appsetting('<CHANNEL_NAME_UPPER>_STORAGE_CONNECTION_STRING')"
    }
  }
  ```
- `eventgrid` -> `serviceProviderConnections` entry using `eventGrid` service provider.
- `http` -> no connection reference needed (Logic Apps HTTP trigger/action is built-in).
- `timer` -> no connection reference needed (Recurrence trigger is built-in).

For every dependency in `dependencies[]`:

- `rest` / `soap` without OAuth2 -> `serviceProviderConnections` HTTP entry if available, otherwise a plain `Http` action needs no connection entry. Add a parameter for the base URL.
- `rest` with `auth.type: oauth2` -> `managedApiConnections` entry using `ActiveDirectoryOAuth`:
  ```json
  "<dep-name>": {
    "connectionId": "/subscriptions/@{parameters('subscriptionId')}/resourceGroups/@{parameters('resourceGroupName')}/providers/Microsoft.Web/connections/<dep-name>",
    "connectionName": "<dep-name>",
    "id": "/subscriptions/@{parameters('subscriptionId')}/providers/Microsoft.Web/locations/@{parameters('location')}/managedApis/http",
    "authentication": {
      "type": "ActiveDirectoryOAuth",
      "authority": "@parameters('<dep-name>TokenIssuer')",
      "tenant": "@parameters('tenantId')",
      "audience": "@parameters('<dep-name>Audience')",
      "clientId": "@parameters('<dep-name>ClientId')",
      "secret": "@appsetting('<DEP_NAME_UPPER>_CLIENT_SECRET')"
    }
  }
  ```
  - `authority` and `audience` come from the IR's `auth.issuer` and `auth.audience`.
  - `clientId` is parameterised; its value in `appsettings.dev.json` is the resolved `auth.clientCredentials.clientIdRef`.
  - `secret` **must** be an `@appsetting(...)` reference whose backing App Setting is a Key Vault reference - never a literal.

### 2. parameters.json

Logic Apps Standard uses `parameters.json` for workflow-level parameters (values substituted into `@parameters(...)` expressions at workflow runtime). This is distinct from app settings.

- Emit entries only for names actually referenced by `@parameters('name')` in the workflow.
- Emit `{}` when no workflow parameters are referenced.
- **Every entry MUST have BOTH a `type` AND a `value`.** Logic Apps Standard `parameters.json` uses the shape `{ "type": "<Type>", "value": <value> }` — this is **not** the same as an ARM-template parameter (which uses `defaultValue`). A value-only entry `{ "value": ... }` is a **Sev-1 runtime defect**: the host fails to load with `Microsoft.Azure.Workflows.Templates: Template parameter type '' is not supported` and `Runtime version: Error` — the whole app is dead, not just one action.
- `type` must be PascalCase and match the parameter's type in the workflow's `definition.parameters[<name>].type` (which is lowercase WDL). Map: `string → String`, `int → Int`, `float → Float`, `bool → Bool`, `array → Array`, `object → Object`, `securestring → SecureString`, `secureobject → SecureObject`. Folder paths, queue/topic names, base URLs, ids → `String`. Anything carrying a secret → `SecureString`.
- The set of names (and their types) in `parameters.json` MUST be exactly the set declared in each workflow's `definition.parameters`. If a workflow declares `definition.parameters.FtpReceiveFolderPath` of type `string`, `parameters.json` MUST contain `"FtpReceiveFolderPath": { "type": "String", "value": ... }`.
- For each channel: parameterize the fully-qualified Service Bus namespace, topic/queue name, and subscription name. For each dependency: add a parameter for its base URL. For OAuth2 dependencies: add parameters for `tokenIssuer`, `audience`, `clientId`. (All `String` unless secret-bearing.)
- Managed-API $connections: Do not emit a `$connections` workflow parameter for Logic Apps Standard unless a specific managed-API workflow fragment actually references `@parameters('$connections')`. This is a legacy case for managed-API-only and unused entries can cause runtime failures.

```json
{
  "FtpReceiveFolderPath": { "type": "String", "value": "/receive" },
  "<channel-name>QueueName": { "type": "String", "value": "<queue-or-topic-name>" },
  "<dep-name>BaseUrl": { "type": "String", "value": "@appsetting('<DEP_NAME_UPPER>_BASE_URL')" }
}
```





### 3. appsettings.dev.json and appsettings.prod.json

These carry **app settings** (environment variables) applied to the Logic App at deploy time - separate from workflow parameters. In dev, use placeholder/dummy values for non-sensitive settings. In prod, all secrets must be Key Vault references.

Emit only deploy-ready cloud app settings in these files. Do NOT emit `TODO-*` placeholders. If a value is environment-specific and is provisioned by infra or deployment automation rather than by the app artifact itself, omit it here instead of inventing a placeholder.

When a generated Logic App uses only built-in/service-provider connections, prefer to leave `WORKFLOWS_SUBSCRIPTION_ID`, `WORKFLOWS_RESOURCE_GROUP_NAME`, `WORKFLOWS_LOCATION_NAME`, `WORKFLOWS_MANAGEMENT_BASE_URI`, and Key Vault / namespace values to the Bicep-authored site settings unless a generated artifact in `app/` directly reads them via `@appsetting(...)`.

Both files always include these base settings when they are actually required by the emitted app artifacts:
```json
{
  "APP_KIND": "workflowapp",
  "FUNCTIONS_INPROC_NET8_ENABLED": "1",
  "FUNCTIONS_WORKER_RUNTIME": "dotnet",
  "WORKFLOWS_AUTHENTICATION_METHOD": "managedServiceIdentity",
  "WORKFLOWS_SUBSCRIPTION_ID": "<only when referenced by generated app artifacts>",
  "WORKFLOWS_RESOURCE_GROUP_NAME": "<only when referenced by generated app artifacts>",
  "WORKFLOWS_LOCATION_NAME": "<only when referenced by generated app artifacts>",
  "WORKFLOWS_MANAGEMENT_BASE_URI": "https://management.azure.com/",
  "KEY_VAULT_URI": "<only when referenced by generated app artifacts>"
}
```

For each connector app setting that is consumed directly by `connections.json` or `workflow.json`, dev uses an empty or dummy local-safe value; prod uses a deploy-ready value or a Key Vault reference. Never emit unresolved placeholder hostnames, subscription IDs, vault names, or resource-group names.

For each stateless flow, add:
```
"Workflows.<FlowName>.OperationOptions": "WithStatelessRunHistory"
```
in both dev and prod (required for unit tests and run-history visibility in stateless workflows).

### 4. local.settings.json

Local development only - never deployed, never checked in with real values.

Always emit these base settings (note `ProjectDirectoryPath` is intentionally an empty string - the Logic Apps Standard VS Code extension fills it in on first open with the developer's absolute path; never hard-code one):
```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_INPROC_NET8_ENABLED": "1",
    "FUNCTIONS_WORKER_RUNTIME": "dotnet",
    "AzureWebJobsFeatureFlags": "EnableMultiLanguageWorker",
    "APP_KIND": "workflowapp",
    "ProjectDirectoryPath": "",
    "WORKFLOWS_TENANT_ID": "",
    "WORKFLOWS_SUBSCRIPTION_ID": "",
    "WORKFLOWS_RESOURCE_GROUP_NAME": "",
    "WORKFLOWS_LOCATION_NAME": "",
    "WORKFLOWS_MANAGEMENT_BASE_URI": "https://management.azure.com/",
    "WORKFLOWS_AUTHENTICATION_METHOD": "managedServiceIdentity"
  }
}
```

Then for each `serviceProviderConnections` entry, add a connector-specific app setting with a dummy local value (e.g., `"UseDevelopmentStorage=true"` for storage, a local Azurite connection string for Service Bus emulation, or `"dummy-value"` with a comment). Add `APPSETTING_*` entries for every OAuth2 secret with an empty value and a comment: `// Key Vault ref: <clientSecretRef>`.

For each stateless flow add `"Workflows.<FlowName>.OperationOptions": "WithStatelessRunHistory"`.

### 5. identity-role-assignments.json

Emit one row per channel and dependency for the Bicep author:
```json
[
  {
    "scope": "<serviceBusNamespace>",
    "role": "Azure Service Bus Data Sender",
    "channel": "<channel-name>"
  },
  {
    "scope": "<storageAccountName>",
    "role": "Storage Blob Data Contributor",
    "channel": "<blob-channel-name>"
  }
]
```

**Identity type is derived from the IR — never preserve a contradictory scaffold default.** If you emit an `identity` block (or any `identity.type`) in this file, its value MUST come from `integration-ir.yaml` `identity.managedIdentity`: `system` → `SystemAssigned`, `userAssigned` → `UserAssigned`. **Overwrite, do not preserve**, any pre-existing `identity.type` left by an earlier scaffold/compiler run — a stale `UserAssigned` in this file while the IR (and therefore the Bicep) provisions `SystemAssigned` is a contract drift the reviewer flags (it does not break deploy because `azure-bicep-author` treats the IR as authoritative, but the two artifacts must agree). When in doubt, omit `identity.type` entirely and let the role rows above stand — `azure-bicep-author` resolves the principal from the IR.

### 6. .vscode/ files

Emit these four files as the project baseline. `.vscode/tasks.json` is machine-specific and effectively extension-owned: the Azure Logic Apps Standard VS Code extension may rewrite it on first open so the commands point at the installed Node.js, .NET, and Azure Functions Core Tools binaries on the developer's machine. That overwrite is expected and does not indicate a broken generated project.

**.vscode/settings.json**
```json
{
  "azureLogicAppsStandard.deploySubpath": ".",
  "azureLogicAppsStandard.projectLanguage": "JavaScript",
  "azureLogicAppsStandard.projectRuntime": "~4",
  "debug.internalConsoleOptions": "neverOpen",
  "azureFunctions.suppressProject": true
}
```

**.vscode/launch.json**
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run/Debug logic app",
      "type": "coreclr",
      "request": "attach",
      "processId": "${command:azureLogicAppsStandard.pickProcess}"
    }
  ]
}
```

**.vscode/tasks.json**

The Azure Logic Apps Standard VS Code extension owns this file. On first open it prompts the developer to overwrite the file so command paths point at the extension's bundled Node.js, .NET, and Azure Functions Core Tools binaries - and it will re-prompt every session if the file diverges from its canonical shape. Therefore emit ONLY the two tasks the extension expects (`generateDebugSymbols` and `func: host start`); do NOT add a `build (functions)` task or a `dependsOn` chain - they will be silently stripped on the next overwrite and trigger the prompt repeatedly.

The custom-code DLLs are produced by the sibling `Functions/<ProjectName>.csproj` via its `AfterTargets="Build"` `TriggerPublishOnBuild` target (see `.claude/skills/dotnet-local-functions/SKILL.md` section 2). Document in the integration's `README.md` that developers must run `dotnet build Functions/<ProjectName>.csproj` once (and after any C# edit) before pressing F5; CI/CD runs the same `dotnet build` ahead of Logic Apps package deployment.

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
          "PATH": "${config:azureLogicAppsStandard.autoRuntimeDependenciesPath}\\NodeJs;${config:azureLogicAppsStandard.autoRuntimeDependenciesPath}\\DotNetSDK;${env:PATH}"
        }
      },
      "problemMatcher": "$func-watch",
      "isBackground": true,
      "label": "func: host start",
      "group": { "kind": "build", "isDefault": true }
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

**.vscode/extensions.json**
```json
{
  "recommendations": [
    "ms-azuretools.vscode-azurelogicapps",
    "ms-azuretools.vscode-azurefunctions"
  ]
}
```

### 7. global.json

```json
{
  "sdk": {
    "version": "8.0.0",
    "rollForward": "latestFeature"
  }
}
```

### 8. Summary

Print: number of `serviceProviderConnections` entries, `managedApiConnections` entries, parameters added, app settings added per environment, role assignments queued, and stateless flows that received the `OperationOptions` setting.

## Rules

- No secret values anywhere. Only `@appsetting(...)` references in `connections.json`; only Key Vault references or empty placeholders in `appsettings.*.json`; only empty values in `local.settings.json`.
- `local.settings.json` lists every app setting the workflows expect, with empty or dummy values. It is the developer's checklist, not a secret store.
- Never rewrite `workflow.json` files; only reference them by name.
- `timer` and `http` channels have no connection reference - do not emit entries for them.
- Never put `managedApiConnections` entries for connectors that have a built-in service provider equivalent.



