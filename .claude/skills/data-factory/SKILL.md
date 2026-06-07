---
name: data-factory
description: Design, configure, and deploy Azure Data Factory pipelines for ETL/ELT, bulk data movement, and scheduled batch integration. Covers pipeline / activity / dataset / linked service / data flow concepts, trigger types, Integration Runtime selection (Azure / Self-Hosted / Azure-SSIS), schema-drift handling, source-control / CI-CD, and the ADF vs Logic Apps vs Functions vs Synapse boundary. Consumed when an IR flow is fundamentally a data-engineering pipeline (bulk source-to-sink movement, scheduled ETL, lake hydration) rather than an event-driven integration. Pairs with [batch-processing](../batch-processing/SKILL.md) which contains the cross-pattern selection rules.
---

# Azure Data Factory — Builder Skill

> **Purpose**: Authoritative design rules for ADF when the integration is fundamentally **data movement / ETL / ELT** — bulk copy from source to sink, schema-drift transformation, scheduled lake hydration, or warehouse loads.
>
> **Scope boundary**: this skill covers data-engineering pipelines. App-integration workflows (event-driven, transactional, orchestration across services) belong in Logic Apps or Functions, not ADF. [batch-processing/SKILL.md](../batch-processing/SKILL.md) contains the cross-pattern selection rules; use it to decide *whether* ADF is the right tool before reaching for this skill.

---

## When ADF vs Other AIS Services

| Scenario | Right tool |
|---|---|
| Source-to-sink **bulk** data movement (DB ↔ DB, lake ↔ warehouse, files ↔ DB) | **ADF Copy activity** |
| Schema-drift ETL between data stores with column mapping | **ADF Mapping Data Flow** |
| Scheduled nightly / hourly batch loads | ADF schedule or tumbling-window trigger |
| Lake hydration / Delta / Parquet writes | ADF (or Synapse Pipelines for unified analytics workspace) |
| SSIS lift-and-shift | ADF Azure-SSIS Integration Runtime |
| Event-driven workflow with multiple steps | **Logic Apps Standard** (not ADF) |
| Custom compute / transformation logic | **Azure Functions** (called from ADF, or stand-alone) |
| Real-time streaming ingestion | **Event Hubs** (then ADF for batch on Capture output) |
| Small batches (< 5,000 records) of records that fit a workflow | **Logic Apps for-each** (see batch-processing Pattern 1) |
| Massive parallelism with checkpoint/replay | **Durable Functions** (see batch-processing Pattern 2) |

Choose ADF when the integration is **mostly data movement with optional column-level mapping** and the schedule/cadence is batch (not event-driven). When in doubt, ADF tends to be the right choice for cardinalities > ~100,000 records / day and Logic Apps tends to be right below that.

---

## Modes

| Mode | Trigger | Output |
|------|---------|--------|
| **Design Pipeline** | Architecting a data-movement / ETL flow | Pipeline structure, activity choice, dataset / linked service map |
| **Configure Data Flow** | Designing column-level transformation | Mapping Data Flow with source / transformation / sink |
| **Choose Integration Runtime** | Deciding where the IR runs (Azure-managed, on-prem, SSIS) | IR type + sizing |
| **Deploy** | Provisioning ADF + source control + CI-CD | Bicep + ARM template extraction, Git mode setup |

---

## Mode 1 — Design Pipeline

### Core Concepts

| Concept | Purpose |
|---|---|
| **Pipeline** | Logical group of activities — the unit of trigger and monitoring |
| **Activity** | Single step (Copy, Data Flow, Lookup, Web, ForEach, Execute Pipeline, Stored Procedure, ...) |
| **Dataset** | Schema + location of data being read/written (table, file path, etc.) |
| **Linked Service** | Connection to a data store (SQL Server, Blob, Salesforce, etc.) — equivalent to a Logic Apps connection |
| **Trigger** | What starts the pipeline (Schedule, Tumbling Window, Event, Custom) |
| **Integration Runtime (IR)** | Compute that executes activities — Azure-managed, Self-Hosted (on-prem), or Azure-SSIS |

### Common Activity Patterns

| Pattern | Activities |
|---|---|
| Simple source → sink copy | `Copy data` |
| Source → transform → sink | `Copy data` → `Mapping Data Flow` → `Copy data` (or single Data Flow with multi-sink) |
| Conditional logic | `If Condition`, `Switch`, `Until` |
| Parallel item processing | `ForEach` (sequential by default — set `isSequential: false` and `batchCount` for parallelism) |
| Lookup-driven dynamic flow | `Lookup` (returns rows / first row) → drive subsequent activities |
| Sub-pipeline call | `Execute Pipeline` |
| External call | `Web` activity (REST call) or `Azure Function` activity |
| Stored procedure | `Stored procedure` activity |
| Wait / delay | `Wait` activity |

### Trigger Type Decision

| Cadence | Trigger | Notes |
|---|---|---|
| Fixed schedule (e.g. daily 02:00) | **Schedule trigger** | Simple cron-like |
| Sliding/tumbling time windows with backfill support | **Tumbling Window trigger** | Time-window dependencies, replay, concurrency control — use for incremental loads |
| File-arrival event in Blob / ADLS | **Event trigger** | Wire to Event Grid system topic on Storage |
| Custom event (publish from app) | **Custom event trigger** | Use Event Grid with a custom topic |
| One-off manual | **Manual** | Ad-hoc runs from portal / CLI |

**Default for incremental ETL**: Tumbling Window. It tracks per-window state, supports replay, and handles concurrency.

### Emit valid JSON (MUST — every artifact file is strict-parsed before deploy)

Every file under `adf/**` is strict JSON — pipelines, datasets, linked services, dataflows, triggers, factory. `/implement-azure` runs a hard JSON-validity gate over `adf/**/*.json` (and `az datafactory ... create` rejects malformed JSON outright). Before finalizing each artifact, confirm it parses.

- **Brace-balance trap on `Web` activities (and any activity with an inline-closed `typeProperties`).** When you write a `Web` activity `body`/`headers` and close `body` + `typeProperties` inline on one line as `... "type": "Expression" } }`, emit **exactly one** activity-closing `}` after it — not two. A spurious extra `}` (turning the `ifTrue/ifFalseActivities` array close `]` into `} ]`) produces `Expecting ',' delimiter` and an undeployable pipeline. Prefer closing `body`, `typeProperties`, and the activity on their own lines (one `}` each) so the nesting is auditable, exactly as the multi-line `Web` activities do.
- After authoring a pipeline with nested `If Condition`/`Switch`/`ForEach` activities, re-balance braces/brackets mentally per scope: `typeProperties{ expression{} ifTrueActivities[ {activity} ] }` — the array closes with `]`, each activity with `}`.
- **Escape control characters — never emit a raw control byte in a JSON string.** A fixed-width / single-column `DelimitedText` dataset commonly uses a sentinel `columnDelimiter` of SOH; it MUST be the 6-character JSON escape `\u0001` (backslash, u, 0001), never a raw 0x01 byte (which is `Invalid control character` to every JSON parser). Any byte below 0x20 must be emitted as its `\uXXXX` escape (or `\t` / `\n` / `\r`). `rowDelimiter` is the escape `\n`, not a literal newline.

---

## Mode 2 — Configure Data Flow

Mapping Data Flow is ADF's column-level transformation engine. It runs on Spark under the hood — choose it when the transform exceeds Copy activity's tabular mapping.

### Data Flow vs Wrangling Data Flow

| Aspect | Mapping Data Flow | Wrangling Data Flow |
|---|---|---|
| Authoring | Visual transformation pipeline | Power Query Online UI |
| Engine | Spark | Spark (Power Query M translated) |
| Use when | Production ETL with explicit schema | Self-service data prep / exploration |
| Schema drift | First-class | Limited |
| **Default for greenfield** | **Yes** | Only for ad-hoc / user-driven |

### Schema Drift

Use when the source schema may add/remove columns over time without prior notice:

- Set source dataset to `allowSchemaDrift: true`.
- Use `byName('columnName')` / pattern matching to address columns dynamically.
- Add `Auto mapping` on sink to propagate new columns.
- Quarantine rows that fail mapping with a `Conditional Split` to an error path.

### Sink Optimisation

| Sink type | Key settings |
|---|---|
| Azure SQL DB | `tableAction: truncate / preCopyScript`, batch size 10,000–100,000 |
| Synapse | PolyBase / COPY into staging, then load |
| Cosmos DB | `writeStrategy: insert / upsert`, throughput target sizing |
| Lake (Parquet / Delta) | Partition columns, compression (Snappy default) |

---

## Mode 3 — Choose Integration Runtime

| IR Type | Where it runs | Use when |
|---|---|---|
| **Azure IR** | Azure-managed | Source and sink both in Azure or accessible over public internet / private endpoint |
| **Self-Hosted IR** | VM in your network (on-prem or Azure VNet without ADF VNet integration) | Source or sink is on-prem; needs ADF agent on a Windows machine |
| **Azure-SSIS IR** | Azure-managed SSIS host | SSIS package lift-and-shift |
| **Managed VNet Azure IR** | Azure-managed but inside a managed VNet | Need private-endpoint access to sources/sinks from ADF |

### Self-Hosted IR Sizing

| Concurrent jobs | Node count | Node spec |
|---|---|---|
| 1–4 | 1 | D2/D4 v3 |
| 5–10 | 2 | D4 v3 |
| 10+ | 3–4 (HA) | D8 v3+ |

Always deploy ≥ 2 nodes in production for HA (failover) — never a single-node SHIR in production.

---

## Mode 4 — Deploy

### Source Control & CI-CD

1. **Always enable Git mode** on ADF — never let production ADF run in Live mode (changes are unversioned and unrecoverable).
2. Author in a `feature/*` branch in the connected repo (Azure DevOps or GitHub).
3. PR to `main`; publish from `main` creates an ARM template under `adf_publish` branch (legacy) or via the modern `npm run build` flow.
4. Use `Microsoft.DataFactory/factories/triggers stop/start` PowerShell during deployment — triggers must be stopped to redeploy them.
5. Per-environment parameter file (`ARMTemplateParametersForFactory.json`) holds linked service connection strings per env.

### Deployment Method Decision Table

| Scenario | Method |
|---|---|
| New factory + pipelines | Bicep for the factory, ADF ARM publish for the pipelines |
| Pipeline-only changes | Git mode publish + ARM deploy via pipeline |
| Linked service property change | Update parameter file + redeploy |
| Hotfix | Hotfix branch → cherry-pick to main → publish |
| SSIS package | Deploy SSISDB to Azure SQL MI, then run via Azure-SSIS IR `Execute SSIS Package` activity |

### Bicep Outline

```
infra/
├── data-factory.bicep              # factory + managed identity
├── data-factory-managed-vnet.bicep # managed VNet IR (if needed)
└── data-factory-private-endpoints.bicep
```

Pipeline / dataset / linked service / data flow definitions are deployed via ADF's own ARM publish, not via Bicep.

---

## ADF vs Synapse Pipelines

Synapse Pipelines is the **same engine** as ADF, with three differences:
- Lives inside a Synapse workspace alongside Spark and SQL pools.
- Adds notebook activities (Synapse Spark, Apache Spark).
- Cannot use Self-Hosted IR (must use Azure IR only).

Choose **Synapse Pipelines** when the data movement is part of a broader Synapse-based analytics workload. Choose **ADF** when integration is the primary purpose and the destination is downstream of any analytics workspace.

---

## Common CLI Commands

```bash
# Create factory
az datafactory create --resource-group <rg> --name <factory> --location uksouth

# Set Git config (Azure DevOps example)
az datafactory configure-factory-repo --resource-group <rg> --factory-name <factory> \
  --location uksouth \
  --factory-vsts-configuration \
    project-name=<project> repository-name=<repo> root-folder=/ \
    collaboration-branch=main account-name=<org> tenant-id=<tenant>

# Stop / start triggers (required before deploy)
az datafactory trigger stop --resource-group <rg> --factory-name <factory> --name <trigger>
az datafactory trigger start --resource-group <rg> --factory-name <factory> --name <trigger>

# Trigger pipeline run
az datafactory pipeline create-run --resource-group <rg> --factory-name <factory> \
  --name <pipeline>

# Get run status
az datafactory pipeline-run show --resource-group <rg> --factory-name <factory> --run-id <run-id>
```

---

## Cross-references

- [batch-processing/SKILL.md](../batch-processing/SKILL.md) — selection rules between ADF, Logic Apps for-each, Durable Functions, and Service Bus batch trigger
- [event-hubs/SKILL.md](../event-hubs/SKILL.md) — when streaming should land in a lake via Capture for ADF to pick up
- [azure-functions/SKILL.md](../azure-functions/SKILL.md) — when an ADF pipeline needs custom compute (`Azure Function` activity)
- [logicapp-cloud-deployment/SKILL.md](../logicapp-cloud-deployment/SKILL.md) — when a hybrid pipeline calls a Logic App (`Web` activity) for orchestration
- [ais-platform/SKILL.md](../ais-platform/SKILL.md) — platform-tier placement of ADF alongside other AIS services
