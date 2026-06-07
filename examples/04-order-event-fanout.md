# Order Event Publish-and-Fan-out

## Overview

- Purpose: Publish a canonical "order placed" event whenever the order management system accepts an order, and fan it out to multiple independent consumers — fulfillment, customer notification, and analytics — each processing the event on its own.
- Outcome: New consumers can subscribe to order events without changing the order system, and each consumer succeeds or fails independently rather than being coupled in one synchronous chain.
- In scope: Receiving an accepted-order signal, building a canonical order-placed event, publishing it to a topic, and three subscribing flows (fulfillment dispatch, customer notification, analytics capture) with independent delivery, retry, and dead-lettering.
- Out of scope: The order capture/validation that precedes acceptance, the internal logic of the fulfillment, notification, or analytics systems, and any event other than order-placed.

## Business Context

### Problem Statement

Today the order system calls fulfillment, notification, and analytics synchronously in sequence. If one is slow or down, order acceptance stalls or partially completes, and adding a new consumer means changing the order system. The business needs a decoupled, event-driven distribution where the order system publishes one event and interested systems consume it independently.

### Success Criteria

- An accepted order results in exactly one published order-placed event.
- Each subscriber processes every event at least once and is safe to receive duplicates.
- A failing subscriber does not block the others or the publisher.
- A new subscriber can be added without modifying the publisher.

## Actors and Systems

| Name | Type | Role |
|---|---|---|
| Order management system | system | Signals that an order has been accepted |
| Event distribution boundary | system | Builds and publishes the canonical order-placed event and hosts the subscribing flows |
| Fulfillment system | system | Consumes the event to begin dispatch |
| Notification service | system | Consumes the event to send the customer confirmation |
| Analytics store | system | Consumes the event for reporting |
| Integration operations team | human | Monitors subscriber failures and dead-letters |

## Triggers and Flow Summary

| Flow | Trigger | Source | Destination | Frequency / Volume |
|---|---|---|---|---|
| Publish order event | Order accepted | Order management system | Order-events topic | Event-driven; ~20,000 events/day, bursty during promotions |
| Fulfillment dispatch | Order-placed event | Order-events topic | Fulfillment system | One per event |
| Customer notification | Order-placed event | Order-events topic | Notification service | One per event |
| Analytics capture | Order-placed event | Order-events topic | Analytics store | One per event |

## Input and Output Contracts

### Inbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| Accepted-order signal | HTTP or message queue | JSON | application/json; UTF-8 | Emitted by the order system when an order is accepted |

### Outbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| Order-placed event publish | Publish/subscribe topic | JSON | application/json; UTF-8 | Single canonical event; multiple subscriptions |
| Fulfillment dispatch call | HTTP | JSON | application/json; UTF-8 | Subscriber → fulfillment system |
| Notification request | HTTP | JSON | application/json; UTF-8 | Subscriber → notification service |
| Analytics record | HTTP or message queue | JSON | application/json; UTF-8 | Subscriber → analytics store |

## Payload Definitions

### Inbound Payloads

#### Accepted-Order Signal

| Field | Type | Required | Source | Rules / Notes |
|---|---|---|---|---|
| orderId | string | yes | Order system | Business key; basis of the event idempotency key |
| customerId | string | yes | Order system | |
| acceptedAt | date-time | yes | Order system | ISO-8601 |
| currency | string | yes | Order system | ISO-4217 |
| totalAmount | number | yes | Order system | |
| lines | array | yes | Order system | Ordered line items |
| lines[].sku | string | yes | Order system | |
| lines[].quantity | number | yes | Order system | > 0 |
| lines[].unitPrice | number | yes | Order system | |
| shippingAddress | object | yes | Order system | Name, address, region |

### Outbound Payloads

#### Order-Placed Event

| Field | Type | Required | Destination | Rules / Notes |
|---|---|---|---|---|
| eventId | string | yes | Topic | Unique per published event |
| eventType | string | yes | Topic | Literal `order.placed` |
| eventVersion | string | yes | Topic | Schema version, e.g. `1.0` |
| occurredAt | date-time | yes | Topic | Equals `acceptedAt` |
| orderId | string | yes | Topic | Carried for subscriber idempotency |
| data | object | yes | Topic | The canonical order payload |

Example (published event):

```json
{
  "eventId": "9f1c2e7a-4b6d-4a1e-9f0c-2b6d4a1e9f0c",
  "eventType": "order.placed",
  "eventVersion": "1.0",
  "occurredAt": "2026-06-06T14:22:05Z",
  "orderId": "ORD-55012",
  "data": {
    "orderId": "ORD-55012",
    "customerId": "CUST-9931",
    "currency": "USD",
    "totalAmount": 84.0,
    "lines": [
      { "sku": "WIDGET-BLUE-240", "quantity": 20, "unitPrice": 3.25 },
      { "sku": "WIDGET-RED-120", "quantity": 6, "unitPrice": 3.25 }
    ],
    "shippingAddress": { "name": "Jo Diaz", "address": "5 Pine St, Reno NV 89501", "region": "US-NV" }
  }
}
```

## Functional Requirements

- FR-001: The integration shall receive an accepted-order signal from the order management system.
- FR-002: The integration shall build a canonical order-placed event from the signal, assigning a unique `eventId` and carrying `orderId` for downstream idempotency.
- FR-003: The integration shall publish the event to a topic that supports multiple independent subscriptions.
- FR-004: The integration shall provide a fulfillment subscriber that dispatches the order to the fulfillment system.
- FR-005: The integration shall provide a notification subscriber that requests a customer confirmation.
- FR-006: The integration shall provide an analytics subscriber that records the order for reporting.
- FR-007: Each subscriber shall process each event at least once, tolerate duplicate delivery, and fail independently of the others.

## Validation and Business Rules

- Event construction: `eventType` is `order.placed`, `eventVersion` is set, and `occurredAt` equals the signal's `acceptedAt`.
- Idempotency (publisher): the same `orderId` accepted twice must not produce two distinct order-placed events. [ASSUMPTION: the order system may re-send an acceptance signal on retry.]
- Idempotency (subscribers): each subscriber deduplicates on `orderId` (or `eventId`) so reprocessing a redelivered event is a no-op.
- Ordering: per-customer ordering is preferred but not strictly required across customers. [ASSUMPTION: global ordering is not required; per-customer ordering is best-effort.]

## Error Handling

- Expected validation failures: a signal missing a required field is rejected at the publisher boundary and never produces an event.
- Subscriber failures: each subscriber has its own retry policy with backoff; an event that exhausts retries is dead-lettered on that subscription only, leaving other subscribers unaffected.
- Poison events: a repeatedly failing event is dead-lettered with the failing subscriber, the error, and a correlation id for operator triage.
- Error response contract: dead-letter entries carry the original event, the subscriber name, the error detail, and the correlation id.

## Non-Functional Requirements

- Performance / throughput: sustain ~20,000 events/day with promotional bursts up to ~10x for short periods; subscribers scale independently.
- Availability / SLA: publish path highly available so order acceptance is never blocked; subscriber processing is eventually consistent. [ASSUMPTION: subscribers may lag by minutes during bursts without breaching SLA.]
- Security / identity: all connections use managed identity; no shared secrets in generated files. Each subscriber is granted only the access it needs.
- Data classification / compliance: confidential. The event carries customer identifiers and shipping addresses (PII) — the shipping address and customer id must be treated as PII end-to-end and never emitted to any public channel without redaction.
- Observability: a correlation id derived from `orderId`/`eventId` is propagated through publish and every subscriber; structured logs at publish, each delivery, and each outbound call.
- Retention / archival: events retained on the topic/subscriptions long enough to absorb a subscriber outage. [ASSUMPTION: a 7-day message retention window is sufficient.]

## Dependencies and External Constraints

- A publish/subscribe topic supporting multiple independent, durable subscriptions with per-subscription dead-lettering.
- The fulfillment, notification, and analytics endpoints and their authentication models.
- A canonical order event schema under version governance.

## Assumptions and Open Questions

### Assumptions

- [ASSUMPTION: the order system may re-send an acceptance signal on retry, so the publisher must deduplicate on orderId.]
- [ASSUMPTION: global ordering is not required; per-customer ordering is best-effort.]
- [ASSUMPTION: subscribers may lag by minutes during bursts without breaching SLA.]
- [ASSUMPTION: a 7-day message retention window absorbs subscriber outages.]

### Open Questions

- OQ-001: Should the fulfillment subscriber require strict per-customer ordering (sessions), or is best-effort acceptable?
- OQ-002: Which fields constitute PII requiring redaction if any event data is ever forwarded to an external or lower-trust consumer?
- OQ-003: Are there additional planned subscribers (e.g. fraud screening) that affect the event schema now?
- OQ-004: What is the required dead-letter review and replay process for each subscription?
