---
name: logic-apps-builtin-connectors
description: Authoritative serviceProviderId + operationId reference for Logic Apps Standard built-in (service-provider) connectors — FTP, SFTP, File System, Service Bus, SQL Server, Blob, Key Vault, Event Hubs, Queue Storage, and 25+ more. Use to emit the correct ServiceProvider action/trigger wire format. Consumed by azure-logic-apps-compiler and azure-connections-binder. Bundles the official Microsoft built-in connector docs under reference/. Guessing an operationId is forbidden — the in-process runtime and unit-test host validate against the real connector manifests and reject wrong IDs.
---

# logic-apps-builtin-connectors skill

The authoritative source for **which `operationId` and `serviceProviderId` a built-in (service-provider) connector exposes**. The in-process Logic Apps runtime and the unit-test host (`Microsoft.Azure.Workflows.UnitTesting`) validate every action against the real connector manifest and throw `The operation ID '<x>' for service provider '<y>' is not valid` for a wrong ID. **Built-in service-provider operation IDs are DIFFERENT from the managed-API connector operation IDs** (e.g. FTP built-in read is `getFtpFileContentV2`, not the managed `getFileContentV2`). Never guess — look it up here.

## reference/ contents

- `reference/Service-Specific/` — 35 official connector docs (one per connector), each with full authentication parameters, action/trigger tables, and operation IDs. Key files: `17-FTP.md`, `27-SFTP.md`, `16-File-System.md`, `13-Azure-Service-Bus.md`, `29-SQL-Server.md`, `04-Azure-Blob-Storage.md`, `10-Azure-Key-Vault.md`, `08-Azure-Event-Hubs.md`, `12-Azure-Queue-Storage.md`, `23-IBM-MQ.md`, `26-SAP.md`, plus the index `Azure-Logic-Apps-Built-In-Connectors-Reference.md`.
- `reference/General/` — native operations (`http`, `recurrence`, `request/response`, `webhook`, `delay`, `sliding-window`, `http-swagger`).

**When emitting any `ServiceProvider` action or trigger, open the matching `reference/Service-Specific/<NN>-<Connector>.md` and copy the `operationId` + input parameter names verbatim.** The quick table below covers the connectors this pack emits most; the docs are the source of truth for everything else and for parameter shapes.

## Verified operationId quick-reference

All `serviceProviderId` values are `/serviceProviders/<Id>`. Casing matters.

### FTP — `serviceProviderId: /serviceProviders/Ftp` (`17-FTP.md`)
| Purpose | operationId |
|---|---|
| Trigger: file added/modified | `whenFtpFilesAreAddedOrModified` |
| Read file content | `getFtpFileContentV2` (legacy: `getFtpFileContent`) |
| Create file | `createFile` |
| Update / delete / list / metadata | `updateFile` · `deleteFtpFile` · `listFilesInFolder` · `getFileMetadata` / `getAllFileMetadata` · `extractArchive` |

> ⚠️ FTP does **not** have `getFileContentV2` or `whenFileIsAdded` — those are FileSystem/managed names. Using them throws at validation. (This was a real bug.)

### SFTP — `serviceProviderId: /serviceProviders/Sftp` (`27-SFTP.md`)
| Purpose | operationId |
|---|---|
| Trigger | `whenFilesAreAddedOrModified` (also `whenFileIsAddedOrModified`) |
| Read content | `getFileContentV2` (legacy `getFileContent`) |
| Upload | `uploadFileContent` |
| copy / rename / delete / list / metadata | `copyFile` · `renameFile` · `deleteFile` · `listFolder` · `getMetadata` |

### File System — `serviceProviderId: /serviceProviders/FileSystem` (`16-File-System.md`)
| Purpose | operationId |
|---|---|
| Trigger | `whenFilesAreAdded` · `whenFilesAreAddedOrModified` |
| Read content | `getFileContentV2` |
| Create | `createFile` · `createFileIfNotPresent` |
| append / update / delete / rename / copy / list / metadata | `appendFile` · `updateFile` · `deleteFile` · `renameFile` · `copyFile` · `listFolder` · `getFileMetadata` |

### Service Bus — `serviceProviderId: /serviceProviders/serviceBus` (`13-Azure-Service-Bus.md`)
| Purpose | operationId |
|---|---|
| **Queue trigger** | **`receiveQueueMessages`** (NOT `receiveMessages` — that ID does not exist) |
| Topic trigger | `receiveTopicMessages` |
| Send | `sendMessage` · `sendMessages` |
| Read (action) | `getMessagesFromQueueV2` · `getMessagesFromTopicV2` |
| complete / abandon / dead-letter / defer | `completeQueueMessageV2` · `abandonQueueMessageV2` · `deadLetterQueueMessageV2` · `deferQueueMessageV2` (and `*TopicMessageV2`, `*InSession` variants) |
| sessions | `getMessagesFromQueueSession`, `getDeferredMessageFromQueueSession`, … |

### SQL Server — `serviceProviderId: /serviceProviders/sql` (`29-SQL-Server.md`)
| Purpose | operationId |
|---|---|
| Run a query | `executeQuery` (inputs: `query`, `queryParameters`; results via `body(...)?['resultSets']?['Table1']`) |
| Stored procedure | `executeStoredProcedure` |
| Rows CRUD | `getRowsV2` (legacy `getRows`) · `insertRow` · `updateRows` · `deleteRows` · `getTables` |
| Row triggers | `whenARowIsInserted` · `whenARowIsModified` · `whenARowIsUpdated` · `whenARowIsDeleted` |

### Azure Blob — `serviceProviderId: /serviceProviders/AzureBlob` (`04-Azure-Blob-Storage.md`)
| Purpose | operationId |
|---|---|
| **Trigger** | **`whenABlobIsAddedOrModified`** (NOT `whenABlobIsAdded`) |
| **Upload** | **`uploadBlob`** (NOT `createBlob`) |
| Read | `readBlob` |
| copy / delete / list / metadata / SAS | `copyBlob` · `deleteBlob` · `listBlobs` / `listContainers` · `getBlobMetadata` · `getBlobSASUri` · `extractArchiveFromContent` |

### Key Vault — `serviceProviderId: /serviceProviders/keyVault` (`10-Azure-Key-Vault.md`)
| Purpose | operationId |
|---|---|
| Get secret | `getSecret` · `getSecretVersion` · `getSecretMetadata` |
| Keys (encrypt/decrypt) | `encryptDataWithKey` · `decryptDataWithKey` · `getKeyMetadata` |

### Event Hubs — `serviceProviderId: /serviceProviders/eventHub` (`08-Azure-Event-Hubs.md`)
| Purpose | operationId |
|---|---|
| Send | `sendEvent` · `sendEvents` |
| Receive (trigger) | `receiveEvents` |

### Azure Queue Storage — `serviceProviderId: /serviceProviders/azureQueues` (`12-Azure-Queue-Storage.md`)
| Purpose | operationId |
|---|---|
| Receive (trigger) | `receiveQueueMessages` |
| Get / delete / list | `getMessages` · `deleteMessage` · `listQueues` |

## Rules

1. **Look up before you emit.** For any connector not in the quick table (IBM MQ/DB2/3270/CICS/IMS, SAP, JDBC, RabbitMQ, Kafka, Cosmos DB, Table Storage, File Storage, SMTP, Dataverse, HL7, Informix, …), open its `reference/Service-Specific/<NN>-*.md` and copy the `operationId` + input parameter names.
2. **Built-in ≠ managed.** Built-in service-provider operation IDs differ from the managed-API connector. If you only know the managed-connector op name, find the built-in equivalent here.
3. **`-V2` suffix:** prefer the `V2` operation where both exist (`getFileContentV2`, `getRowsV2`, `completeQueueMessageV2`) — it is the current shape.
4. **Connection parameter shapes** for `connections.json` (server address, auth type, MI vs Key Vault) are in each doc's Authentication section — `azure-connections-binder` consults the same docs. FTP/SFTP have no managed-identity option (key/password via Key Vault); Service Bus, SQL, Blob, Key Vault, Event Hubs all support `ManagedServiceIdentity`.
5. Falling back to a guessed `operationId` when the doc names it is a **Sev-2** finding (mirrors the catalog rule in `workflow-json-rules`).
