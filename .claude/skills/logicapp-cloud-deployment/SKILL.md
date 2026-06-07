---
name: logicapp-cloud-deployment
description: Authoritative rules for deploying a Logic Apps Standard project (`app/`) to Azure via Bicep + azd. Covers WS1 plan settings, mandatory runtime app settings, mountPath restrictions, `@secure()` parameter handling, content deployment, and post-deploy validation. Consumed by `azure-bicep-author`, `azure-cicd-author`, and the `/deploy-azure` prompt. Adapted from the Azure Logic Apps Migration Agent reference.
---

# Logic Apps Standard - Cloud Deployment Rules

> **Purpose**: Deploy Logic Apps Standard consistently from the canonical integration layout: `app/`, `infra/`, and `azure.yaml` at the integration root. This skill prevents the failure modes that most often break production deployments: missing runtime app settings, bad Azure Files mount paths, shell truncation of `@secure()` values, and malformed deployment packages.

This skill assumes the canonical layout from `logicapp-standard-layout`:

```text
<integration-root>/
  app/
  infra/
  azure.yaml
```

The Logic App content is deployed from `app/`. Do not model the Logic App itself as an `azd` application service.

---

## 1. Deployment method

Deploy Logic Apps Standard in two distinct phases:

1. **Infrastructure**: provision the App Service Plan, Logic App site, storage account, file shares, managed identity, and any optional dependencies with Bicep. Use `azd provision` or `az deployment group create`.
2. **Content**: package the contents of `app/` and deploy that package to the already-provisioned Logic App Standard site.
3. **Local functions**: build the sibling `Functions/*.csproj` project only when that project exists. Its published outputs must land under `app/lib/custom/net8/` before the Logic App package is created.

Rules:

- `azure.yaml` is infra-only for the Logic App portion of the solution.
- Do not use `azd deploy` to build or publish `app/` as if it were a normal Function App project.
- Do not expect a `.csproj` under `app/`. Logic Apps Standard content is not an MSBuild project.
- Do not upload workflow content by copying files into the runtime Azure Files content share. Azure Files backs the runtime; it is not the deployment transport.

### 1a. Parameter wiring — `azd` vs `az deployment` (both must work) [VERIFIED]

The two infra commands read **different** parameter files, so emit BOTH:

- **`az deployment group create --parameters infra/parameters.<env>.bicepparam`** reads the `.bicepparam` files. (Use these for `@secure()` / `&`-containing values, §4.)
- **`azd provision` reads `infra/main.parameters.json`** — it does **NOT** read `.bicepparam`. If `main.parameters.json` is absent, `azd provision` prompts for every `main.bicep` param that has no default and **hangs** in CI / non-interactive runs. So `main.parameters.json` is mandatory whenever the azd path is used, wiring the no-default params via `${VAR}` env-var substitution (`azd env set <VAR> <value>`), e.g.:
  ```json
  { "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
    "contentVersion": "1.0.0.0",
    "parameters": {
      "env": { "value": "${BIZTALK_ENV=dev}" },
      "sqlAadAdminObjectId": { "value": "${SQL_AAD_ADMIN_OBJECT_ID}" },
      "sqlAadAdminLogin":    { "value": "${SQL_AAD_ADMIN_LOGIN}" } } }
  ```
- Never default a required identity param (e.g. `sqlAadAdminObjectId`) to an all-zeros placeholder GUID — it compiles but the SQL/RBAC deploy fails at runtime with no signal. Require it via env var so the gap is explicit.

### 1b. Deployment scope ↔ `azd` resource group [VERIFIED]

`azd provision` does **not** create a resource group for a `targetScope = 'resourceGroup'` template — it expects one to exist and reads `AZURE_RESOURCE_GROUP` from the azd env. Two coherent choices, pick one:

- **Subscription-scoped `main.bicep`** (`targetScope = 'subscription'` + a `Microsoft.Resources/resourceGroups` resource, modules `scope:`d into it) — azd creates the RG itself; nothing extra to set. Preferred for azd.
- **Resource-group-scoped `main.bicep`** — then the operator MUST pre-create the RG (`az group create -n <rg> -l <loc>`) and `azd env set AZURE_RESOURCE_GROUP <rg>` before `azd provision`. Document this in `azure.yaml` and the deploy notes.

Always run `az bicep build --file infra/main.bicep` (exit 0) before either infra command — a non-compiling template (e.g. a space-separated `@allowed` array, `BCP236`) blocks both paths. The `azure-bicep-author`/`azure-reviewer` agents cannot compile (no Bash); the orchestrating `/implement-azure` and `/deploy-azure` (step 7) commands run the compile gate.

### Package root rule

The archive root must be the contents of `app/`.

Valid archive layout:

```text
host.json
connections.json
OrderIntakeFlow/workflow.json
Artifacts/Schemas/...
lib/custom/net8/...
```

Invalid archive layout:

```text
app/host.json
site/wwwroot/host.json
LogicAppProject/app/host.json
```

If the archive root is wrong, the runtime will not discover workflows correctly.

---

## 2. Required runtime app settings - MUST be in Bicep

> **Sev-1 rule:** all Logic App app settings must be declared in Bicep on the `Microsoft.Web/sites` resource. Do not manage required settings with ad hoc CLI commands after provisioning. A later Bicep redeploy will replace the site settings set and remove anything not declared in the template.

Minimum required settings for every Logic App Standard site:

| Setting | Value | Why |
|---|---|---|
| `AzureWebJobsStorage` | Storage connection string | Runtime state and scale controller dependencies. |
| `WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` | Same storage connection string | Required on WS1 so the runtime can mount its content share. |
| `WEBSITE_CONTENTSHARE` | Logic App name or derived share name | Runtime content share. |
| `FUNCTIONS_EXTENSION_VERSION` | `~4` | Required runtime version. |
| `FUNCTIONS_INPROC_NET8_ENABLED` | `1` | Enables .NET 8 in-process host for `lib/custom/net8/`. |
| `APP_KIND` | `workflowapp` | Required site identity. |
| `FUNCTIONS_WORKER_RUNTIME` | `dotnet` | Logic Apps Standard uses `dotnet`, not `dotnet-isolated`. |
| `WORKFLOWS_SUBSCRIPTION_ID` | `subscription().subscriptionId` | Artifact resolution and runtime metadata. |
| `WORKFLOWS_TENANT_ID` | `subscription().tenantId` | ARM-scoped authentication. |
| `WORKFLOWS_RESOURCE_GROUP_NAME` | `resourceGroup().name` | Artifact resolution and runtime metadata. |
| `WORKFLOWS_LOCATION_NAME` | `resourceGroup().location` | Artifact resolution and runtime metadata. |
| `WORKFLOWS_MANAGEMENT_BASE_URI` | `environment().resourceManager` | ARM base URI. |

If the workflow uses an Integration Account, also set:

| Setting | Value | Notes |
|---|---|---|
| `WORKFLOWS_INTEGRATION_ACCOUNT_ID` | Full Integration Account resource ID | Required for Integration Account backed artifacts. |

Rules:

- Keep the required runtime settings in Bicep even when the site already exists.
- Do not set `ProjectDirectoryPath` in Azure. That setting is local-only.
- Do not change `FUNCTIONS_WORKER_RUNTIME` to `dotnet-isolated`, `node`, or any other worker value.
- If the pack introduces additional required settings for a specific connector or artifact type, those settings must also be declared in Bicep.

---

## 3. App Service Plan and site shape

Use Logic Apps Standard on Workflow Standard plans.

Reference App Service Plan:

```bicep
resource appServicePlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: appServicePlanName
  location: location
  sku: {
    tier: 'WorkflowStandard'
    name: 'WS1'
  }
  kind: 'elastic'
  properties: {
    elasticScaleEnabled: false
  }
}
```

Reference Logic App site:

```bicep
resource logicApp 'Microsoft.Web/sites@2023-01-01' = {
  name: logicAppName
  location: location
  kind: 'functionapp,workflowapp'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      netFrameworkVersion: 'v8.0'
      use32BitWorkerProcess: false
      appSettings: [
        // Required settings from Section 2
      ]
    }
  }
}
```

Rules:

- `kind` must be exactly `functionapp,workflowapp`.
- The plan SKU must be Workflow Standard, not Consumption App Service SKUs.
- Keep `httpsOnly: true` unless a documented platform requirement says otherwise.
- Use managed identity for downstream Azure access. Do not embed secrets in generated files.

---

## 4. `@secure()` parameters with `&` characters

> **Sev-1 deployment risk:** callback URLs, SAS URIs, and connection strings frequently contain `&`. Passing them inline on the shell command line will eventually break because the shell treats `&` as an operator.

Rule:

- Always place `@secure()` values in a `.bicepparam` file.
- Never pass `@secure()` values inline with `--parameters key=value`.

Expected layout:

```text
infra/
  main.bicep
  parameters.dev.bicepparam
  parameters.prod.bicepparam
```

Example:

```bicep
using './main.bicep'

param integrationAccountCallbackUrl = 'https://prod-xx.logic.azure.com/...?...&sp=%2F%2F%2A&sv=1.0&sig=...'
```

Deployment invocation:

```powershell
az deployment group create `
  --resource-group $rg `
  --template-file infra/main.bicep `
  --parameters infra/parameters.prod.bicepparam
```

If a value is sensitive or contains shell-significant characters, put it in the `.bicepparam` file.

---

## 5. File System connector `mountPath` restrictions

Logic Apps Standard on Windows uses Azure Files mounts for the File System built-in service provider.

Reference shape:

```bicep
azureStorageAccounts: {
  appfiles: {
    type: 'AzureFiles'
    accountName: storageAccount.name
    shareName: fileShareName
    mountPath: fileSystemMountPath
    accessKey: storageAccount.listKeys().keys[0].value
  }
}
```

Rules:

| Rule | Reason |
|---|---|
| `mountPath` must be a **single subdirectory UNDER `/mounts`**, e.g. `/mounts/fileshare` — NOT `/mounts` itself, and NOT a nested path like `/mounts/a/b` | **[VERIFIED]** Azure rejects the deploy with `BadRequest: Invalid MountPath ... MountPath can only be a single subdirectory of \mounts` if you mount at `/mounts` or deeper than one level. |
| `mountPath` must not be `/home`, `/home/site`, or `/home/site/wwwroot` | Those paths are reserved for runtime content. |
| `mountPath` must exactly match the `FileSystem_mountPath` / `FILESYSTEM_MOUNT_PATH` app setting | The connector resolves through the app setting. |
| The Azure Files `shareName` is independent of `WEBSITE_CONTENTSHARE` | User file mounts and runtime content are different shares. |

Additional rules:

- Do not put credentials such as username or password in `connections.json` for the built-in File System provider when the Azure Files mount supplies the access.
- Keep the runtime content share and the File System share separate.
- A deployment can succeed while the mount is still wrong; the failure only appears on first connector use. Treat path mismatches as deployment defects, not runtime incidents.
- **The mount path is a single subdirectory of `/mounts` (e.g. `/mounts/fileshare`); workflow FileSystem actions then use paths RELATIVE to that mount.** Reconcile three things to the SAME value and shape:
  1. The `azureStorageAccounts.<id>.mountPath` (Azure Files mount) = a single subdir, e.g. `/mounts/fileshare` (NOT `/mounts`, NOT two levels deep — see the table above; the deploy fails otherwise).
  2. The `FILESYSTEM_MOUNT_PATH` / `FileSystem_mountPath` app setting (the connector's root) = the **same** `/mounts/fileshare`.
  3. Each workflow FileSystem action's path = **relative** under that root (e.g. `xml-mapping/Input`, `purchase-errors/ErrorPort`) so they resolve to `/mounts/fileshare/xml-mapping/Input`, `/mounts/fileshare/purchase-errors/ErrorPort`, etc. The "lowest common ancestor" concept applies to those RELATIVE action paths (they must all sit under the one mounted root), NOT to the mount path itself — do not set the mount/app-setting to `/mounts` to "cover" sibling folders; mount one subdir and keep the sibling folders relative beneath it.
  The Bicep-emitted app setting **wins over** the package `appsettings.*.json` at deploy, so `main.bicep`'s `fileSystemMountPath` param/default must carry the `/mounts/<subdir>` value and the `azureStorageAccounts` mount must use the identical value. Cross-check `azure-connections-binder`'s `rootFolder` (connections-json §3.4) against the Bicep param — a mismatch, or a `/mounts`-root mount, is a Critical reliability finding.

---

## 6. Content deployment - zip package from `app/`

After infrastructure is provisioned, create a deployment package from `app/` and deploy it to the Logic App site.

Example packaging and deploy flow:

```powershell
Compress-Archive -Path .\app\* -DestinationPath .\logicapp.zip -Force
az functionapp deployment source config-zip `
  --resource-group $rg `
  --name $logicAppName `
  --src .\logicapp.zip
az logicapp restart --name $logicAppName --resource-group $rg
```

Include in the package:

- `host.json`
- `connections.json`
- `parameters.json` when present
- `appsettings.<env>.json` when used by the runtime package
- Every `<FlowName>/workflow.json`
- The full `Artifacts/` tree
- The full `lib/custom/` tree

Exclude from the package:

- `local.settings.json`
- `.vscode/`
- `workflow-designtime/`
- `.azurite/` and Azurite state files
- `.git*`
- transient build output not already published into `lib/custom/`

Rules:

- Preserve relative paths exactly as they exist under `app/`.
- Do not create nested roots such as `app/host.json` or `site/wwwroot/...` inside the archive.
- If a sibling `Functions/*.csproj` exists, build it before packaging so `app/lib/custom/net8/` contains the final DLLs.
- If no sibling `Functions` project exists, do not run `dotnet build` just because a Logic App deployment is happening.
- Restart the Logic App after the package upload so the workflow runtime reloads content.
- Use `az logicapp restart`, not `az webapp restart`.

---

## 7. Deployment script safety

Every deployment script or prompt must enforce these rules:

- Use `.bicepparam` files for secure values and any value containing `&`.
- Verify `azure.yaml`, `infra/main.bicep`, and `app/` all exist before deployment begins.
- Run infrastructure provisioning before content deployment.
- Build sibling `Functions/*.csproj` only when present.
- Package only the deployable contents of `app/`.
- Restart the Logic App after package deployment.
- For Integration Account scenarios, provision and patch the Integration Account artifacts before the Logic App restart that reloads workflows.
- For File System scenarios, verify that `FileSystem_mountPath` matches the `azureStorageAccounts` `mountPath` exactly.

Reject these patterns as incorrect:

- `azd deploy` targeting the Logic App content directly
- MSBuild against `app/`
- manual portal edits to fix missing settings after Bicep deploy
- direct file-copy deployment into the runtime content share

---

## 8. Reference `main.bicep` skeleton

```bicep
@description('Name of the Logic App Standard resource')
param logicAppName string

@description('Name of the App Service Plan')
param appServicePlanName string

@description('Name of the Storage Account')
param storageAccountName string

@description('Location for all resources')
param location string = resourceGroup().location

@description('Integration Account resource ID')
param integrationAccountId string = ''

@description('File system mount path')
param fileSystemMountPath string = '/mounts/filesystem'

@description('Azure Files share name for File System connector scenarios')
param fileShareName string = 'app-files'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  parent: fileService
  name: fileShareName
  properties: {
    shareQuota: 5
  }
}

resource appServicePlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: appServicePlanName
  location: location
  sku: {
    tier: 'WorkflowStandard'
    name: 'WS1'
  }
  kind: 'elastic'
  properties: {
    elasticScaleEnabled: false
  }
}

resource logicApp 'Microsoft.Web/sites@2023-01-01' = {
  name: logicAppName
  location: location
  kind: 'functionapp,workflowapp'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      netFrameworkVersion: 'v8.0'
      use32BitWorkerProcess: false
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=core.windows.net'
        }
        {
          name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=core.windows.net'
        }
        {
          name: 'WEBSITE_CONTENTSHARE'
          value: toLower(logicAppName)
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'dotnet'
        }
        {
          name: 'FUNCTIONS_INPROC_NET8_ENABLED'
          value: '1'
        }
        {
          name: 'APP_KIND'
          value: 'workflowapp'
        }
        {
          name: 'WORKFLOWS_SUBSCRIPTION_ID'
          value: subscription().subscriptionId
        }
        {
          name: 'WORKFLOWS_TENANT_ID'
          value: subscription().tenantId
        }
        {
          name: 'WORKFLOWS_RESOURCE_GROUP_NAME'
          value: resourceGroup().name
        }
        {
          name: 'WORKFLOWS_LOCATION_NAME'
          value: location
        }
        {
          name: 'WORKFLOWS_MANAGEMENT_BASE_URI'
          value: environment().resourceManager
        }
        {
          name: 'WORKFLOWS_INTEGRATION_ACCOUNT_ID'
          value: integrationAccountId
        }
        {
          name: 'FileSystem_mountPath'
          value: fileSystemMountPath
        }
      ]
      azureStorageAccounts: {
        appfiles: {
          type: 'AzureFiles'
          accountName: storageAccount.name
          shareName: fileShareName
          mountPath: fileSystemMountPath
          accessKey: storageAccount.listKeys().keys[0].value
        }
      }
    }
  }
}

output logicAppName string = logicApp.name
output logicAppDefaultHostName string = logicApp.properties.defaultHostName
output logicAppResourceId string = logicApp.id
```

Use the optional Integration Account and File System pieces only when the generated integration actually needs them.

---

## 9. Post-deploy validation checklist

After infrastructure provisioning, content deployment, and `az logicapp restart`:

- [ ] The site starts cleanly.
- [ ] The required app settings from Section 2 exist on the deployed site.
- [ ] `FUNCTIONS_WORKER_RUNTIME` is exactly `dotnet`.
- [ ] The workflow management endpoint lists every deployed workflow.
- [ ] If Integration Account is used, its artifacts and agreement patching are complete before runtime validation.
- [ ] If File System is used, the deployed `FileSystem_mountPath` exactly matches the Azure Files mount definition.
- [ ] A smoke-test run succeeds end-to-end and the payload shape is correct, not just the run status.

If validation fails, fix the source Bicep, package contents, or Integration Account artifacts and redeploy. Do not patch the live site through the portal.

---

_Adapted from the [Azure Logic Apps Migration Agent](https://github.com/Azure/logicapps-migration-agent) reference material._
