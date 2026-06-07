---
name: event-hubs
description: Design, configure, and deploy Azure Event Hubs for high-throughput event streaming and ingestion. Covers tier selection (Basic / Standard / Premium / Dedicated), partition design, consumer group strategy, throughput units / processing units, Capture (to Blob/ADLS), Schema Registry, Kafka surface compatibility, networking, and the Event Hubs vs Service Bus vs Event Grid boundary. Consumed by `azure-bicep-author` when an IR channel of kind `eventhub` is present, by `target-architecture` when streaming intake is in scope, and by `azure-logic-apps-compiler` (which already has the [event-hub-trigger workflow template](../../../templates/azure/reference-workflows/event-hub-trigger/) and [event-hub connection template](../../../templates/azure/reference-workflows/connections/event-hub/)).
---

# Azure Event Hubs — Builder Skill

> **Purpose**: Authoritative design rules for Event Hubs namespaces, hubs, partitions, consumer groups, and capture. Use when the integration needs high-throughput streaming intake (telemetry, IoT, log streams, CDC firehoses) — not for "do this work" command processing (use Service Bus) and not for "something happened" event notification (use Event Grid).

The Logic Apps `event-hub` service-provider connector and `event-hub-trigger` pattern are already covered by our reference workflows. **This skill covers the design above that** — what hub to provision, with what partition count and tier, why, and what to send through it.

---

## When to Use Event Hubs vs Service Bus vs Event Grid

This is the single most-asked design question. Use this table verbatim — the three services are routinely confused.

| Factor | Event Hubs | Service Bus | Event Grid |
|---|---|---|---|
| **Primary intent** | High-throughput event ingestion / streaming | Reliable message processing (commands, work units) | Event notification / reactive fan-out |
| **Throughput target** | Millions of events / sec | Thousands of msgs / sec (Premium) | Push-driven, scaled by event-rate |
| **Ordering** | Per-partition FIFO | Per-session FIFO | None |
| **Delivery** | Pull (consumer-driven, with checkpoint) | Pull or push, with lock | Push (at-least-once) |
| **Message size** | 1 MB (Basic/Standard), 1 MB (Premium body), batch up to 1 MB | 256 KB (Standard) / 100 MB (Premium) | 1 MB max |
| **Retention** | 1–7 days (Std), up to 90 days (Premium/Dedicated) | Per-message TTL | Stateless — events are delivered, not stored |
| **Replay** | Yes — re-read from offset | No (once consumed, gone) | No |
| **Dead-letter** | No (consumer responsibility) | Built-in sub-queue | Blob Storage |
| **Schema** | Free-form, or Schema Registry (Avro/JSON/Protobuf) | Free-form | Event Grid schema or CloudEvents v1.0 |
| **Use when** | Streaming telemetry, IoT, log/metric pipelines, CDC, real-time analytics ingest | Command/work processing, transactional workflows, ordered correlated processing | "Something happened" reactions, webhook fan-out, Azure resource events |

If unsure: streaming + replay needed + high volume → **Event Hubs**. Discrete unit-of-work to process → **Service Bus**. Decoupled "did happen" notification → **Event Grid**.

---

## Modes

| Mode | Trigger | Output |
|------|---------|--------|
| **Design Topology** | Architecting an event-streaming intake | Namespace + hub design, partition count, consumer group strategy, tier selection |
| **Configure Entities** | Creating and configuring hubs and consumer groups | Hub definitions, retention, Capture config, throughput / PU sizing |
| **Implement Consumers** | Choosing consumer technology | Functions / Logic Apps / Stream Analytics / SDK consumer decision |
| **Deploy** | Provisioning Event Hubs infrastructure | Bicep IaC, geo-DR setup, private endpoints |

---

## Mode 1 — Design Topology

### Tier Decision

| Need | Tier |
|---|---|
| Low-volume, dev/test, simple ingestion (< 80 MB/s per TU, 1 day retention max) | **Basic** |
| Production streaming, Capture, multiple consumer groups, 7-day retention, ≤ 40 TUs | **Standard** |
| Predictable performance, longer retention (up to 90 days), private endpoints, namespace-scoped Processing Units, Kafka v3+ | **Premium** |
| 99.99% SLA, very high throughput (CUs), full multi-tenant isolation | **Dedicated** |

Default for greenfield production: **Premium** if private networking or > 30-day retention is needed; **Standard** otherwise.

### Partition Count Decision

Partitions are **immutable on Basic/Standard** — pick correctly up front. On Premium/Dedicated you can scale up.

| Workload | Recommended partitions |
|---|---|
| Telemetry / log streaming, ordered per-device | One partition per device-class group; throughput-bounded (1 MB/s per partition) |
| CDC / change feed | Match upstream source's partition strategy (or 4–8 if unknown) |
| IoT (high device count) | 8–32, route by deviceId hash |
| Generic high-throughput intake | Start at 8; scale up before going to production |
| Low-volume notifications (< 100 events/sec) | 2–4 |

**Hard rules**: partitions are the unit of parallelism — N consumers in one consumer group can read from at most N partitions simultaneously. Under-partitioning is a permanent throughput ceiling on Standard. Over-partitioning wastes management overhead and can fragment per-partition ordering.

### Consumer Group Strategy

| Pattern | Consumer groups |
|---|---|
| Single downstream consumer (one system reads the stream) | `$Default` |
| Multiple independent consumers (analytics + storage + alerting) | One consumer group per consumer — each maintains its own offset |
| Reprocessing / backfill | Temporary consumer group, deleted after backfill completes |

**Rule**: never share a consumer group across two logically independent consumers — they'll fight over offsets and one will starve the other.

### Capture Decision

Capture writes incoming events to Blob Storage or ADLS Gen2 automatically. Enable when:

- You want a durable archive beyond the retention window.
- Downstream batch analytics needs Avro/Parquet on lake storage.
- Regulatory retention requires keeping raw events for years.

Skip Capture when retention covers all consumers' needs and an archive isn't required — it adds Storage cost.

---

## Mode 2 — Configure Entities

### Hub Properties Quick Reference

| Property | Default | Recommended Prod | Impact |
|---|---|---|---|
| Partition count | 4 | 8–32 (see Partition Count Decision) | Parallelism ceiling on Basic/Std |
| Message retention | 1 day | 3–7 days (Std), up to 90 (Premium) | Replay window |
| Capture | Off | On (if archive needed) | Auto-archive to Blob/ADLS |
| Capture window | 5 min / 300 MB | Default | Tune for batch size vs latency |
| Capture format | Avro | Avro or Parquet | Parquet better for downstream lake analytics |

### Schema Registry (Premium only)

Use when:

- Producers and consumers are independent teams and schema drift is a real risk.
- Avro / Protobuf / JSON Schema enforcement is needed at write or read time.
- Multiple schema versions must coexist with compatibility rules.

Skip if producer and consumer ship together and schema changes are coordinated by code review.

### Kafka Surface

Event Hubs exposes a Kafka v1.0+ surface (v3+ on Premium). Use the Kafka surface when:

- Existing producer/consumer code is written against Apache Kafka and you don't want to rewrite it.
- Cross-cloud / hybrid Kafka tooling (e.g. Kafka Connect, Confluent Schema Registry interop) is in scope.

Use the native AMQP surface when:

- Greenfield .NET / Java / Node / Python code — the native SDK is simpler and slightly higher performance.

---

## Mode 3 — Choose Consumer Technology

| Scenario | Approach | Rationale |
|---|---|---|
| Per-event processing with light logic | Azure Functions Event Hubs trigger | Auto-scale, batch-size configurable, EventProcessor under the hood |
| Per-event processing with heavy / stateful logic | SDK (`EventProcessorClient`) in hosted service or Container Apps | Full checkpoint control, batch tuning |
| Workflow-style processing per event | Logic Apps Standard `event-hub` trigger | First-class Logic Apps integration — see [event-hub-trigger template](../../../templates/azure/reference-workflows/event-hub-trigger/) |
| Real-time analytics (windowed aggregates, joins) | Azure Stream Analytics | SQL-like windowing, native EH input |
| Land to lake / warehouse | Capture → ADF / Synapse Pipelines | See [data-factory](../data-factory/SKILL.md) |
| Cross-region routing | Premium namespace with geo-DR pair | Built-in alias-based failover |

Logic Apps Standard's `event-hub` connector wiring lives in [connections-json-generation-rules](../connections-json-generation-rules/SKILL.md); the workflow shape lives in our [event-hub-trigger reference template](../../../templates/azure/reference-workflows/event-hub-trigger/).

---

## Mode 4 — Deploy

1. Choose tier per the Tier Decision table.
2. Author Bicep for the namespace + hub(s) + consumer groups + Capture destination.
3. For Premium/Dedicated, configure private endpoints and namespace-scoped firewall.
4. Set up geo-DR pairing if RTO/RPO requires cross-region failover (Premium only).
5. Set up monitoring: throughput, incoming/outgoing messages, throttled requests, captured backlog age.
6. Configure auto-inflate (Standard) or PU autoscale (Premium) — never run at the ceiling.

The `azure-bicep-author` agent should add an `eventhubs.bicep` module when an IR channel of kind `eventhub` is present (parallel to today's `servicebus.bicep` module). Until that's wired in, treat Event Hubs as a hand-authored sibling Bicep module within the same `infra/` directory.

---

## Common CLI Commands

```bash
# Create namespace (Premium)
az eventhubs namespace create --resource-group <rg> --name <ns> \
  --location uksouth --sku Premium --capacity 1

# Create event hub
az eventhubs eventhub create --resource-group <rg> --namespace-name <ns> \
  --name <hub> --partition-count 8 --message-retention 3

# Create consumer group
az eventhubs eventhub consumer-group create --resource-group <rg> --namespace-name <ns> \
  --eventhub-name <hub> --name analytics-consumer

# Enable Capture (writes to Blob)
az eventhubs eventhub update --resource-group <rg> --namespace-name <ns> \
  --name <hub> --capture-enabled true \
  --capture-interval 300 --capture-size-limit 314572800 \
  --destination-name EventHubArchive.AzureBlockBlob \
  --storage-account <storage-account-id> --blob-container <container>

# Set up geo-DR pairing (Premium only)
az eventhubs georecovery-alias set --resource-group <rg> --namespace-name <primary-ns> \
  --alias <alias-name> --partner-namespace <secondary-ns-id>
```

---

## Cross-references

- [service-bus/SKILL.md](../service-bus/SKILL.md) — when "do this work" semantics fit better
- [event-grid/SKILL.md](../event-grid/SKILL.md) — when "something happened" notification fits better
- [data-factory/SKILL.md](../data-factory/SKILL.md) — when streaming should land into a lake/warehouse for batch analytics
- [connections-json-generation-rules/SKILL.md](../connections-json-generation-rules/SKILL.md) — Logic Apps Standard `event-hub` connection wiring
- [templates/azure/reference-workflows/event-hub-trigger/](../../../templates/azure/reference-workflows/event-hub-trigger/) — canonical workflow.json
- [templates/azure/reference-workflows/connections/event-hub/](../../../templates/azure/reference-workflows/connections/event-hub/) — connection.json (connection-string variant)
- [eip-to-azure-mapping/SKILL.md](../eip-to-azure-mapping/SKILL.md) — IR streaming nodes → Event Hubs placement
