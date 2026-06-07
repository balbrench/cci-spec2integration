---
name: biztalk-to-azure-mapping
description: One-to-one mapping of every BizTalk Server component (adapters, pipeline components, orchestration shapes, expressions, custom code, engine features) to its Azure Logic Apps Standard equivalent. Covers 170+ mappings with service provider IDs, operation names, connection parameters, and deployment scopes. Adapted from the Azure Logic Apps Migration Agent reference.
---

# BizTalk Server to Azure Logic Apps Standard — Component Migration Reference

> **One-to-one mapping of every BizTalk Server component to its Azure Logic Apps Standard equivalent.**
>
> Use this when compiling BizTalk-sourced IR flows to Logic Apps Standard `workflow.json`, `connections.json`, and Bicep modules. Cross-reference with `.claude/skills/eip-to-azure-mapping/SKILL.md` for EIP-level IR node compilation.

---

## Key Concepts

| Concept            | BizTalk Server                 | Logic Apps Standard                               |
|--------------------|--------------------------------|---------------------------------------------------|
| Transport          | Adapter (Send/Receive)         | Service Provider Connector                        |
| Message Processing | Pipeline Component             | Built-in Action (XML Operations, Flat File, etc.) |
| Routing            | Publish/Subscribe (MessageBox) | Workflow triggers + conditions                    |
| Orchestration      | XLANG/s Orchestration          | Workflow definition (JSON)                        |
| Trading Partners   | Party / Agreement              | Integration Account                               |
| Business Rules     | Business Rules Engine (BRE)    | Rules Engine action                               |
| Maps / Transforms  | XSLT Map                       | XML Operations → Xslt action                      |
| Schema Validation  | XML Validator pipeline         | XML Operations → XmlValidation action             |

---

## Adapter Mappings

### File & Storage

#### File System

|                         | BizTalk              | Logic Apps Standard             |
|-------------------------|----------------------|---------------------------------|
| **Adapter / Connector** | FILE, FileSystem     | **File System**                 |
| **Service Provider**    | —                    | `/serviceProviders/fileSystem`  |
| **Deployment Scope**    | —                    | Any                             |
| **Category**            | —                    | File                            |

| Type    | Operation                                | Description                                  |
|---------|------------------------------------------|----------------------------------------------|
| Trigger | `whenFilesAreAdded` _(default)_          | Trigger on new files in a folder (Push)      |
| Trigger | `whenFilesAreAddedOrModified`            | Trigger on new or modified files (Push)      |
| Action  | `readFileContent` _(default)_            | Read the content of a file                   |
| Action  | `createFile`                             | Create a new file                            |
| Action  | `listFolder`                             | List files in a folder                       |
| Action  | `getFileMetadata`                        | Get metadata of a file                       |
| Action  | `deleteFile`                             | Delete a file                                |

> **⚠️ Trigger semantics**: File System triggers return **metadata** (path, name, size) — NOT file content. You MUST add a `readFileContent` / `getFileContent` action after the trigger to read actual data.

**Connection Parameters:** `rootFolder` (required), `AuthenticationType` (optional)

---

#### FTP

|                         | BizTalk       | Logic Apps Standard           |
|-------------------------|---------------|-------------------------------|
| **Adapter / Connector** | FTP, Ftp      | **FTP**                       |
| **Service Provider**    | —             | `/serviceProviders/ftp`       |
| **Deployment Scope**    | —             | Any                           |
| **Category**            | —             | File                          |

| Type    | Operation                       | Description                |
|---------|---------------------------------|----------------------------|
| Trigger | `whenFileIsAdded` _(default)_   | New file detected (Poll)   |
| Action  | `getFileContent` _(default)_    | Get the content of a file  |
| Action  | `createFile`                    | Create a new file          |
| Action  | `listFolder`                    | List files in a folder     |
| Action  | `deleteFile`                    | Delete a file              |

> **⚠️ Trigger semantics**: FTP trigger returns **file metadata** — add `getFileContent` after trigger.

**Connection Parameters:** `ServerAddress` (required), `UserName` (required), `Password` (required), `Port` (optional), `IsSSL` (optional)

---

#### SFTP

|                         | BizTalk         | Logic Apps Standard            |
|-------------------------|-----------------|--------------------------------|
| **Adapter / Connector** | SFTP, Sftp      | **SFTP**                       |
| **Service Provider**    | —               | `/serviceProviders/sftp`       |
| **Deployment Scope**    | —               | Any                            |
| **Category**            | —               | File                           |

| Type    | Operation                       | Description                    |
|---------|---------------------------------|--------------------------------|
| Trigger | `whenFileIsAdded` _(default)_   | New file detected (Poll)       |
| Action  | `getFileContent` _(default)_    | Get the content of a file      |
| Action  | `createFile`                    | Create a new file              |
| Action  | `listFolder`                    | List files in a folder         |
| Action  | `deleteFile`                    | Delete a file                  |

**Connection Parameters:** `Host` (required), `UserName` (required), `Password` or `PrivateKey` (required), `Port` (optional)

---

#### Azure Blob Storage

|                         | BizTalk                       | Logic Apps Standard                 |
|-------------------------|-------------------------------|-------------------------------------|
| **Adapter / Connector** | AzureBlob, AzureBlobStorage   | **Azure Blob Storage**              |
| **Service Provider**    | —                             | `/serviceProviders/azureBlob`       |
| **Deployment Scope**    | —                             | Cloud Only                          |
| **Category**            | —                             | Storage                             |

| Type    | Operation                              | Description                    |
|---------|----------------------------------------|--------------------------------|
| Trigger | `whenABlobIsAddedOrModified` _(default)_ | New/modified blob (Push)     |
| Action  | `readBlob` _(default)_                 | Read blob content              |
| Action  | `uploadBlob`                           | Upload a blob                  |
| Action  | `deleteBlob`                           | Delete a blob                  |
| Action  | `listBlobs`                            | List blobs in container        |

> **⚠️ Trigger semantics**: Blob trigger returns **metadata** (path, URI) — add `readBlob` action to get content.

**Connection Parameters:** `ConnectionString` (required) or Managed Identity

---

#### Azure Table Storage

|                         | BizTalk                         | Logic Apps Standard                       |
|-------------------------|---------------------------------|-------------------------------------------|
| **Adapter / Connector** | AzureTable, AzureTableStorage   | **Azure Table Storage**                   |
| **Service Provider**    | —                               | `/serviceProviders/azureTableStorage`     |
| **Deployment Scope**    | —                               | Cloud Only                                |
| **Category**            | —                               | Storage                                   |

| Type   | Operation                     | Description           |
|--------|-------------------------------|-----------------------|
| Action | `getEntity` _(default)_       | Get a table entity    |
| Action | `insertEntity`                | Insert a table entity |
| Action | `updateEntity`                | Update a table entity |
| Action | `deleteEntity`                | Delete a table entity |
| Action | `queryEntities`               | Query table entities  |

---

### Messaging & Eventing

#### Azure Service Bus

|                         | BizTalk                              | Logic Apps Standard              |
|-------------------------|--------------------------------------|----------------------------------|
| **Adapter / Connector** | ServiceBus, MSMQ, NetMsmq, SB        | **Azure Service Bus**            |
| **Service Provider**    | —                                    | `/serviceProviders/serviceBus`   |
| **Deployment Scope**    | —                                    | Cloud Only                       |
| **Category**            | —                                    | Messaging                        |

> **Migration Note:** BizTalk MSMQ and NetMsmq adapters have no direct cloud equivalent. Azure Service Bus is the recommended replacement for all on-premises queuing patterns.

| Type    | Operation                           | Description                       |
|---------|-------------------------------------|-----------------------------------|
| Trigger | `receiveQueueMessage` _(default)_   | Receive single queue message      |
| Trigger | `receiveQueueMessages`              | Receive batch of queue messages   |
| Trigger | `peekLockQueueMessage`              | Peek-lock a queue message         |
| Trigger | `receiveTopicMessage`               | Receive a topic subscription msg  |
| Trigger | `peekLockTopicMessage`              | Peek-lock topic subscription msg  |
| Action  | `sendMessage` _(default)_           | Send a message to queue/topic     |
| Action  | `sendMessages`                      | Send batch of messages            |
| Action  | `completeMessage`                   | Complete a peek-locked message    |
| Action  | `abandonMessage`                    | Abandon a peek-locked message     |

**Connection Parameters:** `ConnectionString` (required) or Managed Identity

---

#### Azure Event Hub

|                         | BizTalk                    | Logic Apps Standard              |
|-------------------------|----------------------------|----------------------------------|
| **Adapter / Connector** | EventHub, AzureEventHub    | **Azure Event Hub**              |
| **Service Provider**    | —                          | `/serviceProviders/eventHub`     |
| **Deployment Scope**    | —                          | Cloud Only                       |
| **Category**            | —                          | Messaging                        |

| Type    | Operation                      | Description              |
|---------|--------------------------------|--------------------------|
| Trigger | `receiveEvents` _(default)_    | Receive events (Push)    |
| Action  | `sendEvent` _(default)_        | Send a single event      |
| Action  | `sendEvents`                   | Send batch of events     |

**Connection Parameters:** `ConnectionString` (required)

---

#### IBM MQ

|                         | BizTalk                   | Logic Apps Standard           |
|-------------------------|---------------------------|-------------------------------|
| **Adapter / Connector** | MQ, IbmMq, MQSeries      | **IBM MQ**                    |
| **Service Provider**    | —                         | `/serviceProviders/mq`        |
| **Deployment Scope**    | —                         | Any                           |
| **Category**            | —                         | Messaging                     |

| Type    | Operation                         | Description               |
|---------|-----------------------------------|---------------------------|
| Trigger | `receiveMessage` _(default)_      | Receive message (Push)    |
| Action  | `sendMessage` _(default)_         | Put a message on a queue  |
| Action  | `browseMessages`                  | Browse messages on queue  |

**Connection Parameters:** `QueueManagerName` (required), `Channel` (required), `Host` (required), `Port` (required)

---

#### RabbitMQ

|                         | BizTalk    | Logic Apps Standard                |
|-------------------------|------------|------------------------------------|
| **Adapter / Connector** | RabbitMQ   | **RabbitMQ**                       |
| **Service Provider**    | —          | `/serviceProviders/rabbitMQ`       |
| **Deployment Scope**    | —          | Any                                |
| **Category**            | —          | Messaging                          |

| Type    | Operation                         | Description                |
|---------|-----------------------------------|----------------------------|
| Trigger | `receiveMessage` _(default)_      | Receive a message (Push)   |
| Action  | `publishMessage` _(default)_      | Publish a message          |

---

#### Confluent Kafka

|                         | BizTalk                  | Logic Apps Standard                  |
|-------------------------|--------------------------|--------------------------------------|
| **Adapter / Connector** | Kafka, ConfluentKafka    | **Confluent Kafka**                  |
| **Service Provider**    | —                        | `/serviceProviders/confluentKafka`   |
| **Deployment Scope**    | —                        | Any                                  |
| **Category**            | —                        | Messaging                            |

| Type    | Operation                       | Description                |
|---------|---------------------------------|----------------------------|
| Trigger | `ReceiveMessage` _(default)_    | Receive messages (Push)    |
| Action  | `SendMessage` _(default)_       | Send a message to topic    |

**Connection Parameters:** `BootstrapServers` (required), `AuthenticationMode` (required), `Protocol` (required), `UserName` (optional), `Password` (optional)

---

### Database

#### SQL Server

|                         | BizTalk              | Logic Apps Standard           |
|-------------------------|----------------------|-------------------------------|
| **Adapter / Connector** | SQL, Sql, WCF-SQL    | **SQL Server**                |
| **Service Provider**    | —                    | `/serviceProviders/sql`       |
| **Deployment Scope**    | —                    | Any                           |
| **Category**            | —                    | Database                      |

| Type    | Operation                           | Description                   |
|---------|-------------------------------------|-------------------------------|
| Trigger | `whenARowIsModified` _(default)_    | Poll for modified rows        |
| Trigger | `whenARowIsUpdated`                 | Poll for updated rows         |
| Trigger | `whenARowIsInserted`                | Poll for inserted rows        |
| Trigger | `whenARowIsDeleted`                 | Poll for deleted rows         |
| Action  | `executeQuery` _(default)_          | Execute a SQL query           |
| Action  | `executeStoredProcedure`            | Execute a stored procedure    |
| Action  | `getRow`                            | Get a single row              |
| Action  | `getRows`                           | Get multiple rows             |
| Action  | `insertRow`                         | Insert a row                  |
| Action  | `updateRow`                         | Update a row                  |
| Action  | `deleteRow`                         | Delete a row                  |

**Connection Parameters:** `ConnectionString` (required) or `Server`+`Database`+`AuthenticationType`

---

#### Azure Cosmos DB

|                         | BizTalk                           | Logic Apps Standard                 |
|-------------------------|-----------------------------------|-------------------------------------|
| **Adapter / Connector** | CosmosDb, AzureCosmosDB           | **Azure Cosmos DB**                 |
| **Service Provider**    | —                                 | `/serviceProviders/azureCosmosDb`   |
| **Deployment Scope**    | —                                 | Cloud Only                          |
| **Category**            | —                                 | Database                            |

| Type    | Operation                              | Description                     |
|---------|----------------------------------------|---------------------------------|
| Trigger | `whenAnItemIsCreatedOrModified` _(default)_ | Poll for new/modified items |
| Action  | `createOrUpdateItem` _(default)_       | Upsert a document               |
| Action  | `readItem`                             | Read a document by ID           |
| Action  | `queryItems`                           | Query items with SQL            |
| Action  | `deleteItem`                           | Delete a document               |

---

#### IBM Db2

|                         | BizTalk       | Logic Apps Standard           |
|-------------------------|---------------|-------------------------------|
| **Adapter / Connector** | DB2, Db2      | **IBM Db2**                   |
| **Service Provider**    | —             | `/serviceProviders/db2`       |
| **Deployment Scope**    | —             | Any                           |
| **Category**            | —             | Database                      |

| Type   | Operation                       | Description                   |
|--------|---------------------------------|-------------------------------|
| Action | `executeQuery` _(default)_      | Execute a SQL query           |
| Action | `executeStoredProcedure`        | Execute a stored procedure    |
| Action | `getRow`                        | Get a single row              |
| Action | `insertRow`                     | Insert a row                  |
| Action | `updateRow`                     | Update a row                  |
| Action | `deleteRow`                     | Delete a row                  |

> **Note:** No triggers available.

---

#### Oracle Database

|                         | BizTalk                            | Logic Apps Standard              |
|-------------------------|------------------------------------|----------------------------------|
| **Adapter / Connector** | ODP.NET, OracleDb, WCF-OracleDB   | **Oracle Database**              |
| **Service Provider**    | —                                  | `/serviceProviders/oracle`       |
| **Deployment Scope**    | —                                  | Any                              |
| **Category**            | —                                  | Database                         |

| Type   | Operation                       | Description                   |
|--------|---------------------------------|-------------------------------|
| Action | `executeQuery` _(default)_      | Execute a SQL query           |
| Action | `executeStoredProcedure`        | Execute a stored procedure    |
| Action | `getRow`                        | Get a single row              |
| Action | `insertRow`                     | Insert a row                  |
| Action | `updateRow`                     | Update a row                  |
| Action | `deleteRow`                     | Delete a row                  |

---

### HTTP & Web Services

#### HTTP

|                         | BizTalk                                                                                  | Logic Apps Standard        |
|-------------------------|------------------------------------------------------------------------------------------|----------------------------|
| **Adapter / Connector** | HTTP, Http, WCF-BasicHttp, WCF-WSHttp, WCF-NetTcp, WCF-Custom, WCF-CustomIsolated, SOAP | **HTTP**                   |
| **Service Provider**    | —                                                                                        | `/serviceProviders/http`   |
| **Deployment Scope**    | —                                                                                        | Any                        |
| **Category**            | —                                                                                        | Integration                |

> **Migration Note:** All WCF-based adapters and the SOAP adapter are consolidated into the single HTTP connector. WCF-specific bindings (NetTcp, etc.) are not natively supported — migrate to HTTP/HTTPS REST or SOAP-over-HTTP patterns.

| Type    | Operation                     | Description                              |
|---------|-------------------------------|------------------------------------------|
| Trigger | `request` _(Request trigger)_ | Receive HTTP requests                    |
| Action  | `invokeHttp` _(default)_      | Send HTTP request to any endpoint        |

**Connection Parameters:** None for built-in HTTP action; uses inline URI + auth configuration.

---

### Email

#### SMTP

|                         | BizTalk                                                      | Logic Apps Standard        |
|-------------------------|--------------------------------------------------------------|----------------------------|
| **Adapter / Connector** | SMTP, Smtp, OutlookEmail, GmailEmail, ExchangeOnlineEmail   | **SMTP**                   |
| **Service Provider**    | —                                                            | `/serviceProviders/Smtp`   |
| **Deployment Scope**    | —                                                            | Any                        |
| **Category**            | —                                                            | Email                      |

| Type   | Operation                  | Description      |
|--------|----------------------------|------------------|
| Action | `sendEmail` _(default)_    | Send an email    |

> **Note:** No triggers available for SMTP. Use a Request trigger or other trigger to initiate email sending.

---

### B2B / EDI

#### AS2

|                         | BizTalk    | Logic Apps Standard   |
|-------------------------|------------|-----------------------|
| **Adapter / Connector** | AS2        | **AS2**               |
| **Service Provider**    | —          | — (inline operations) |
| **Deployment Scope**    | —          | Any                   |
| **Category**            | —          | B2B                   |

| Type   | Operation                  | Description              |
|--------|----------------------------|--------------------------|
| Action | `AS2Encode` _(default)_    | Encode an AS2 message    |
| Action | `AS2Decode`                | Decode an AS2 message    |

---

#### X12

|                         | BizTalk | Logic Apps Standard           |
|-------------------------|---------|-------------------------------|
| **Adapter / Connector** | X12     | **X12**                       |
| **Service Provider**    | —       | `/serviceProviders/x12`       |
| **Deployment Scope**    | —       | Any                           |
| **Category**            | —       | B2B                           |

| Type   | Operation                  | Description                  |
|--------|----------------------------|------------------------------|
| Action | `X12Decode` _(default)_    | Decode an X12 message        |
| Action | `X12Encode`                | Encode an X12 message        |
| Action | `X12BatchEncode`           | Batch-encode X12 messages    |

> **⚠️ OUTPUT FORMAT**: `X12Decode` returns **JSON** (not XML). If downstream processing expects XML, add an `XmlCompose` action after the decode action to convert JSON → XML.

**Connection Parameters:** Uses Integration Account

---

#### EDIFACT

|                         | BizTalk   | Logic Apps Standard             |
|-------------------------|-----------|---------------------------------|
| **Adapter / Connector** | EDIFACT   | **EDIFACT**                     |
| **Service Provider**    | —         | `/serviceProviders/edifact`     |
| **Deployment Scope**    | —         | Any                             |
| **Category**            | —         | B2B                             |

| Type   | Operation                       | Description                      |
|--------|---------------------------------|----------------------------------|
| Action | `EdifactDecode` _(default)_     | Decode an EDIFACT message        |
| Action | `EdifactEncode`                 | Encode an EDIFACT message        |
| Action | `EdifactBatchEncode`            | Batch-encode EDIFACT messages    |

> **⚠️ OUTPUT FORMAT**: `EdifactDecode` returns **JSON** (not XML). If downstream processing expects XML, add an `XmlCompose` action after the decode action.

**Connection Parameters:** `IntegrationAccountName` (required)

---

### Healthcare

#### MLLP (HL7)

|                         | BizTalk            | Logic Apps Standard        |
|-------------------------|--------------------|----------------------------|
| **Adapter / Connector** | MLLP, Mllp, HL7   | **MLLP (HL7)**             |
| **Service Provider**    | —                  | `/serviceProviders/mllp`   |
| **Deployment Scope**    | —                  | Any                        |
| **Category**            | —                  | Healthcare                 |

| Type    | Operation                       | Description                             |
|---------|---------------------------------|-----------------------------------------|
| Trigger | `receiveMessage` _(default)_    | Receive HL7 message over MLLP (Push)    |
| Action  | `sendMessage` _(default)_       | Send HL7 message over MLLP              |

---

### Financial

#### SWIFT

|                         | BizTalk   | Logic Apps Standard   |
|-------------------------|-----------|-----------------------|
| **Adapter / Connector** | SWIFT     | **SWIFT**             |
| **Service Provider**    | —         | — (inline operations) |
| **Deployment Scope**    | —         | Any                   |
| **Category**            | —         | Financial             |

| Type   | Operation                      | Description                  |
|--------|--------------------------------|------------------------------|
| Action | `SwiftMTDecode` _(default)_    | Decode a SWIFT MT message    |
| Action | `SwiftMTEncode`                | Encode a SWIFT MT message    |

---

### ERP (SAP)

#### SAP

|                         | BizTalk          | Logic Apps Standard          |
|-------------------------|------------------|------------------------------|
| **Adapter / Connector** | SAP, WCF-SAP     | **SAP**                      |
| **Service Provider**    | —                | `/serviceProviders/sap`      |
| **Deployment Scope**    | —                | Any                          |
| **Category**            | —                | ERP                          |

| Type    | Operation                          | Description                       |
|---------|------------------------------------|-----------------------------------|
| Trigger | `receiveIdoc` _(default)_          | Receive IDoc messages (Push)      |
| Trigger | `receiveMessage`                   | Receive RFC calls (Push)          |
| Action  | `callRfc` _(default)_              | Call an RFC function              |
| Action  | `sendIdoc`                         | Send an IDoc                      |
| Action  | `readTable`                        | Read a SAP table                  |
| Action  | `callBapi`                         | Call a BAPI                       |

**Connection Parameters:** `ApplicationServerHost` (required), `SystemNumber` (required), `ClientId` (required), `UserName` (required), `Password` (required)

---

### Mainframe (IBM)

#### IBM CICS

|                         | BizTalk    | Logic Apps Standard                  |
|-------------------------|------------|--------------------------------------|
| **Adapter / Connector** | HostApps   | **IBM CICS**                         |
| **Service Provider**    | —          | `/serviceProviders/cicsProgramCall`  |
| **Deployment Scope**    | —          | Any                                  |
| **Category**            | —          | Mainframe                            |

| Type   | Operation                      | Description               |
|--------|--------------------------------|---------------------------|
| Action | `invokeProgram` _(default)_    | Invoke a CICS program     |

---

#### IBM IMS

|                         | BizTalk    | Logic Apps Standard                  |
|-------------------------|------------|--------------------------------------|
| **Adapter / Connector** | HostApps   | **IBM IMS**                          |
| **Service Provider**    | —          | `/serviceProviders/imsProgramCall`   |
| **Deployment Scope**    | —          | Any                                  |
| **Category**            | —          | Mainframe                            |

| Type   | Operation                      | Description              |
|--------|--------------------------------|--------------------------|
| Action | `invokeProgram` _(default)_    | Invoke an IMS program    |

---

#### IBM Host File (VSAM)

|                         | BizTalk     | Logic Apps Standard            |
|-------------------------|-------------|--------------------------------|
| **Adapter / Connector** | HostFiles   | **IBM Host File**              |
| **Service Provider**    | —           | `/serviceProviders/hostFile`   |
| **Deployment Scope**    | —           | Any                            |
| **Category**            | —           | Mainframe                      |

| Type   | Operation                  | Description                    |
|--------|----------------------------|--------------------------------|
| Action | `writeFile` _(default)_    | Generate host file contents    |
| Action | `readFile`                 | Parse host file contents       |

---

### Security

#### Azure Key Vault

|                         | BizTalk              | Logic Apps Standard                |
|-------------------------|----------------------|------------------------------------|
| **Adapter / Connector** | KeyVault             | **Azure Key Vault**                |
| **Service Provider**    | —                    | `/serviceProviders/keyVault`       |
| **Deployment Scope**    | —                    | Cloud Only                         |
| **Category**            | —                    | Security                           |

| Type   | Operation                     | Description           |
|--------|-------------------------------|-----------------------|
| Action | `getSecret` _(default)_       | Get a secret value    |
| Action | `listSecrets`                 | List secret names     |

---

### AI & Agentic

> No direct BizTalk equivalent. Use these when modernising BizTalk routing/decision logic that previously relied on a custom rules engine, ML model hosted in a custom .NET pipeline component, or human-in-the-loop staging queues. Adapter selection MUST be PRD-driven — do NOT inject AI service-provider actions just because they are available.

#### Azure OpenAI

|                         | BizTalk            | Logic Apps Standard            |
|-------------------------|--------------------|--------------------------------|
| **Adapter / Connector** | —                  | **Azure OpenAI**               |
| **Service Provider**    | —                  | `/serviceProviders/openAI`     |
| **Deployment Scope**    | —                  | Cloud Only                     |
| **Category**            | —                  | AI                             |

| Type   | Operation              | Description                                         |
|--------|------------------------|-----------------------------------------------------|
| Action | `getChatCompletions`   | Chat completion via deployed model                  |
| Action | `getEmbeddings`        | Generate vector embeddings for text                 |

#### Azure AI Search

|                         | BizTalk            | Logic Apps Standard               |
|-------------------------|--------------------|-----------------------------------|
| **Adapter / Connector** | —                  | **Azure AI Search**               |
| **Service Provider**    | —                  | `/serviceProviders/azureAISearch` |
| **Deployment Scope**    | —                  | Cloud Only                        |
| **Category**            | —                  | AI                                |

| Type   | Operation              | Description                                  |
|--------|------------------------|----------------------------------------------|
| Action | `searchDocuments`      | Run a query against an index (knowledge RAG) |
| Action | `indexDocuments`       | Push documents to an index                   |

#### Document Intelligence

|                         | BizTalk            | Logic Apps Standard                       |
|-------------------------|--------------------|-------------------------------------------|
| **Adapter / Connector** | —                  | **Azure Document Intelligence**           |
| **Service Provider**    | —                  | `/serviceProviders/documentIntelligence`  |
| **Deployment Scope**    | —                  | Cloud Only                                |
| **Category**            | —                  | AI                                        |

| Type   | Operation              | Description                                  |
|--------|------------------------|----------------------------------------------|
| Action | `analyzeDocument`      | Extract structured fields from a document    |

#### Built-in AI helpers

| Type   | Operation        | Description                                                 |
|--------|------------------|-------------------------------------------------------------|
| Action | `chunkText`      | Split text into chunks for embedding/RAG                    |
| Action | `parseDocument`  | Parse PDF / Office docs into text                           |
| Action | `agent`          | `Agent` action — multi-step LLM tool-using agent loop       |

---

### Eventing

#### Event Grid Publisher

|                         | BizTalk            | Logic Apps Standard                  |
|-------------------------|--------------------|--------------------------------------|
| **Adapter / Connector** | —                  | **Event Grid Publisher**             |
| **Service Provider**    | —                  | `/serviceProviders/eventGridPublisher` |
| **Deployment Scope**    | —                  | Cloud Only                           |
| **Category**            | —                  | Eventing                             |

| Type   | Operation         | Description                                 |
|--------|-------------------|---------------------------------------------|
| Action | `publishEvent`    | Publish a CloudEvent to a topic             |
| Action | `publishEvents`   | Batch-publish CloudEvents                   |

> **Use** when the BizTalk source published to MSMQ or a custom WCF subscriber list and the modernised target uses pub/sub event distribution.

---

### Database (additional)

#### JDBC

|                         | BizTalk            | Logic Apps Standard          |
|-------------------------|--------------------|------------------------------|
| **Adapter / Connector** | —                  | **JDBC**                     |
| **Service Provider**    | —                  | `/serviceProviders/jdbc`     |
| **Deployment Scope**    | —                  | Cloud Only                   |
| **Category**            | —                  | Database                     |

| Type    | Operation                | Description                                        |
|---------|--------------------------|----------------------------------------------------|
| Trigger | `receiveQueryRows`       | Polling trigger for row-set query                  |
| Action  | `executeQuery`           | Execute SELECT — return rows                       |
| Action  | `executeNonQuery`        | Execute INSERT/UPDATE/DELETE                       |
| Action  | `callStoredProcedure`    | Invoke a stored procedure                          |

> **Use** for non-SQL-Server / non-Oracle / non-DB2 RDBMS that BizTalk reached via a custom WCF-Custom binding using a JDBC bridge.

---

### Custom Code & Scripting

> **Order of preference** (matches `logic-apps-planning-rules` §3 ladder):
> 1. **InvokeFunction** (.NET local function) — preferred for any decompiled C# / VB.NET helper, scripting functoid, custom pipeline component, map extension object. Unit-testable, debuggable, deployable as a sibling project. See `dotnet-local-functions` skill.
> 2. **CSharpScript** action — inline C# evaluation. Use only for trivial single-expression scripts the BizTalk source had as a one-liner Expression shape; never as a substitute for porting a real .cs/.vb helper.
> 3. **PowerShell** action — use only when the source explicitly orchestrated a PowerShell script (e.g. via custom adapter); do NOT introduce PowerShell to wrap C# logic.
> 4. **Azure Automation** webhook (HTTP `Webhook` action against an Automation runbook) — use only when the source called an Operations Manager / Orchestrator runbook out-of-process; otherwise an Azure Function or local function is more cohesive.

| Construct                        | When to use                                                              | Notes                                                                   |
|----------------------------------|--------------------------------------------------------------------------|-------------------------------------------------------------------------|
| `InvokeFunction`                 | Any decompiled .NET helper, scripting functoid, custom pipeline component| MUST carry `retryPolicy` per `workflow-json-rules` §8.7                 |
| `CSharpScript` action            | One-liner C# expressions only                                            | No external assembly references; do NOT paste large helper bodies here  |
| `PowerShell` action              | Source explicitly executed PowerShell                                    | Single script per action; secrets via Key Vault reference               |
| HTTP `Webhook` → Automation runbook | Source called System Center Orchestrator / Azure Automation runbook   | Out-of-process; account for runbook cold-start in `retryPolicy` interval |

---

## Adapters Not in Registry (Gaps)

| BizTalk Adapter             | Logic Apps Equivalent                       |
|-----------------------------|---------------------------------------------|
| JD Edwards EnterpriseOne    | HTTP + JDE REST APIs                        |
| JD Edwards OneWorld         | HTTP + JDE REST APIs                        |
| Oracle E-Business Suite     | Oracle Database (partial) + HTTP            |
| PeopleSoft Enterprise       | HTTP + PeopleSoft REST APIs                 |
| POP3                        | Office 365 Outlook / Gmail (managed API)    |
| Siebel                      | HTTP + Siebel REST APIs                     |
| TIBCO EMS                   | Azure Service Bus / RabbitMQ                |
| TIBCO Rendezvous            | — (no equivalent)                           |
| WCF-NetNamedPipe            | — (no equivalent)                           |
| Windows SharePoint Services | SharePoint (managed API)                    |

---

## Pipeline Component Mappings

### Built-in Connectors (from Registry)

| BizTalk Pipeline Component    | Logic Apps Connector    | Operation               |
|-------------------------------|-------------------------|-------------------------|
| XML Assembler                 | XML Operations          | `XmlCompose` action     |
| XML Disassembler              | XML Operations          | `XmlParse` action       |
| XML Validator                 | XML Operations          | `XmlValidation` action  |
| XSLT Transform (Map)         | XML Operations          | `Xslt` action           |
| Flat File Assembler           | Flat File Operations    | `FlatFileEncoding`      |
| Flat File Disassembler        | Flat File Operations    | `FlatFileDecoding`      |

### Not in Registry (Require Custom Code or Expressions)

| BizTalk Pipeline Component       | Logic Apps Equivalent                              |
|----------------------------------|----------------------------------------------------|
| JSON Decoder                     | Built-in (`json()` expression)                     |
| JSON Encoder                     | Built-in (native JSON)                             |
| MIME/SMIME Decoder               | Custom Code — local function                       |
| MIME/SMIME Encoder               | Custom Code — local function                       |
| Party Resolution                 | Integration Account partners                       |
| Property Promotion/Demotion      | Expressions / Variables / Tracked Properties       |
| Message Compression (zip/gzip)   | `extractArchive` / Custom Code — local function    |

---

## Orchestration Shape Mappings

### Message Operations

| #  | BizTalk Shape            | Logic Apps Equivalent               | Notes                                                           |
|----|--------------------------|-------------------------------------|-----------------------------------------------------------------|
| 1  | **Receive** (activating) | Trigger (Request / ServiceProvider) | Activating receive becomes the workflow trigger.                |
| 2  | **Receive** (following)  | ServiceProvider action              | Mid-flow receive; use connector action or child workflow.       |
| 3  | **Send**                 | ServiceProvider / HTTP action       | Action that sends a message to an external system.              |
| 4  | **Construct Message**    | `Compose` action                    | Build a new message from inputs.                                |
| 5  | **Message Assignment**   | `Compose` / `Set Variable`          | Assign values to a message.                                     |
| 6  | **Transform**            | `Xslt` action / `Compose`          | Map with XSLT → `Xslt`; simple → `Compose`.                   |

### Control Flow

| #  | BizTalk Shape           | Logic Apps Equivalent                              | Notes                                                                  |
|----|--------------------------|----------------------------------------------------|------------------------------------------------------------------------|
| 7  | **Decide**              | `Condition` action / `Switch` action               | `Condition` for if/else, `Switch` for multi-branch.                    |
| 8  | **Loop**                | `Until` action                                     | Repeat until a condition is met.                                       |
| 9  | **For Each**            | `For Each` action                                  | Iterate over an array.                                                 |
| 10 | **Parallel Actions**    | `Parallel Branch`                                  | Run multiple branches concurrently.                                    |
| 11 | **Listen**              | Multiple triggers / `Condition` on trigger output  | Use race-condition patterns or separate workflows with shared state.   |

### Orchestration Management

| #  | BizTalk Shape              | Logic Apps Equivalent                   | Notes                                                               |
|----|----------------------------|-----------------------------------------|---------------------------------------------------------------------|
| 12 | **Call Orchestration**     | `InvokeWorkflow` action                 | Synchronous call to a child workflow.                               |
| 13 | **Start Orchestration**    | `InvokeWorkflow` (async mode)           | Fire-and-forget call to another workflow.                           |
| 14 | **Delay**                  | `Delay` / `Delay Until` action          | Pause execution for a duration or until a time.                     |
| 15 | **Expression**             | Inline expressions / `Compose`          | XLANG/s C# expression → WDL @{...} expression.                     |

### Error Handling

| #  | BizTalk Shape              | Logic Apps Equivalent                   | Notes                                                               |
|----|----------------------------|-----------------------------------------|---------------------------------------------------------------------|
| 16 | **Scope**                  | `Scope` action                          | Container for error handling.                                       |
| 17 | **Throw**                  | `Terminate` action (Failed)             | End workflow with error.                                            |
| 18 | **Compensation**           | `Scope` + `runAfter` (Failed)           | Compensate in reverse order via runAfter chain.                     |
| 19 | **Atomic Transaction**     | Compensation/retry patterns             | No true distributed transactions; use saga pattern.                 |
| 20 | **Long-Running Transaction** | `Scope` + error handling              | Use Scope with catch/finally semantics.                             |
| 21 | **Suspend**                | `Terminate` (Suspended)                 | Put workflow in suspended state for admin review.                   |
| 22 | **Terminate**              | `Terminate` action                      | End workflow immediately.                                           |

### Correlation & Patterns

| BizTalk Feature        | Logic Apps Equivalent                              |
|------------------------|----------------------------------------------------|
| Correlation Set        | `correlationId` / Service Bus sessions             |
| Sequential Convoy      | Stateful workflow + Service Bus sessions           |
| Parallel Convoy        | Stateful workflow + multiple triggers/correlation  |
| Scatter-Gather         | `Parallel Branch` with join                        |
| Aggregation            | `For Each` + `Append to Array` + `Compose`         |
| Dynamic Send Port      | HTTP action with dynamic URI expression            |
| Call Rules (BRE)       | `RuleExecute` action                               |

---

## Engine & Platform Feature Mappings

### Mapper & Transforms

| #  | BizTalk Feature                       | Logic Apps Equivalent                                                      | Notes                                                                              |
|----|---------------------------------------|----------------------------------------------------------------------------|-------------------------------------------------------------------------------------|
| 1  | **BizTalk Mapper (Visual)**           | Data Mapper (preview) / XSLT                                              | Data Mapper is the visual equivalent in VS Code. XSLT for complex transforms.      |
| 2  | **Functoids (String)**                | Expression functions: `concat()`, `substring()`, `replace()`, etc.         |                                                                                     |
| 3  | **Functoids (Mathematical)**          | Expression functions: `add()`, `sub()`, `mul()`, `div()`, etc.             |                                                                                     |
| 4  | **Functoids (Logical)**               | Expression functions: `equals()`, `greater()`, `if()`, etc.                |                                                                                     |
| 5  | **Functoids (DateTime)**              | Expression functions: `utcNow()`, `addDays()`, `formatDateTime()`, etc.    |                                                                                     |
| 6  | **Functoids (Conversion)**            | Expression functions: `int()`, `float()`, `string()`, `base64()`, etc.     |                                                                                     |
| 7  | **Functoids (Database)**              | SQL connector + Compose / .NET local function for complex lookups          |                                                                                     |
| 8  | **Functoids (Cumulative)**            | `For Each` + `Append to Array` + aggregation                              |                                                                                     |
| 9  | **Functoids (Scientific)**            | .NET local function / inline code                                          |                                                                                     |
| 10 | **Custom Functoid**                   | Custom Code action / XSLT inline script                                   | Move functoid logic to local function or embed in XSLT `<msxsl:script>`.           |
| 11 | **Scripting Functoid**                | C# Inline Code action / .NET local function                               |                                                                                     |
| 12 | **Liquid Templates**                  | Liquid template action                                                     |                                                                                     |

### Engine Features

| BizTalk Feature               | Logic Apps Equivalent                              |
|-------------------------------|----------------------------------------------------|
| BAM                           | Application Insights / Azure Monitor               |
| BizTalk Admin Console         | Azure Portal / VS Code                             |
| Binding Files                 | `connections.json` + `parameters.json`             |
| Content-Based Routing         | `Condition` / `Switch`                             |
| Debatching                    | `SplitOn` on trigger                               |
| Host / Host Instances         | App Service Plan / Workflow App                    |
| Message Enrichment            | Inline actions + `Compose`                         |
| Message Tracking              | Tracked Properties + Application Insights          |
| Property Schemas              | Variables / Tracked Properties                     |
| Rules Engine (BRE)            | `RuleExecute` action                               |
| Sequential Convoy             | Service Bus sessions + stateful workflow           |
| Subscription / Pub-Sub        | Service Bus topics + workflow trigger conditions    |

---

## BizTalk XLANG/s Expressions → Logic Apps WDL Expressions

### String Operations

| BizTalk XLANG/s                   | Logic Apps WDL                                                    | Notes |
|-----------------------------------|-------------------------------------------------------------------|-------|
| `str1 + str2`                     | `@{concat(variables('str1'), variables('str2'))}`                 |       |
| `str.Length`                       | `@{length(variables('str'))}`                                     |       |
| `str.Substring(start, len)`        | `@{substring(variables('str'), start, len)}`                      |       |
| `str.ToUpper()`                    | `@{toUpper(variables('str'))}`                                    |       |
| `str.ToLower()`                    | `@{toLower(variables('str'))}`                                    |       |
| `str.Trim()`                       | `@{trim(variables('str'))}`                                       |       |
| `str.Replace("old", "new")`        | `@{replace(variables('str'), 'old', 'new')}`                      |       |
| `str.Contains("text")`             | `@{contains(variables('str'), 'text')}`                            | Returns boolean |
| `str.StartsWith("prefix")`         | `@{startsWith(variables('str'), 'prefix')}`                        |       |
| `str.EndsWith("suffix")`           | `@{endsWith(variables('str'), 'suffix')}`                          |       |
| `str.IndexOf("find")`              | `@{indexOf(variables('str'), 'find')}`                             |       |
| `str.Split(',')`                   | `@{split(variables('str'), ',')}`                                  | Returns array |
| `String.Format("{0}-{1}", a, b)`   | `@{concat(variables('a'), '-', variables('b'))}`                   |       |

### Numeric & Math Operations

| BizTalk XLANG/s              | Logic Apps WDL                                      | Notes |
|------------------------------|-----------------------------------------------------|-------|
| `a + b`                     | `@{add(variables('a'), variables('b'))}`             |       |
| `a - b`                     | `@{sub(variables('a'), variables('b'))}`             |       |
| `a * b`                     | `@{mul(variables('a'), variables('b'))}`             |       |
| `a / b`                     | `@{div(variables('a'), variables('b'))}`             |       |
| `a % b`                     | `@{mod(variables('a'), variables('b'))}`             |       |
| `Math.Min(a, b)`            | `@{min(variables('a'), variables('b'))}`             |       |
| `Math.Max(a, b)`            | `@{max(variables('a'), variables('b'))}`             |       |
| `int.Parse(str)`            | `@{int(variables('str'))}`                           |       |
| `Convert.ToDecimal(str)`    | `@{float(variables('str'))}`                         |       |

### Date/Time Operations

| BizTalk XLANG/s                        | Logic Apps WDL                                                   | Notes |
|----------------------------------------|------------------------------------------------------------------|-------|
| `DateTime.UtcNow`                      | `@{utcNow()}`                                                   |       |
| `DateTime.Now`                         | `@{convertFromUtc(utcNow(), 'timezone')}`                        |       |
| `date.AddDays(n)`                      | `@{addDays(variables('date'), n)}`                                |       |
| `date.AddHours(n)`                     | `@{addHours(variables('date'), n)}`                               |       |
| `date.AddMinutes(n)`                   | `@{addMinutes(variables('date'), n)}`                             |       |
| `date.ToString("yyyy-MM-dd")`          | `@{formatDateTime(variables('date'), 'yyyy-MM-dd')}`              |       |
| `(date2 - date1).TotalDays`            | `@{div(ticks(sub(variables('date2'),variables('date1'))),864000000000)}` | Approximate |
| `DateTime.Parse(str)`                  | `@{parseDateTime(variables('str'))}`                              |       |

### Logical / Comparison

| BizTalk XLANG/s    | Logic Apps WDL                                           | Notes |
|--------------------|----------------------------------------------------------|-------|
| `a == b`           | `@{equals(variables('a'), variables('b'))}`              |       |
| `a != b`           | `@{not(equals(variables('a'), variables('b')))}`         |       |
| `a > b`            | `@{greater(variables('a'), variables('b'))}`             |       |
| `a >= b`           | `@{greaterOrEquals(variables('a'), variables('b'))}`     |       |
| `a < b`            | `@{less(variables('a'), variables('b'))}`                |       |
| `a <= b`           | `@{lessOrEquals(variables('a'), variables('b'))}`        |       |
| `a && b`           | `@{and(a, b)}`                                           |       |
| `a \|\| b`         | `@{or(a, b)}`                                            |       |
| `!a`               | `@{not(a)}`                                              |       |
| `a == null`        | `@{equals(variables('a'), null)}`                        |       |

### Type Conversion

| BizTalk XLANG/s                    | Logic Apps WDL                                                  | Notes                     |
|------------------------------------|-----------------------------------------------------------------|---------------------------|
| `(string)value`                    | `@{string(value)}`                                              |                           |
| `(int)value`                       | `@{int(value)}`                                                 |                           |
| `Convert.ToBase64String(bytes)`    | `@{base64(value)}`                                              |                           |
| `Convert.FromBase64String(str)`    | `@{base64ToBinary(value)}` / `@{base64ToString(value)}`         |                           |
| `Encoding.UTF8.GetBytes(str)`      | `@{base64(value)}`                                              | Encode to base64 bytes    |
| `XmlDocument.LoadXml(str)`         | `@{xml(value)}`                                                 | Parse string to XML       |
| `JsonConvert.Serialize(obj)`       | `@{json(value)}` / already JSON                                 |                           |
| `Guid.NewGuid()`                   | `@{guid()}`                                                     |                           |

### Collection / Array Operations

| BizTalk XLANG/s            | Logic Apps WDL                                               | Notes                        |
|----------------------------|--------------------------------------------------------------|------------------------------|
| `list.Count`               | `@{length(variables('list'))}`                               |                              |
| `list[i]`                  | `@{variables('list')[i]}`                                    |                              |
| `list.Add(item)`           | Append to Array variable action                              |                              |
| `list.Contains(item)`      | `@{contains(variables('list'), item)}`                        |                              |
| `list.Distinct()`          | `@{union(variables('list'), variables('list'))}`              | Union with itself deduplicates |
| `array1.Concat(array2)`    | `@{union(variables('array1'), variables('array2'))}`          |                              |
| `new [] { a, b, c }`       | `@{createArray(a, b, c)}`                                    |                              |

---

## BizTalk Custom Code → Logic Apps Custom Code

### Custom Code Migration Matrix

| #  | BizTalk Custom Code Type                       | Logic Apps Equivalent                        | Migration Approach                                                                                                                |
|----|------------------------------------------------|----------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------|
| 1  | **Helper class called from orchestration**     | Custom Code action (local function)          | Move the .NET helper class into the Logic App project as a local function. Call it via the `InvokeFunction` action.               |
| 2  | **Custom pipeline component**                  | Custom Code action (local function)          | Extract the `Execute()` logic into a local function. Wire it as an action where the pipeline ran.                                |
| 3  | **Custom adapter**                             | Custom Code action + HTTP trigger            | For receive: HTTP Request trigger + local function. For send: local function + HTTP action. Complex protocols may need sidecar.   |
| 4  | **Custom functoid**                            | Custom Code action / XSLT inline script      | Move functoid logic to a local function or embed in XSLT `<msxsl:script>`.                                                      |
| 5  | **XLANG/s expression (simple)**                | WDL expression                               | Convert C# expressions to `@{...}` WDL syntax (see expression tables above).                                                    |
| 6  | **XLANG/s expression (complex / multi-line)**  | C# Inline Code action                        | Multi-line C#, loops, try/catch, regex — use "Execute CSharp Script Code" action. Runs C# directly in the workflow.             |
| 7  | **.NET class library (shared)**                | NuGet package or project reference           | Package existing class library as NuGet or add as project reference.                                                             |
| 8  | **Custom BAM activity**                        | Application Insights + tracked properties    | Use `trackedProperties` on actions + Application Insights custom events via local function.                                      |
| 9  | **Custom exception handler**                   | Scope + `runAfter` + local function          | Use scope-level error handling. Complex error processing goes in a local function.                                               |
| 10 | **Regex / complex string parsing**             | C# Inline Code action                        | WDL has no native regex. Use `System.Text.RegularExpressions` in a C# inline code action.                                       |
| 11 | **Database access helper**                     | SQL connector / local function               | Simple CRUD → SQL connector. Complex stored procs or multi-step → local function.                                                |
| 12 | **External web service wrapper**               | HTTP action + local function                 | Simple REST → HTTP action. Complex auth/protocol → local function wrapping HttpClient.                                           |
| 13 | **Encryption / signing**                        | Local function                               | Use .NET crypto APIs in a local function. Key management via Azure Key Vault.                                                    |

### Custom Code Priority Ladder

When deciding which Logic Apps construct to use for custom BizTalk code, follow this priority order:

1. **Built-in actions** (XML Parse, Validate XML, Compose, Parse JSON, Flat File Decode/Encode) — lowest latency, no code to maintain.
2. **Workflow expressions** (`@{...}` WDL syntax) — only when no built-in action exists for the operation.
3. **Data Mapper / Liquid** — for complex JSON↔JSON or template-based transforms.
4. **C# Inline Code action** — for simple multi-line C# logic (regex, parsing, formatting).
5. **.NET local functions** — for reusable business logic, database access, complex processing. Runs in-process.
6. **Azure Functions** — last resort; for heavy compute, long-running, or shared-across-apps scenarios.

> **Rule**: Source custom code (scripting functoids, external assemblies, custom pipeline components) must ALWAYS map to .NET local functions to preserve source design. Never approximate complex logic with expressions.

---

## Connection Type Reference

| Type                                                 | Description                                                                      | Count |
|------------------------------------------------------|----------------------------------------------------------------------------------|-------|
| **Service Provider** (`/serviceProviders/...`)       | Built-in, runs in-process. Lower latency, no gateway needed for cloud resources. | 25    |
| **Connection Provider** (`/connectionProviders/...`) | Referenced by ServiceProviderId but uses a different hosting model.               | 1 (SAP OData) |
| **API Connection** (`IsApiConnection: true`)         | Managed connector hosted by Azure. Requires API connection resource.              | 1 (IBM Informix) |
| **None** (no ServiceProviderId, not API connection)  | Inline operations, no connection infrastructure.                                  | 5 (AS2, SWIFT, HL7, Rules Engine, XML Ops, Flat File Ops) |

> **Preference**: Always prefer **Service Provider** (built-in) over **API Connection** (managed) whenever both are available. Built-in connectors run in-process with lower latency and no connection overhead.

---

## Quick Lookup: BizTalk Adapter → Logic Apps Connector

| BizTalk Adapter                     | Logic Apps Connector       |
|-------------------------------------|----------------------------|
| AS2                                 | AS2                        |
| AzureBlob / AzureBlobStorage        | Azure Blob Storage         |
| AzureEventHub / EventHub            | Azure Event Hub            |
| AzureTable / AzureTableStorage      | Azure Table Storage        |
| BAPI / SAPERP / SapErp              | SAP ERP                    |
| HostApps (CICS)                     | IBM CICS                   |
| CosmosDb / CosmosDB / AzureCosmosDB | Azure Cosmos DB            |
| DB2 / Db2                           | IBM Db2                    |
| EDIFACT                             | EDIFACT                    |
| FILE / FileSystem                   | File System                |
| FTP / Ftp                           | FTP                        |
| HL7 (transport)                     | MLLP (HL7)                 |
| HostFiles                           | IBM Host File              |
| HTTP / Http                         | HTTP                       |
| HostApps (IMS)                      | IBM IMS                    |
| Kafka / ConfluentKafka              | Confluent Kafka            |
| KeyVault / AzureKeyVault            | Azure Key Vault            |
| MLLP / Mllp                         | MLLP (HL7)                 |
| MQ / IbmMq / MQSeries              | IBM MQ                     |
| MSMQ / NetMsmq                      | Azure Service Bus/RabbitMQ |
| ODP.NET / OracleDb / OracleDatabase | Oracle Database            |
| RabbitMQ                            | RabbitMQ                   |
| SAP / WCF-SAP                       | SAP                        |
| SB / ServiceBus / SB-Messaging      | Azure Service Bus          |
| SFTP / Sftp                         | SFTP                       |
| SMTP / Smtp                         | SMTP                       |
| SOAP                                | HTTP                       |
| SQL / Sql / WCF-SQL                  | SQL Server                 |
| SWIFT                               | SWIFT                      |
| WCF-BasicHttp                       | HTTP                       |
| WCF-Custom                          | HTTP                       |
| WCF-CustomIsolated                  | HTTP                       |
| WCF-NetTcp                          | HTTP                       |
| WCF-WSHttp                          | HTTP                       |
| X12                                 | X12                        |

---

## Connection Parameter Templates for connections.json

Use these JSON templates when generating `connections.json` entries. Each template shows the exact `parameterValues` structure for the `serviceProviderConnections` section.

### File System

```json
"FileSystem": {
  "serviceProvider": { "id": "/serviceProviders/fileSystem" },
  "displayName": "File System",
  "parameterValues": {
    "rootFolder": "@appsetting('FILESYSTEM_ROOT_FOLDER')"
  }
}
```

### FTP

```json
"FTP": {
  "serviceProvider": { "id": "/serviceProviders/ftp" },
  "displayName": "FTP",
  "parameterValues": {
    "ServerAddress": "@appsetting('FTP_SERVER')",
    "UserName": "@appsetting('FTP_USERNAME')",
    "Password": "@appsetting('FTP_PASSWORD')",
    "Port": 21,
    "IsSSL": false
  }
}
```

### SFTP

```json
"SFTP": {
  "serviceProvider": { "id": "/serviceProviders/sftp" },
  "displayName": "SFTP",
  "parameterValues": {
    "Host": "@appsetting('SFTP_HOST')",
    "UserName": "@appsetting('SFTP_USERNAME')",
    "Password": "@appsetting('SFTP_PASSWORD')",
    "Port": 22
  }
}
```

### Azure Blob Storage

```json
"AzureBlob": {
  "serviceProvider": { "id": "/serviceProviders/azureBlob" },
  "displayName": "Azure Blob Storage",
  "parameterValues": {
    "connectionString": "@appsetting('BLOB_CONNECTION_STRING')"
  }
}
```

### Azure Service Bus

```json
"ServiceBus": {
  "serviceProvider": { "id": "/serviceProviders/serviceBus" },
  "displayName": "Azure Service Bus",
  "parameterValues": {
    "connectionString": "@appsetting('SERVICEBUS_CONNECTION_STRING')"
  }
}
```

### Azure Event Hub

```json
"EventHub": {
  "serviceProvider": { "id": "/serviceProviders/eventHub" },
  "displayName": "Azure Event Hub",
  "parameterValues": {
    "connectionString": "@appsetting('EVENTHUB_CONNECTION_STRING')"
  }
}
```

### SQL Server

```json
"SQL": {
  "serviceProvider": { "id": "/serviceProviders/sql" },
  "displayName": "SQL Server",
  "parameterValues": {
    "connectionString": "@appsetting('SQL_CONNECTION_STRING')"
  }
}
```

### Azure Cosmos DB

```json
"CosmosDB": {
  "serviceProvider": { "id": "/serviceProviders/azureCosmosDb" },
  "displayName": "Azure Cosmos DB",
  "parameterValues": {
    "connectionString": "@appsetting('COSMOSDB_CONNECTION_STRING')"
  }
}
```

### IBM MQ

```json
"MQ": {
  "serviceProvider": { "id": "/serviceProviders/mq" },
  "displayName": "IBM MQ",
  "parameterValues": {
    "QueueManagerName": "@appsetting('MQ_QUEUE_MANAGER')",
    "Channel": "@appsetting('MQ_CHANNEL')",
    "Host": "@appsetting('MQ_HOST')",
    "Port": 1414
  }
}
```

### RabbitMQ

```json
"RabbitMQ": {
  "serviceProvider": { "id": "/serviceProviders/rabbitMQ" },
  "displayName": "RabbitMQ",
  "parameterValues": {
    "connectionString": "@appsetting('RABBITMQ_CONNECTION_STRING')"
  }
}
```

### Confluent Kafka

```json
"Kafka": {
  "serviceProvider": { "id": "/serviceProviders/confluentKafka" },
  "displayName": "Confluent Kafka",
  "parameterValues": {
    "BootstrapServers": "@appsetting('KAFKA_BOOTSTRAP_SERVERS')",
    "AuthenticationMode": "Plain",
    "Protocol": "SaslSsl",
    "UserName": "@appsetting('KAFKA_USERNAME')",
    "Password": "@appsetting('KAFKA_PASSWORD')"
  }
}
```

### SAP

```json
"SAP": {
  "serviceProvider": { "id": "/serviceProviders/sap" },
  "displayName": "SAP",
  "parameterValues": {
    "ApplicationServerHost": "@appsetting('SAP_HOST')",
    "SystemNumber": "@appsetting('SAP_SYSTEM_NUMBER')",
    "ClientId": "@appsetting('SAP_CLIENT_ID')",
    "UserName": "@appsetting('SAP_USERNAME')",
    "Password": "@appsetting('SAP_PASSWORD')"
  }
}
```

### Oracle Database

```json
"Oracle": {
  "serviceProvider": { "id": "/serviceProviders/oracle" },
  "displayName": "Oracle Database",
  "parameterValues": {
    "connectionString": "@appsetting('ORACLE_CONNECTION_STRING')"
  }
}
```

### IBM Db2

```json
"Db2": {
  "serviceProvider": { "id": "/serviceProviders/db2" },
  "displayName": "IBM Db2",
  "parameterValues": {
    "connectionString": "@appsetting('DB2_CONNECTION_STRING')"
  }
}
```

### Azure Key Vault

```json
"KeyVault": {
  "serviceProvider": { "id": "/serviceProviders/keyVault" },
  "displayName": "Azure Key Vault",
  "parameterValues": {
    "vaultUri": "@appsetting('KEYVAULT_URI')"
  }
}
```

### SMTP

```json
"SMTP": {
  "serviceProvider": { "id": "/serviceProviders/Smtp" },
  "displayName": "SMTP",
  "parameterValues": {
    "ServerAddress": "@appsetting('SMTP_SERVER')",
    "Port": 587,
    "UserName": "@appsetting('SMTP_USERNAME')",
    "Password": "@appsetting('SMTP_PASSWORD')",
    "EnableSsl": true
  }
}
```

### MLLP (HL7)

```json
"MLLP": {
  "serviceProvider": { "id": "/serviceProviders/mllp" },
  "displayName": "MLLP (HL7)",
  "parameterValues": {
    "Host": "@appsetting('MLLP_HOST')",
    "Port": 2575
  }
}
```

> **Rule**: Never embed actual secrets or connection strings in `connections.json`. Always use `@appsetting('...')` references that resolve from `local.settings.json` (local dev) or App Settings (deployed). The real secret values live in Azure Key Vault, referenced via Key Vault App Setting references.

### Managed Identity Connection Patterns (Preferred)

Per Article V of the constitution, prefer Managed Identity over connection strings wherever the connector supports it. These templates replace the connection-string versions above when deploying to Azure.

#### Azure Service Bus (Managed Identity)

```json
"ServiceBus": {
  "serviceProvider": { "id": "/serviceProviders/serviceBus" },
  "displayName": "Azure Service Bus",
  "parameterValues": {
    "fullyQualifiedNamespace": "@appsetting('SERVICEBUS_FQNS')"
  },
  "authentication": {
    "type": "ManagedServiceIdentity"
  }
}
```

> App setting: `SERVICEBUS_FQNS` = `sb-<workload>-<env>.servicebus.windows.net` (no `Endpoint=` prefix, no key).

#### Azure Blob Storage (Managed Identity)

```json
"AzureBlob": {
  "serviceProvider": { "id": "/serviceProviders/azureBlob" },
  "displayName": "Azure Blob Storage",
  "parameterValues": {
    "blobStorageUri": "@appsetting('BLOB_STORAGE_URI')"
  },
  "authentication": {
    "type": "ManagedServiceIdentity"
  }
}
```

> App setting: `BLOB_STORAGE_URI` = `https://st<workload><env>.blob.core.windows.net`

#### SQL Server (Managed Identity)

```json
"SQL": {
  "serviceProvider": { "id": "/serviceProviders/sql" },
  "displayName": "SQL Server",
  "parameterValues": {
    "connectionString": "@appsetting('SQL_CONNECTION_STRING')"
  },
  "authentication": {
    "type": "ManagedServiceIdentity"
  }
}
```

> App setting: `SQL_CONNECTION_STRING` = `Server=<server>.database.windows.net;Database=<db>;Authentication=Active Directory Managed Identity;` (no password).

#### Azure Cosmos DB (Managed Identity)

```json
"CosmosDB": {
  "serviceProvider": { "id": "/serviceProviders/azureCosmosDb" },
  "displayName": "Azure Cosmos DB",
  "parameterValues": {
    "accountEndpoint": "@appsetting('COSMOSDB_ENDPOINT')"
  },
  "authentication": {
    "type": "ManagedServiceIdentity"
  }
}
```

> App setting: `COSMOSDB_ENDPOINT` = `https://<account>.documents.azure.com:443/`

#### Azure Key Vault (Managed Identity)

```json
"KeyVault": {
  "serviceProvider": { "id": "/serviceProviders/keyVault" },
  "displayName": "Azure Key Vault",
  "parameterValues": {
    "vaultUri": "@appsetting('KEYVAULT_URI')"
  },
  "authentication": {
    "type": "ManagedServiceIdentity"
  }
}
```

#### Azure Event Hub (Managed Identity)

```json
"EventHub": {
  "serviceProvider": { "id": "/serviceProviders/eventHub" },
  "displayName": "Azure Event Hub",
  "parameterValues": {
    "fullyQualifiedNamespace": "@appsetting('EVENTHUB_FQNS')"
  },
  "authentication": {
    "type": "ManagedServiceIdentity"
  }
}
```

### Connection Pattern Decision

| Connector supports MI? | Environment | Use |
|---|---|---|
| Yes (Service Bus, Blob, SQL, Cosmos DB, Key Vault, Event Hub) | Azure (dev/prod) | **Managed Identity** pattern — no secrets at all |
| Yes | Local dev | **Connection string** pattern in `local.settings.json` (Azurite or dev resource) |
| No (FTP, SFTP, SMTP, IBM MQ, SAP, Oracle, Db2, RabbitMQ, Kafka) | All | **Connection string** via `@appsetting()` → Key Vault reference |

> **Compiler rule**: When generating `connections.json`, emit the MI pattern by default for Azure-native connectors. Emit the connection-string pattern for connectors that don't support MI. The `azure-connections-binder` agent handles both patterns.

> **Reviewer rule**: Flag any Azure-native connector (Service Bus, Blob, SQL, Cosmos DB, Event Hub, Key Vault) using a connection string in deployed `appsettings.*.json` as a Major finding (Article V violation). Connection strings are only acceptable in `local.settings.json`.

---

## EDI/AS2 End-to-End Migration Patterns

### Inbound X12 Pattern (BizTalk → Logic Apps)

**BizTalk approach:**
1. Receive location (HTTP or AS2 adapter) receives raw EDI
2. Receive pipeline (EDI Disassembler component) decodes X12 envelope
3. Party resolution resolves trading partner from ISA qualifiers
4. Orchestration processes the decoded XML message
5. Send pipeline (EDI Assembler) generates 997 functional acknowledgment
6. Send port returns 997 to trading partner

**Logic Apps equivalent:**

```
workflow.json:
  Trigger: HTTP Request (or AS2Decode for AS2 transport)
  Actions:
    1. X12Decode          → decodes X12, returns JSON array of transactions
    2. Parse_JSON         → typed access to decoded transactions
    3. For_each / SplitOn → process each transaction set
    4. [Business logic]   → route, transform, store
    5. X12Encode          → generate 997 acknowledgment
    6. Response           → return 997 to caller
```

**Key differences:**
- X12Decode returns **JSON** (not XML). Add `XmlCompose` if downstream expects XML.
- No separate party resolution step — agreement handles partner identification.
- 997 acknowledgment is explicitly generated via `X12Encode` (not implicit).

### Outbound X12 Pattern

**Logic Apps workflow:**

```
workflow.json:
  Trigger: Service Bus / HTTP Request
  Actions:
    1. Parse_JSON         → parse incoming business data
    2. Compose            → build X12-compatible JSON structure
    3. X12Encode          → encode to X12 EDI format
    4. HTTP / AS2Encode   → send to trading partner
```

### AS2 with EDI Pattern

**Logic Apps workflow:**

```
workflow.json:
  Trigger: HTTP Request (raw AS2 message)
  Actions:
    1. AS2Decode          → decrypt + verify signature → extracts payload
    2. X12Decode          → decode EDI payload from AS2 body
    3. Parse_JSON         → typed access
    4. [Business logic]
    5. X12Encode          → generate 997
    6. AS2Encode          → encrypt + sign outbound
    7. Response           → return MDN (Message Disposition Notification)
```

### EDI Batching Pattern

**BizTalk**: EDI batching orchestration collects transactions and assembles into interchange.

**Logic Apps**: Use stateful workflow with Service Bus session for aggregation:

```
workflow.json:
  Trigger: Service Bus (session-enabled queue, peekLock)
  Actions:
    1. Initialize_Array    → accumulator for transactions
    2. Until (batch complete or timeout)
       2a. Receive next message from session
       2b. Append to array
       2c. Check batch release criteria
    3. X12BatchEncode     → batch-encode accumulated transactions
    4. Send to partner    → HTTP / AS2
    5. Complete messages   → settle all peek-locked messages
```

### EDI Migration Checklist

| Step | Action | Notes |
|---|---|---|
| 1 | Create Integration Account (Standard tier) | Required for all EDI scenarios |
| 2 | Upload EDI schemas to Integration Account | X12 schema names: `X12_VVVVV_TTT` (version_transactionSet) |
| 3 | Create partner resources for each trading partner | Map BizTalk parties to partners |
| 4 | Create agreement resources | One agreement per partner per protocol |
| 5 | Configure agreement protocol settings | Validation, framing, envelope, acknowledgment |
| 6 | Set `WORKFLOWS_INTEGRATION_ACCOUNT_ID` app setting | Links Logic App to Integration Account |
| 7 | Build workflow with decode/encode actions | Reference agreement implicitly by partner identities |
| 8 | Test with sample EDI files | Validate envelope, transactions, acknowledgments |

> **Cross-reference**: See `.claude/skills/integration-account-artifacts/SKILL.md` for detailed Bicep templates, certificate deployment, and artifact folder structure.

---

## Coverage Summary

| Category                 | In Registry            | Additional (Not in Registry)              | Total Mapped      |
|--------------------------|------------------------|-------------------------------------------|--------------------|
| **Adapters**             | 29 connector mappings  | 10 additional adapters                    | 39                 |
| **Pipeline Components**  | 4 (XML Ops, Flat File) | 7 (MIME, JSON, Party, Props, Compression) | 11                 |
| **Accelerators**         | 2 (HL7, SWIFT)         | —                                         | 2                  |
| **Orchestration Shapes** | —                      | 22 shapes                                 | 22                 |
| **Engine Features**      | 1 (Rules Engine)       | 18 features                               | 19                 |
| **Mapper / Transforms**  | 1 (Xslt action)        | 11 (Functoids, Data Mapper, Liquid)       | 12                 |
| **Expressions**          | —                      | 50+ expression conversions                | 50+                |
| **Custom Code**          | —                      | 13 custom code migration paths            | 13                 |
|                          |                        | **Grand Total**                           | **170+ mappings**  |

---

_Adapted from the [Azure Logic Apps Migration Agent](https://github.com/Azure/logicapps-migration-agent) reference material._
