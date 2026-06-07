---
name: event-grid
description: Design, configure, and deploy Azure Event Grid event-driven architectures. Covers resource-type selection (system topic, custom topic, domain, namespace), schema choice (Event Grid vs CloudEvents v1.0), subscription filter authoring, retry/dead-letter configuration, and Event Grid vs Service Bus boundary decisions. Reference material for `azure-bicep-author` when an IR uses an `eventgrid` channel and for designers reasoning about event-driven flows. Adapted from the AVN-Agents AIS framework.
---

# Azure Event Grid — Builder Skill

> **Purpose**: Authoritative design-and-deployment rules for Event Grid topics, subscriptions, and event handlers. Use when reactions to Azure resource changes or custom domain events are part of the integration design.

The `azure-bicep-author` agent today emits a Service Bus module for any messaging channel; when an IR channel of kind `eventgrid` is introduced, this skill is the rule source for the additional Event Grid module.

---

## Modes

| Mode | Trigger | Output |
|------|---------|--------|
| **Design Topology** | Architecting event-driven integration patterns | Topic layout, domain design, schema choice, routing strategy |
| **Configure Subscriptions** | Setting up event subscriptions with filters and delivery | Subscription definitions, filter rules, dead-letter config, retry policies |
| **Implement Handlers** | Wiring event handlers (Functions, Logic Apps, webhooks) | Handler endpoint, CloudEvents parsing, validation handshake |
| **Deploy** | Provisioning Event Grid infrastructure | Bicep IaC, namespace/topic creation |

---

## Mode 1 — Design Topology

### Resource Type Decision Table

| Scenario | Resource Type | Rationale |
|----------|---------------|-----------|
| React to Azure resource events | System topic | Auto-created per Azure resource |
| Custom application events | Custom topic | Application publishes events |
| Multi-tenant / many-topic scenarios | Event domain | Up to 100,000 topics in one domain |
| MQTT IoT messaging | Event Grid namespace | MQTT v3.1.1 / v5 broker |
| Pull delivery (consumer-driven) | Event Grid namespace | Queue-like subscription |
| Push delivery (webhook/Function) | System/Custom topic | Event Grid pushes to handler |
| CloudEvents with routing | Event Grid namespace | Native CloudEvents support |

### Schema Decision

| Schema | When to Use | Trade-off |
|--------|-------------|-----------|
| **Event Grid schema** | Azure-native workloads, simple setup | Azure-specific, simpler |
| **CloudEvents v1.0** | Multi-cloud, industry standard, interop | Requires CloudEvents SDK |
| **Custom input schema** | Legacy systems with existing format | Requires mapping on ingest |

### Event Grid vs Service Bus

| Factor | Event Grid | Service Bus |
|--------|------------|-------------|
| Pattern | Event notification | Message processing |
| Delivery | At-least-once (push) | At-least-once (pull/push) |
| Message size | 1 MB max (64 KB for Basic) | 256 KB (Std) / 100 MB (Prem) |
| Ordering | No guarantee | FIFO (sessions) |
| Retry | Exponential backoff | Lock-based retry |
| Dead-letter | Blob Storage | Built-in sub-queue |
| Use when | "Something happened" (react) | "Do this work" (command) |

---

## Mode 2 — Configure Subscriptions

### Handler Decision Table

| Handler | Best For | Configuration |
|---------|----------|---------------|
| Azure Functions | Event processing with code | Function URL or resource ID |
| Logic Apps | Workflow-based event processing | Logic App resource ID |
| Webhook | External HTTP endpoints | Endpoint URL + validation |
| Service Bus Queue | Queue for downstream processing | Queue resource ID |
| Service Bus Topic | Fan-out from event to topic | Topic resource ID |
| Event Hub | High-throughput event streaming | Event Hub resource ID |
| Storage Queue | Simple event queuing | Queue URL |
| Hybrid Connection | On-premises delivery | Relay resource ID |

### Filter Types

| Filter | Syntax | Use For |
|--------|--------|---------|
| Event type | `Microsoft.Storage.BlobCreated` | Filter by Azure event type |
| Subject begins with | `/blobServices/default/containers/orders` | Filter by resource path prefix |
| Subject ends with | `.json` | Filter by file extension |
| Advanced (string) | `data.status StringIn ['active', 'pending']` | Property value matching |
| Advanced (numeric) | `data.amount GreaterThan 1000` | Numeric comparison |
| Advanced (bool) | `data.isUrgent BoolEquals true` | Boolean matching |
| Advanced (null) | `data.region IsNotNull` | Null checking |

### Retry and Dead-Letter Settings

| Setting | Default | Range | Purpose |
|---------|---------|-------|---------|
| Max delivery attempts | 30 | 1–30 | Retry count before DLQ |
| Event TTL (minutes) | 1440 (24h) | 1–1440 | Max time to deliver |
| Dead-letter destination | None | Blob Storage container | Failed events storage |

---

## Mode 3 — Implement Handlers

### Idempotency Strategies (events may be delivered more than once)

| Strategy | Implementation |
|----------|----------------|
| Event ID dedup | Store processed event IDs in cache/database, skip duplicates |
| Idempotent operations | Design operations to produce same result on repeat (e.g. upsert) |
| Version checking | Check resource version before applying changes |
| Conditional writes | Use ETags / conditional headers on downstream calls |

### Webhook Validation Handshake

Webhook endpoints must echo back the `validationCode` from the first `Microsoft.EventGrid.SubscriptionValidationEvent` Event Grid sends. Logic Apps Standard and Azure Functions Event Grid trigger handle this automatically; raw webhook handlers must implement it explicitly.

---

## Mode 4 — Deploy

1. Choose resource type (system topic, custom topic, domain, namespace).
2. Author Bicep template for the topic + dead-letter Storage container.
3. Configure networking (private endpoints for custom topics/domains).
4. Set up monitoring and alerts.

---

## Common CLI Commands

```bash
# Create custom topic
az eventgrid topic create --resource-group <rg> --name <topic> \
  --location uksouth --input-schema cloudeventschemav1_0

# Create event subscription (webhook)
az eventgrid event-subscription create --name <sub> \
  --source-resource-id <topic-resource-id> \
  --endpoint <webhook-url> \
  --event-delivery-schema cloudeventschemav1_0 \
  --included-event-types OrderCreated OrderUpdated \
  --subject-begins-with /orders/

# Create system topic
az eventgrid system-topic create --resource-group <rg> --name <name> \
  --topic-type Microsoft.Storage.StorageAccounts \
  --source /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<storage>

# Create event domain
az eventgrid domain create --resource-group <rg> --name <domain> \
  --location uksouth --input-schema cloudeventschemav1_0

# Publish event (custom topic)
az eventgrid topic event publish --resource-group <rg> --name <topic> \
  --event-data '{"orderId": "123", "amount": 99.99}' \
  --event-type OrderCreated --subject /orders/123 \
  --data-version 1.0
```

---

## Cross-references

- `.claude/skills/service-bus/SKILL.md` — when "do this work" semantics fit better than "something happened"
- `.claude/skills/connections-json-generation-rules/SKILL.md` — Logic Apps Standard `eventGrid` / `eventGridPublisher` connection wiring
- `.claude/skills/eip-to-azure-mapping/SKILL.md` — IR event-driven nodes → Event Grid placement
