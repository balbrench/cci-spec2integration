---
name: batch-processing
description: Design patterns for batch processing on Azure Integration Services — Logic Apps for-each (small/medium batches), Durable Functions fan-out/fan-in (large batches), Azure Data Factory (ETL-style), and Service Bus + Logic Apps batch trigger (event-driven micro-batches). Covers batch size limits, idempotency, dead-letter handling, and BizTalk/MuleSoft-batch concept mapping. Pairs with `templates/azure/reference-workflows/batch-send/` and `batch-receive/`.
---

# Batch Processing — Design Skill

> **Purpose**: How to choose and shape batch processing patterns when the integration must process more than a handful of records at a time. Use when a flow says "synchronise all", "send daily", "process N records", or migrates a BizTalk pipeline / MuleSoft `batch:job`.

---

## 1. Pattern Selection

| Scenario | Pattern | Size Sweet Spot |
|---|---|---|
| Bounded array known up front, simple per-item work | Logic App with For-Each + concurrency | < ~5,000 records / run |
| Massive parallelism, checkpoint/replay needed | Durable Functions (fan-out/fan-in) | 10,000+ records |
| Pure data movement source ↔ sink, big volumes | Azure Data Factory pipeline | High-volume ETL/ELT |
| Continuous event stream, accumulate into micro-batches | Service Bus + Logic App batch trigger | Streaming, micro-batches every N msgs / N seconds |
| Periodic full reload / synchronisation | Timer-triggered Logic App orchestrating sub-flows | Daily/weekly bulk syncs |
| Out-of-band, very long, full audit trail | Function App on Premium / Container Apps with claim-check | Anything > 30 min that can't suspend |

---

## 2. Pattern 1: Logic App For-Each (Small-Medium)

```
Timer trigger → Query source system → For each record:
    → Transform → Upsert to target → Track success/failure
→ Send summary notification
```

- Use the `foreach` action with `runtimeConfiguration.concurrency.repetitions` to control parallelism (see `logic-app-patterns` §3).
- Track success/failure counts in variables (`Increment_variable`).
- Suitable up to ~5,000 records — beyond that, run duration and Logic App per-action limits start to bite.
- The for-each iterates **completely in one workflow run**; there is no resumable checkpoint. If the run is cancelled, restart processes everything.

---

## 3. Pattern 2: Durable Functions Fan-Out / Fan-In (Large)

```
Timer trigger → Orchestrator Function
    → Fan-out: spawn N parallel Activity Functions (each processes a slice)
    → Fan-in: aggregate results
    → Summary action
```

- Durable Functions checkpoint state — a process restart resumes from the last checkpoint.
- Use sub-orchestrations for nested fan-out (e.g. partner × document type).
- Suitable for 10,000+ records or when run time exceeds Logic App practical limits.
- See `azure-functions` §3 "Durable Functions Pattern Decision Table" for the pattern catalogue.

---

## 4. Pattern 3: Azure Data Factory (ETL-style)

```
Scheduled trigger → Copy Activity (source → staging)
    → Data Flow (transform) → Copy Activity (staging → target)
    → Pipeline-level notification
```

- Best for **data movement** between stores (database ↔ database, lake ↔ warehouse).
- Built-in connectors for 100+ data sources; column-mapping done visually.
- Use when the integration is fundamentally a data-engineering pipeline, not an event-processing one.

---

## 5. Pattern 4: Service Bus + Logic App Batch Trigger (Event-driven)

```
Source system → Service Bus queue (individual messages)
    → Logic App with batch trigger (accumulate N messages OR time window)
    → Bulk operation to target system
    → Complete batch
```

- Natural back-pressure handling — the queue absorbs bursts.
- Dead-letter queue isolates poison messages.
- Good for continuous micro-batch patterns (every 100 messages, or every 5 minutes).
- See `templates/azure/reference-workflows/batch-receive/` and `batch-send/` for the canonical JSON.

---

## 6. BizTalk / MuleSoft Batch Concepts → Azure Mapping

| Source concept | Azure equivalent |
|---|---|
| BizTalk `Receive pipeline` with debatching | Logic App `splitOn` on the trigger or for-each over a parsed array |
| BizTalk `Send port` with batched envelope | Service Bus batch send + Logic App batch action |
| MuleSoft `batch:job` | Logic App workflow OR Durable Function orchestration |
| MuleSoft `batch:step` | Logic App scope OR Activity Function |
| MuleSoft `batch:commit` | Bulk API call with batch-size parameter |
| MuleSoft `batch:aggregator` | Durable Functions fan-in OR Logic App `Compose` of accumulator variable |
| `maxFailedRecords` threshold | Variable tracking + `If` to abort + alert |
| `batch:history` / job persistence | Application Insights custom events + Storage Table |

---

## 7. Rules

1. **Determine target-system batch limits before designing** — Salesforce Bulk API caps at 10,000 per batch, Dynamics 365 at 1,000, Cosmos DB bulk at 100. Match concurrency to the cap, not arbitrary numbers.
2. **Idempotency is mandatory** — batch reruns must not create duplicates. Use natural keys, upsert semantics, or store batch run IDs.
3. **Dead-letter every failure path** — route failed records to a queue or Storage Table for manual review/retry; never silently skip.
4. **Track per-run metrics** — records read, processed, failed, skipped, duration. Surface in Application Insights with `trackedProperties` (Logic Apps) or `ILogger` custom events (Functions).
5. **Timeout management** — Logic App run timeout is configurable up to 30 days; individual action timeout defaults to 2 minutes (configurable per action). Durable Functions have no built-in timeout but inherit the hosting plan's idle limits.
6. **Claim check for large payloads** — if individual records exceed 256 KB (Service Bus Standard) or 100 MB (Premium), upload to Blob Storage and pass a reference instead of the payload.
7. **Validate idempotency keys exist** before starting the batch — if the source doesn't provide a stable per-record key, generate and persist one at ingestion.

---

## Cross-references

- `.claude/skills/logic-app-patterns/SKILL.md` §3 (for-each concurrency) and §6 (retry policy)
- `.claude/skills/azure-functions/SKILL.md` §3 (Durable Functions patterns)
- `.claude/skills/service-bus/SKILL.md` (queue/topic selection, DLQ design)
- `templates/azure/reference-workflows/batch-send/`
- `templates/azure/reference-workflows/batch-receive/`
