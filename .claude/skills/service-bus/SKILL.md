---
name: service-bus
description: Design, configure, and deploy Azure Service Bus messaging topologies. Covers messaging-pattern selection (queues vs topics, sessions, DLQ, auto-forward), entity property tuning (lock duration, max delivery, duplicate detection), filter authoring (SQL vs correlation), and tier/IaC decisions. Consumed by `azure-bicep-author` when an IR channel of kind `queue` or `topic` is present, and by designers reasoning about messaging boundaries. Adapted from the AVN-Agents AIS framework.
---

# Azure Service Bus — Builder Skill

> **Purpose**: Authoritative design-and-deployment rules for Service Bus namespaces, queues, topics, and subscriptions. Use when an IR introduces a Service Bus channel, or when reasoning about messaging boundaries between flows.

The `connections-json-generation-rules` skill covers Logic Apps Standard `serviceBus` connection wiring at the workflow level. **This skill covers the design above that** — what queue/topic to provision, with what properties, and why.

---

## Modes

| Mode | Trigger | Output |
|------|---------|--------|
| **Design Topology** | Architecting messaging patterns for an integration | Namespace design, queue/topic layout, subscription routing, session strategy |
| **Configure Entities** | Creating and configuring queues, topics, and subscriptions | Entity definitions with properties, filters, actions, dead-letter config |
| **Implement Consumers** | Choosing producer/consumer technology | Logic App / Function App / SDK consumer decision |
| **Deploy** | Provisioning Service Bus infrastructure | Bicep IaC, geo-DR setup |

---

## Mode 1 — Design Topology

### Pattern Decision Table

| Scenario | Pattern | Entity Type | Key Config |
|----------|---------|-------------|------------|
| Task distribution (1:1) | Competing consumers | Queue | Multiple consumers, maxConcurrentCalls |
| Event broadcast (1:N) | Publish-subscribe | Topic + Subscriptions | Subscription per consumer |
| Content-based routing | Topic with filters | Topic + filtered subscriptions | SQL/correlation filters |
| Request-reply | Correlation | Queue pair (request + reply) | ReplyTo, CorrelationId, SessionId |
| Message ordering | Sessions | Queue/Subscription + sessions | SessionId, session receiver |
| Scheduled processing | Scheduled delivery | Queue | ScheduledEnqueueTimeUtc |
| Priority queue | Multiple queues | Separate queues per priority | Consumer reads high-priority first |
| Sequential convoy | Sessions + FIFO | Queue with sessions | SessionId per convoy |
| Dead-letter recovery | DLQ processing | Dead-letter sub-queue | Separate consumer for DLQ |
| Message forwarding chain | Auto-forwarding | Queue → Queue or Queue → Topic | ForwardTo property |

### Namespace Design Principles

| Principle | Guidance |
|-----------|----------|
| **Domain isolation** | One namespace per business domain (orders, payments, shipping) |
| **Environment isolation** | Separate namespaces per environment (dev, test, prod) |
| **Throughput isolation** | Premium: separate namespaces for high-throughput workloads |
| **Security boundary** | Each namespace = separate RBAC boundary |
| **Naming convention** | `sb-{domain}-{env}` (e.g. `sb-orders-prod`) |

### Queue vs Topic Decision

| Factor | Queue | Topic |
|--------|-------|-------|
| Consumer count | Single logical consumer (competing) | Multiple independent consumers |
| Message routing | None (FIFO or session-based) | Subscription filters |
| Fan-out | No | Yes |
| Ordering guarantee | Per-session or FIFO | Per-session per subscription |
| Dead-letter | Per-queue DLQ | Per-subscription DLQ |
| **Use when** | Point-to-point processing tasks | Event distribution, content-based routing |

---

## Mode 2 — Configure Entities

### Entity naming — match the IR channel name verbatim (Sev-1)

When provisioning queues/topics/subscriptions for an IR channel, the entity `name` MUST be the **exact** `channels[].name` from the IR — which is also the literal `queueName`/`topicName`/`entityPath` the compiled `workflow.json` actions target. Do **not** strip, append, or normalize segments (e.g. IR `ftp-passthru-dlq-queue` must stay `ftp-passthru-dlq-queue`, never become `ftp-passthru-dlq`). A divergent name compiles fine but fails at runtime with `MessagingEntityNotFound`, and the RBAC role-assignment scopes (which key off the same names) silently fail to authorize. Seed both the entity resources and their RBAC scopes from one array sourced directly from `channels[].name`.

### Entity Configuration Quick Reference

| Property | Queue Default | Recommended Prod | Impact |
|----------|---------------|------------------|--------|
| Max delivery count | 10 | 5–10 | Attempts before dead-letter |
| Lock duration | 30s | 60s–5min | Time to process before abandon |
| TTL (default message) | 14 days | Business-appropriate | Message expiry |
| Max size | 1 GB | 5 GB (Premium: 80 GB) | Queue capacity |
| Duplicate detection | Off | On (if idempotency needed) | Dedup window |
| Sessions | Off | On (if ordering needed) | Enables session-based processing |
| Partitioning | Off | On (Standard, for throughput) | Distributes across brokers |
| Auto-delete on idle | Off | Off (prod) / On (dev/test) | Auto-cleanup |

### Filter Types

| Filter Type | Syntax | Best For | Performance |
|-------------|--------|----------|-------------|
| **SQL filter** | `sys.Label = 'orders' AND amount > 100` | Complex routing logic | Slower |
| **Correlation filter** | Property-based match | Simple property matching | Fastest |
| **True filter** | `1=1` | Catch-all subscription | N/A |
| **False filter** | `0=1` | Disabled subscription | N/A |

### Message Construction Best Practices

1. **Set `MessageId`** for duplicate detection (unique per logical message).
2. **Set `CorrelationId`** for end-to-end tracing.
3. **Set `ContentType`** to `application/json` for JSON payloads.
4. **Set `SessionId`** if ordering is required (same session = same order).
5. **Use application properties** for routing metadata (filters match on these).
6. **Avoid large messages** — use claim-check pattern for payloads > 256 KB.
7. **Set `TimeToLive`** appropriate to business requirements.

---

## Mode 3 — Choose Consumer Technology

| Scenario | Approach | Rationale |
|----------|----------|-----------|
| Simple queue/topic consumer | Logic App Standard built-in `serviceBus` connector | Visual, deploys with the workflow, no extra App Service |
| Workflow with multiple steps | Logic App Standard | First-class scope/runAfter error handling |
| Complex processing with DI / heavy logic | Azure Functions binding | DI, fine-grained control, isolated worker |
| Long-running session processor | SDK (`ServiceBusProcessor`) in hosted service | Session lock management |
| High-throughput batch processing | SDK (`ServiceBusReceiver` batch) | Control batch size and timing |

Use `.claude/skills/connections-json-generation-rules/SKILL.md` for the Logic Apps Standard service-provider wiring. Use `.claude/skills/azure-functions/SKILL.md` for the stand-alone Function App option.

---

## Mode 4 — Deploy

### Tier Decision

| Need | Tier |
|------|------|
| Basic queues only, low throughput | Basic |
| Topics + subscriptions, dedup, sessions, 256 KB messages | Standard |
| VNet/private-endpoint, dedicated brokers, 100 MB messages, geo-DR | Premium |

### Deployment Decision Table

| Scenario | Method |
|----------|--------|
| New namespace + entities | Bicep |
| Add entities to existing namespace | Bicep update or `az servicebus queue create` |
| Entity property changes | Bicep update (avoid portal drift) |
| Geo-DR pairing | Bicep (Premium only) |

The `azure-bicep-author` agent already emits a `servicebus.bicep` module when an IR contains any `queue`/`topic` channel. When porting topology rules into IR, prefer authoring them in `channels[]` with explicit properties (sessions, dedup, dlq) rather than expecting defaults.

---

## Common CLI Commands

```bash
# Create namespace
az servicebus namespace create --resource-group <rg> --name <ns> \
  --sku Premium --capacity 1 --location uksouth

# Create queue
az servicebus queue create --resource-group <rg> --namespace-name <ns> \
  --name order-queue --max-delivery-count 10 --lock-duration PT1M \
  --default-message-time-to-live P14D --enable-duplicate-detection true

# Create topic + filtered subscription
az servicebus topic create --resource-group <rg> --namespace-name <ns> \
  --name order-events --default-message-time-to-live P7D

az servicebus topic subscription create --resource-group <rg> --namespace-name <ns> \
  --topic-name order-events --name high-value-orders

az servicebus topic subscription rule create --resource-group <rg> --namespace-name <ns> \
  --topic-name order-events --subscription-name high-value-orders \
  --name high-value-filter --filter-type SqlFilter --filter-sql-expression "amount > 1000"

# Peek dead-letter messages
az servicebus queue peek --resource-group <rg> --namespace-name <ns> \
  --queue-name order-queue --is-dead-lettered true --max-count 10
```

---

## Cross-references

- `.claude/skills/connections-json-generation-rules/SKILL.md` — Logic Apps Standard `serviceBus` connection wiring
- `.claude/skills/logic-apps-planning-rules/SKILL.md` — when to introduce a queue in the flow plan
- `.claude/skills/eip-to-azure-mapping/SKILL.md` — IR node → Service Bus entity mapping
