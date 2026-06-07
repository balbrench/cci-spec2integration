# Logic Apps Standard — Curated Reference Workflows

These are minimal, **verified** `workflow.json` and `connections.json` fragments that the `azure-logic-apps-compiler` and `azure-connections-binder` agents copy from when generating outputs. The agents MUST use these as the literal source of `serviceProviderConfiguration`, `operationId`, and action `inputs` shape where applicable, and as the canonical control-flow shape for parser, branch, loop, and local-function patterns. They MUST NOT invent connector wire formats or control-flow structure when a matching fragment exists here.

Each subfolder pairs an action pattern with its canonical workflow JSON. Folders that need a paired connection live under `../connections/`. Per-operation service-provider snippets live under `service-providers/<provider>/<op>/`.

## Catalog (one-shot lookup)

[`catalog.json`](catalog.json) is a generated index of every entry in this folder. Each entry exposes `triggerTypes`, `actionTypes`, `serviceProviderIds`, `operationIds`, `apiConnectionRefs`, `hasSplitOn`, and `tags` so agents can find the right template by `operationId` (e.g. `createFile`, `getSecret`, `receiveMessages`) or `serviceProviderId` (e.g. `/serviceProviders/FileSystem`) in a single read. Regenerate after adding or editing any template:

```sh
node scripts/build-reference-workflow-catalog.js
```

The builder recursively scans `templates/azure/reference-workflows/`, classifies each `workflow.json` as `workflow` (top-level pattern) or `service-provider` (under `service-providers/<provider>/<op>/`), and each `connections.json` as `connection`. Provenance metadata (upstream path, copiedAt) flows through to catalog entries when a `_provenance.json` sibling is present.

| Folder | Pattern | When the compiler picks it |
|---|---|---|
| `xml-parse/` | `XmlParse` action with schema | Replacing BizTalk XMLReceive pipeline disassembler. IR message `format: xml` with a `nativeSchemaRef`. Always preferred over `xpath()`. |
| `xml-validate/` | `XmlValidation` action | IR step type `validate` against an XSD message. Or whenever a flow boundary requires schema enforcement. |
| `xml-transform-xslt/` | `Xslt` (Transform XML) action with map | IR `mappings[]` entry with `engine: xslt`. Map file goes in `Artifacts/Maps/`. Supports BizTalk-compiled XSLT including `<msxsl:script>` / `userCSharp` blocks. |
| `json-xml-xslt-json/` | `XmlCompose` → `Xslt` → `XmlParse` bridge | External contract is JSON, but the runtime/native map is XML/XSD-based. Use when a BizTalk-derived XSLT expects XML input while the HTTP or queue contract remains JSON. |
| `xml-compose/` | `XmlCompose` action | Constructing XML output from structured data. Replaces BizTalk XML Assembler pipeline. |
| `xml-parse-then-compose/` | `XmlParse` → `XmlCompose` chain | XML in → typed JSON edit → XML out. Common pattern for envelope translation. |
| `parse-json/` | `ParseJson` action | Structured JSON parsing at flow boundaries or after connector calls. Preferred over ad hoc `json()` access when a schema is known. |
| `flat-file-decode/` | `FlatFileDecoding` action | IR message `format: flat-file`. Schema (with BizTalk flat-file annotations preserved) goes in `Artifacts/Schemas/`. **Never wrap a flat-file parser in `InvokeFunction`.** |
| `flat-file-encode/` | `FlatFileEncoding` action | Outbound flat-file production. |
| `foreach/` | `Foreach` loop over an array | Repeating-item processing when `splitOn` is not applicable and the IR explicitly requires per-item iteration inside one workflow run. |
| `if-condition/` | `If` condition | Decide / branch pattern inside a workflow. |
| `switch/` | `Switch` with case branches | Multi-branch routing from a parsed value, often after JSON or XML normalization. |
| `ia-artifact-lookup/` | `IntegrationAccountArtifactLookup` action | Runtime lookup of a partner agreement / shared schema from the Integration Account. |
| `invoke-function/` | `InvokeFunction` action for a .NET local function | IR step references an artifact with `migrationHint: local-function`. **Only** for genuine custom .NET logic — see `workflow-json-rules` §7b. |
| `invoke-function-retry/` | `InvokeFunction` with explicit `retryPolicy` | Local-function invocation when the IR carries retry semantics that must be preserved rather than relying on implicit defaults. |
| `sb-trigger-splitOn/` | Service Bus trigger with `splitOn` | Batched queue/topic intake. Picks one item per workflow run. Always preferred over `For_each` wrappers. |
| `api-connection-trigger-splitOn/` | Managed-API trigger with `splitOn` | Connectors that have no built-in ServiceProvider equivalent (e.g. Office 365 mention notifications). |
| `event-hub-trigger/` | Event Hub trigger via `receiveEvents` operation | Modern streaming intake; replaces MSMQ patterns or BizTalk SQL polling against high-volume sources. |
| `csharp-script/` | `CSharpScriptCode` action invoking inline C# from `***scriptFile***` | Inline custom-code analogues for BizTalk helper-class calls when an out-of-process .NET Function is overkill. |
| `liquid-action/` | `liquid` action with `kind: JsonToJson` | JSON-to-JSON mappings declared in `mappings[]` with `engine: liquid` (also supports `JsonToText`, `XmlToJson` via `kind`). |
| `batch-send/` | `SendToBatch` action dispatching to a child Batch-trigger workflow | Outbound batching pattern. Parent workflow; pair with `batch-receive/`. |
| `batch-receive/` | Child workflow with `Batch` trigger and release criteria | Inbound batching pattern. Pair with `batch-send/`. Supports both `messageCountLimit` and `recurrence` release criteria. |
| `x12-agreement/` | X12 receive + send agreement configuration | Logic Apps Integration Account `Microsoft.Logic/integrationAccounts/agreements` resource for any X12 EDI flow migrated from BizTalk. Carries framing, envelope, acknowledgement, validation, processing, schema references. |
| `http-request-response/` | `Request` trigger + `Response` action | Greenfield synchronous HTTP API entry point. IR flow with an inbound HTTP channel. `Response` action MUST have `kind: "http"` to address the original caller. |
| `http-action/` | `Http` action with custom timeout, retry policy, dual response paths | Outbound HTTP call from a workflow with explicit timeout, 408 on timeout/failure, 200 on success. Use the `runtimeConfiguration.requestOptions.timeout` shape verbatim. |
| `http-async-response/` | Long-running HTTP with `operationOptions: Asynchronous` Response | Long-running HTTP request where the caller polls a status URL. The `Wait` action with `unit: Second` is the canonical delay shape — do not invent. |
| `agent/` | `Agent` action (Logic Apps Standard agent loop) with two tools — an `ApiConnection` weather lookup and an HTTP notify | Greenfield AI/agentic flow where the model needs to call external connectors. `tools.<name>.actions.*` defines each tool's sub-DAG; `agentparameters('...')` reads model-decided inputs. Pair with `../connections/agent/` or `../connections/agent-api/`. |
| `autonomous-agent/` | Multi-tool `Agent` loop with `Compose`-only tools (time, calculator, echo); higher iteration `count: 100` | Reasoning-heavy agent where tools are pure data transforms rather than connector calls. Demonstrates `@if(equals(agentparameters('operation'),'add'), ...)` style conditional logic inside a tool. |

## Per-operation service-provider snippets

Under `service-providers/<provider>/<op>/` — one folder per operationId. The compiler picks these by searching the catalog for the desired `operationId` + `serviceProviderId`.

### `service-providers/file-system/`

| Op | When the compiler picks it |
|---|---|
| `create-file/` | New file with body. IR `send` step against a `file-system` channel where the file does not yet exist. |
| `create-file-empty/` | Touch / marker file. Same as above but no body — use when the IR step intent is to signal completion. |
| `create-file-from-get-content/` | Read source + write destination with optional transform. Use over `copy-file/` when path layout changes or content is transformed. |
| `update-file/` | Overwrite an existing file at `filePath`. Different failure semantics from `createFile` when the target is missing. |
| `update-file-from-get-content/` | Read source + overwrite destination — replacement counterpart to `create-file-from-get-content/`. |
| `delete-file/` | Delete by path. Toggle `skipIfFileNotPresent: true` for idempotent retries. |
| `append-file/` | Append to end of an existing file. `createFileIfNotPresent: 'True'` upserts on first write. |
| `copy-file/` | Server-side copy. Prefer over `getFileContent → createFile` when no content transform is needed — keeps body off the run history. |
| `rename-file/` | In-place rename. `newName` is the new filename (not a full path). |
| `list-folder/` | Folder listing with `enableRecursiveListing` (string `'True'`/`'False'`). |
| `get-file-content/` | Read file body. Uses `getFileContentV2`. **Mandatory follow-up** to any FileSystem polling trigger per `workflow-json-rules` §5.2. |
| `get-file-metadata/` | Metadata only (size, lastModified, contentType). Use as cheap existence/size check or for routing on extension before `get-file-content/`. |
| `when-files-are-added/` | Polling trigger firing on new files only. Returns metadata — must chain `get-file-content/` before processing. |
| `when-files-are-added-or-modified/` | Polling trigger firing on both new + modified files. |

### `service-providers/key-vault/`

| Op | When the compiler picks it |
|---|---|
| `get-secret/` | Runtime secret lookup. Prefer over baking values into appsettings when the secret rotates frequently or the workflow must react to rotation immediately. Auth: managed identity with `Key Vault Secrets User`. |
| `encrypt-decrypt-with-key/` | Round-trip encrypt + decrypt against an asymmetric Key Vault key (RSA-OAEP). Preserve the `@body('Encrypt_data_with_key')?['encryptedData']` cross-action reference shape. Auth: managed identity with `Key Vault Crypto User`. |

## Companion connections

| Folder under `../connections/` | When the binder picks it |
|---|---|
| `service-bus/` | Any flow with a queue/topic channel. |
| `file-system/` | Any flow with a File System channel (note the `mountPath` rule in `logicapp-cloud-deployment` §5). |
| `sql/` | Any flow that calls SQL via the built-in service provider. |
| `mllp/` | HL7 over MLLP — BizTalk HL7 accelerator migrations. |
| `sap/` | SAP service provider — three variants (SNC SSO, SNC with user/password, plain Basic on application server). Replaces BizTalk SAP adapter. |
| `sftp/` | SFTP built-in connector — preferred over the managed-API Sftp connector. |
| `ftp/` | FTP built-in connector (basic auth only). |
| `smtp/` | SMTP built-in connector. |
| `db2/` | IBM DB2 service provider. Replaces BizTalk DB2 adapter. NOTE: `serviceProvider.id` omits leading slash in upstream (preserved verbatim). |
| `event-hub/` | Event Hub service provider — connection-string variant (pair with `event-hub-trigger/`). For managed identity, switch `parameterSetName` to an AAD variant. |
| `event-grid-publisher/` | Event Grid publisher — both connection-string and AAD-OAuth (certificate) variants present. |
| `confluent-kafka/` | Confluent Kafka built-in connector — SASL_PLAIN username/password variant. |
| `ibm-mq/` | IBM WebSphere MQ service provider — replaces BizTalk MQSeries adapter. |
| `storage/` | Azure Storage service provider — bundles both `AzureBlob` and `azurequeues` connections. Use for Blob triggers/actions and Storage Queue patterns. Connection-string variant; switch `parameterSetName` for AAD/MI. |
| `cosmos-db/` | Azure Cosmos DB service provider — `serviceProviders/AzureCosmosDB`. Connection-string variant; switch `parameterSetName` for AAD/MI. |
| `openai/` | Azure OpenAI built-in service provider (`/serviceProviders/OpenAI`) — three parameter sets: `KeyAndEndpointConnection`, `ManagedServiceIdentity`, `ActiveDirectoryOAuth`. Endpoint always pulled from `openAI_openAIEndpoint` app setting. |
| `azure-ai-search/` | Azure AI Search built-in service provider (`/serviceProviders/azureaisearch`) — admin-key auth (dev) and ActiveDirectoryOAuth with client certificate (production). |
| `agent/` | Full agent-connection scaffold: a managed-API tool example (msnweather) plus four `agentConnections` variants — AzureOpenAI key, FoundryAgentService OAuth, APIM GenAI Gateway key, key-only model without resourceId. Compiler picks ONE per Agent action and references it via `inputs.parameters.modelConfigurations.<name>.referenceName`. |
| `agent-api/` | Minimal agent scaffold: one managed-API tool + one `agentConnection1` of type `model`. Prefer over `agent/` for greenfield single-model + single-tool flows. |
| `api-connection-webhook-logic-app/` | Managed-API connection block for `ApiConnectionNotification` webhook triggers. Pairs with `../api-connection-trigger-splitOn/` workflow. Office 365 is the canonical example — substitute the actual `managedApis/<name>` ID for the connector being subscribed to. |

## Provenance

Most templates mirrored, with attribution, from the **Azure Logic Apps Migration Agent** reference set:
<https://github.com/Azure/logicapps-migration-agent/tree/main/resources/referenceWorkflowsAndConnections>

The `http-request-response/`, `http-action/`, `http-async-response/`, `connections/storage/`, and `connections/cosmos-db/` templates were sourced from the **AVN-Agents agentic-integration-framework** catalog (originally from the Azure Logic Apps runtime reference corpus). See each folder's `_provenance.json` for the immediate upstream.

License: MIT (same as this repo). Each file is annotated with the upstream path so it can be refreshed.

## Refresh procedure

When upstream adds a new canonical pattern that we use:

1. Copy the upstream `workflow.json` (or `connections.json`) into a sibling folder here.
2. Add a `_provenance.json` next to it with `{ "upstream": "<path>", "sha": "<commit>", "copiedAt": "<ISO>" }`.
3. Update the table above.
4. Run `/lint-contracts` and `/review` to verify nothing in the existing pack regressed.
