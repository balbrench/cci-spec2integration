---
name: connections-json-generation-rules
description: Authoritative rules for generating `connections.json` for Logic Apps Standard. Covers ServiceProvider vs ApiConnection selection, FileSystem `mountPath` restrictions, Service Bus / Blob / SQL / SFTP parameter shapes, Integration Account connection wiring, and the post-upload `schemaReferences[]` PATCH required for EDI agreements. Adapted from the Azure Logic Apps Migration Agent reference.
---

# `connections.json` Generation Rules

> **Purpose**: Make the `connections.json` artifact deterministic. The Logic Apps Standard runtime resolves every workflow `ServiceProvider` and `ApiConnection` action against this file; small structural mistakes (wrong key, wrong parameter name, missing app-setting reference) deploy cleanly and then fail at the first invocation. This skill is the authoritative reference for `azure-connections-binder`.

This skill assumes the canonical layout from `logicapp-standard-layout` and is consumed alongside `workflow-json-rules` (which dictates how the workflow references the connection) and `logicapp-cloud-deployment` (which covers the Bicep + storage mount that backs `mountPath`).

---

## 1. File shape

`connections.json` lives at the project root, alongside `host.json` and the flow folders. It has exactly two top-level keys:

```json
{
  "managedApiConnections": { },
  "serviceProviderConnections": { }
}
```

- `serviceProviderConnections` — used by every built-in connector (`type: ServiceProvider` actions). Always preferred when a built-in exists.
- `managedApiConnections` — used by every `ApiConnection` / `ApiConnectionWebhook` action (managed API hosted in `/subscriptions/.../providers/Microsoft.Web/connections/...`). Used only when no built-in equivalent is available.

> **Rule:** Never place a `ServiceProvider` connection under `managedApiConnections` or vice versa — the runtime resolver looks in only one bucket per action type.

---

## 2. ServiceProvider vs ApiConnection — selection order

For every IR `channel` or `dependency` you bind, walk this list top-down and stop at the first match:

1. Built-in service provider exists in the official Logic Apps Standard list (Service Bus, Azure Blob, Event Grid, SQL, FileSystem, FTP, SFTP, AMQP, Event Hub, Cosmos DB, Storage Queues, Storage Tables, AzureFunctionOperation, AzureAutomation, ...) → `serviceProviderConnections`.
2. Managed API connector exists (any of the 1000+ `Microsoft.Web/connections` types — Salesforce, ServiceNow, SAP, Office 365, etc.) → `managedApiConnections`.
3. No connector exists → emit an `Http` action against the dependency contract; do NOT put a fake entry in `connections.json`.

Do NOT use `ApiConnection` for Service Bus, Blob, or SQL even though managed API versions exist — the built-in versions support managed identity, run in-process, and are dramatically cheaper.

---

## 3. ServiceProvider — connection shape

Every entry under `serviceProviderConnections` has this shape:

```json
{
  "<connectionName>": {
    "parameterValues": { /* connector-specific keys, all values are @appsetting('NAME') refs */ },
    "serviceProvider": {
      "id": "/serviceProviders/<providerId>"
    },
    "displayName": "<human-readable name>"
  }
}
```

Rules:

- `<connectionName>` must match the IR `channel` name (or dependency name) exactly. The workflow's `serviceProviderConfiguration.connectionName` resolves against this key.
- Every value inside `parameterValues` MUST be a `@appsetting('NAME')` reference — never an inline secret, connection string, or URL. The corresponding app setting goes in `local.settings.json` (local) and the Bicep `appSettings[]` (cloud).
- The `serviceProvider.id` value is fixed per connector; copy it from `templates/azure/reference-workflows/connections/` rather than guessing.

### 3.1 Service Bus

```json
"serviceBus": {
  "parameterValues": {
    "connectionString": "@appsetting('serviceBus_connectionString')"
  },
  "serviceProvider": { "id": "/serviceProviders/serviceBus" },
  "displayName": "serviceBus"
}
```

Authentication options:

- Connection string with SAS — single `connectionString` parameter as above.
- Managed identity — replace `connectionString` with `fullyQualifiedNamespace` and add `authProvider: { type: 'ManagedServiceIdentity' }`. Preferred per constitution Article V.

### 3.2 Azure Blob

```json
"AzureBlob": {
  "parameterValues": {
    "connectionString": "@appsetting('AzureBlob_connectionString')"
  },
  "serviceProvider": { "id": "/serviceProviders/AzureBlob" },
  "displayName": "AzureBlob"
}
```

Note the casing: `serviceProviderId` is `/serviceProviders/AzureBlob` (capital A, capital B). Lower-case variants are silently ignored.

### 3.3 SQL Server

```json
"sql": {
  "parameterValues": {
    "connectionString": "@appsetting('sql_connectionString')"
  },
  "serviceProvider": { "id": "/serviceProviders/sql" },
  "displayName": "sql"
}
```

- **Prefer the SQL connector's native managed-identity parameter set over embedding `Authentication=Active Directory Managed Identity` inside a `connectionString`.** The native form (`server`/`database` + `authentication: { type: 'ManagedServiceIdentity' }`, per `logic-apps-builtin-connectors/reference/Service-Specific/29-SQL-Server.md`) makes MI auth first-class and auditable. Using a KV-referenced connection string that *happens to* carry the MI auth keyword is acceptable (no inline secret) but weaker — `azure-reviewer` flags it (Article V). When you do use the connection-string form, the string MUST be a Key Vault reference and MUST contain `Authentication=Active Directory Managed Identity` (never a SQL login/password).

### 3.4 FileSystem (Azure Files mount)

> **⚠️ Sev-1 — `mountPath` collision will corrupt the runtime content share.**

```json
"fileSystem": {
  "parameterValues": {
    "rootFolder": "@appsetting('fileSystem_rootFolder')"
  },
  "serviceProvider": { "id": "/serviceProviders/fileSystem" },
  "displayName": "fileSystem"
}
```

Rules (cross-reference `logicapp-cloud-deployment` §5):

- The `rootFolder` value MUST resolve to the Bicep `azureStorageAccounts` `mountPath` for the user-files share — typically `/mounts/<purpose>` (e.g. `/mounts/edi-inbound`).
- The `mountPath` MUST NOT be `/home`, `/home/site`, or `/home/site/wwwroot`. Those paths are reserved by the runtime for the `WEBSITE_CONTENTSHARE` content; collisions silently overwrite workflow content during the first FileSystem write.
- The Azure Files share backing the user mount MUST be a different `shareName` from `WEBSITE_CONTENTSHARE`. Sharing one share for both is a Sev-1 misconfiguration.
- Do NOT place `username` / `password` parameters here — the in-process runtime authenticates via the storage-account key wired into the Bicep `azureStorageAccounts` block.
- **The FileSystem connection's `rootFolder` MUST contain every path any workflow action targets.** A `createFile`/`getFileContentV2` action can only reach paths **under** its connection's `rootFolder`; targeting a path outside it fails at runtime and is a Critical `azure-reviewer` finding. First enumerate every FileSystem path referenced across all workflows (read the `folderPath` params each FileSystem action uses).
  - **Preferred (matches the compiler's single `connectionName: "FileSystem"`):** root the one FileSystem connection at a **single subdirectory under `/mounts`** (e.g. `/mounts/fileshare`) that is the common parent of all those paths, and make each `*Folder` parameter the path **relative to that root**. **⚠️ The mount root MUST be `/mounts/<subdir>` — NOT `/mounts` itself** (Azure rejects a `/mounts` mount: *"MountPath can only be a single subdirectory of \mounts"* — verified). So if flows use `xml-mapping/...` and `purchase-errors/...`, set `rootFolder` to `/mounts/fileshare`, mount the Azure Files share at `/mounts/fileshare` in Bicep, and emit each `*Folder` param relative (`xml-mapping/input`, `purchase-errors/ErrorPort`) → they resolve to `/mounts/fileshare/xml-mapping/input`, etc. One connection, one Bicep mount at `/mounts/fileshare`, covers all. (The "lowest common ancestor" is computed over the *relative* action paths beneath the single mount — never widen the mount itself up to `/mounts`.)
  - **Alternative (only if there is no sensible common root):** emit one FileSystem `serviceProviderConnections` per mount root with **distinct connection names**, and ensure the compiler emitted each FileSystem action with the matching `connectionName` (coordinate via the IR channel name). Do not mix: if the workflows all use one `connectionName`, you MUST use the common-root approach.

### 3.5 SFTP

```json
"sftp": {
  "parameterValues": {
    "hostName":       "@appsetting('sftp_hostName')",
    "userName":       "@appsetting('sftp_userName')",
    "sshPrivateKey":  "@appsetting('sftp_sshPrivateKey')",
    "sshPrivateKeyPassphrase": "@appsetting('sftp_sshPrivateKeyPassphrase')",
    "portNumber":     "@appsetting('sftp_portNumber')"
  },
  "serviceProvider": { "id": "/serviceProviders/sftpWithSsh" },
  "displayName": "sftp"
}
```

Prefer `sftpWithSsh` over the password-based `sftp` provider. The private key must come from Key Vault via the app-setting reference syntax `@Microsoft.KeyVault(SecretUri=...)`.

---

## 4. ManagedApi — connection shape

```json
{
  "<connectionName>": {
    "api": {
      "id": "/subscriptions/@{appsetting('WORKFLOWS_SUBSCRIPTION_ID')}/providers/Microsoft.Web/locations/@{appsetting('WORKFLOWS_LOCATION_NAME')}/managedApis/<apiName>"
    },
    "connection": {
      "id": "/subscriptions/@{appsetting('WORKFLOWS_SUBSCRIPTION_ID')}/resourceGroups/@{appsetting('WORKFLOWS_RESOURCE_GROUP_NAME')}/providers/Microsoft.Web/connections/<connectionName>"
    },
    "connectionRuntimeUrl": "@appsetting('<connectionName>_connectionRuntimeUrl')",
    "authentication": {
      "type": "ManagedServiceIdentity"
    }
  }
}
```

Rules:

- `WORKFLOWS_SUBSCRIPTION_ID`, `WORKFLOWS_LOCATION_NAME`, `WORKFLOWS_RESOURCE_GROUP_NAME` MUST be present in the app settings. They are populated by Bicep (see `logicapp-cloud-deployment` §2). Without them, every managed-API call throws `BadRequest: Missing required parameter`.
- `connectionRuntimeUrl` is per-connection and is emitted by the `Microsoft.Web/connections` Bicep resource as an output — wire that output into an app setting in the same Bicep deployment. NEVER hard-code the URL.
- Use `ManagedServiceIdentity` whenever the target API supports it (Office 365, Salesforce, Common Data Service, SAP, ServiceNow). Fall back to `Raw` (API key in app setting) only when the connector has no AAD identity binding.
- One `Microsoft.Web/connections` resource per `managedApiConnections` entry. Do NOT share a single connection resource across multiple Logic Apps — connection auth state is per-app.

---

## 5. Integration Account connection — schema, map, and agreement wiring

When a workflow uses Integration Account artifacts (`Source: IntegrationAccount` on `Xslt`, `XmlValidation`, `XmlCompose`, `FlatFileDecoding`, `FlatFileEncoding`, `EdifactDecode`, `X12Decode`, `EdifactEncode`, `X12Encode`):

1. The Integration Account itself is bound at the Logic App resource level via the `integrationAccount` property on `Microsoft.Web/sites` (NOT in `connections.json`). Set it in Bicep, not here.
2. `connections.json` holds NO entry for the IA — the runtime discovers the linked IA through the site property.
3. Schema/map references inside actions use `name` (the IA artifact display name). The runtime resolves the name against the linked IA at execution time.

### 5.1 EDI agreement — `schemaReferences[]` post-upload PATCH

> **⚠️ Sev-1 — EDI decode fails with `UnexpectedSegment` if missed.**

When you provision an EDI agreement (`Microsoft.Logic/integrationAccounts/agreements`) via Bicep, the `content.x12.receiveAgreement.protocolSettings.schemaReferences[]` array (and the `sendAgreement` equivalent) is created EMPTY. The Bicep template cannot reference schemas that have not yet been uploaded — there is a deploy-order dependency.

Required post-deploy step:

1. Bicep deploys the Integration Account, schemas, maps, and agreements (with empty `schemaReferences`).
2. After deploy, run a PATCH against each agreement to populate `schemaReferences[]`. Each entry is:
   ```json
   {
     "messageId": "850",
     "senderApplicationId": "ZZ:SENDERID",
     "receiverApplicationId": "ZZ:RECEIVERID",
     "schemaVersion": "00401",
     "schemaName": "X12_00401_850"
   }
   ```
3. The PATCH script (PowerShell or `az rest`) belongs in the `infra/` post-deploy hook or in the `azd` `postdeploy` step — whichever the platform pack uses.

Without this step, `X12Decode` / `EdifactDecode` actions throw `UnexpectedSegment` or `AgreementNotFound` on every decode call, even though the agreement deployed successfully.

---

## 6. App settings parity — local vs cloud

Every `@appsetting('NAME')` reference inside `connections.json` MUST resolve in both environments:

- `local.settings.json` `Values` — for `func start` / VS Code debugging. Use empty placeholders or local emulator strings.
- Bicep `Microsoft.Web/sites` `appSettings[]` — for cloud. Use Key Vault references for secrets: `@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/serviceBus-connectionString/)`.

Drift detection: any app-setting NAME present in `connections.json` but absent from either of the two settings files is a Sev-1 deployment-time failure. The connections-binder MUST emit both files in lock-step with `connections.json` and surface any orphan reference.

---

## 7. Pre-finalize validation checklist

Before storing `connections.json`:

| Check | DO | DON'T |
|---|---|---|
| Bucket placement | ServiceProvider in `serviceProviderConnections`, ManagedApi in `managedApiConnections` | Mixing the two buckets |
| Built-in preference | Built-in service provider when one exists (Service Bus, Blob, SQL, ...) | ApiConnection for Service Bus / Blob / SQL when built-in exists |
| Secret placement | All values via `@appsetting('NAME')` references | Inline connection strings, SAS URIs, or passwords |
| FileSystem `rootFolder` | Resolves to a `/mounts/<purpose>` path matching the Bicep `azureStorageAccounts` mountPath | `/home`, `/home/site`, or `/home/site/wwwroot` |
| FileSystem share | Separate Azure Files share from `WEBSITE_CONTENTSHARE` | One share for both runtime content and user files |
| Managed API parameters | `WORKFLOWS_SUBSCRIPTION_ID` / `WORKFLOWS_LOCATION_NAME` / `WORKFLOWS_RESOURCE_GROUP_NAME` present in app settings | Hard-coded subscription / RG / location strings |
| Managed API auth | `ManagedServiceIdentity` whenever the connector supports it | `Raw` API key when AAD auth is available |
| Integration Account | NO entry in `connections.json`; bound via `Microsoft.Web/sites` `integrationAccount` property | Adding a fake IA entry to `serviceProviderConnections` |
| EDI agreements | Post-deploy `schemaReferences[]` PATCH step exists in `infra/` or `azure.yaml` | Empty `schemaReferences[]` after deploy (Sev-1) |
| App-settings parity | Every `@appsetting('NAME')` resolves in both `local.settings.json` and Bicep | Orphan references in either direction |
| Connection name | Matches the IR `channel` / dependency name verbatim | Renamed / abbreviated keys that diverge from the workflow's `connectionName` |

---

_Adapted from the [Azure Logic Apps Migration Agent](https://github.com/Azure/logicapps-migration-agent) reference material._
