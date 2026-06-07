# Asynchronous Payment Authorization with Callback

## Overview

- Purpose: Accept a payment authorization request, acknowledge it immediately, submit it to an external payment gateway that responds asynchronously, then correlate the gateway's callback to the original request and notify the requester of the final outcome.
- Outcome: Callers are never blocked waiting on a slow external gateway; they get an immediate accepted-for-processing acknowledgement and a reliable final result delivered asynchronously, with each request processed exactly once.
- In scope: Synchronous intake with an immediate acknowledgement, durable persistence of the in-flight request, submission to the gateway, receipt and validation of the gateway's asynchronous callback, correlation back to the original request, and final-outcome notification to the requester.
- Out of scope: Settlement, refunds, chargebacks, the requester's own UI, and storage of full card data (the gateway tokenizes; this integration never handles raw card numbers).

## Business Context

### Problem Statement

The payment gateway authorizes asynchronously: it accepts a submission and later posts the result to a callback, sometimes seconds and sometimes minutes later. A synchronous request-response model would hold the caller open and time out. The business needs an asynchronous request/acknowledge/callback pattern that correlates the deferred result to the original request, survives restarts, and is exactly-once.

### Success Criteria

- Every accepted request receives an immediate acknowledgement with a tracking identifier.
- Every gateway callback is correlated to its original request and produces exactly one final notification.
- A duplicate request (same idempotency key) does not create a second gateway submission.
- A callback that never arrives within the timeout is detected and surfaced, not lost.

## Actors and Systems

| Name | Type | Role |
|---|---|---|
| Requesting system | external | Submits payment authorization requests; receives the final outcome |
| Payment boundary | system | Acknowledges, persists, submits, correlates, and notifies |
| Payment gateway | external partner | Authorizes asynchronously and posts a callback with the result |
| Payments operations team | human | Investigates timeouts, mismatched callbacks, and dead-letters |

## Triggers and Flow Summary

| Flow | Trigger | Source | Destination | Frequency / Volume |
|---|---|---|---|---|
| Authorization intake | Inbound authorization request | Requesting system | Payment gateway (submission) | Event-driven; ~50,000 requests/day, peaks at checkout times |
| Gateway callback | Gateway posts a result | Payment gateway | Payment boundary | One per submitted request (plus possible retries from the gateway) |
| Outcome notification | Callback correlated to a request | Payment boundary | Requesting system | One per completed request |
| Timeout sweep | No callback within the timeout | Payment boundary | Operations / requester | Per timed-out request |

## Input and Output Contracts

### Inbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| Authorization request | HTTP | JSON | application/json; UTF-8 | Synchronous; returns 202-style acknowledgement with a tracking id |
| Gateway callback | HTTP (webhook) | JSON | application/json; UTF-8 | Signed by the gateway; signature must be verified |

### Outbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| Gateway submission | HTTP | JSON | application/json; UTF-8 | Submits the authorization to the gateway |
| Outcome notification | HTTP callback or message queue | JSON | application/json; UTF-8 | Final result delivered to the requester [ASSUMPTION: the requester provides a callback URL or subscribes to a result channel] |

## Payload Definitions

### Inbound Payloads

#### Authorization Request

| Field | Type | Required | Source | Rules / Notes |
|---|---|---|---|---|
| requestId | string | yes | Requesting system | Idempotency key; unique per logical request |
| amount | number | yes | Requesting system | > 0 |
| currency | string | yes | Requesting system | ISO-4217 |
| paymentToken | string | yes | Requesting system | Gateway-issued token; never a raw card number (PII-sensitive) |
| merchantRef | string | yes | Requesting system | Caller's order/merchant reference |
| callbackUrl | string | no | Requesting system | Where to deliver the outcome, if push delivery [ASSUMPTION: present when push delivery is used] |

Example (request):

```json
{
  "requestId": "REQ-0a9f31",
  "amount": 84.0,
  "currency": "USD",
  "paymentToken": "tok_9s8d7f6g5h",
  "merchantRef": "ORD-55012",
  "callbackUrl": "https://requester.example.com/payments/outcome"
}
```

#### Gateway Callback

| Field | Type | Required | Source | Rules / Notes |
|---|---|---|---|---|
| gatewayRef | string | yes | Gateway | The gateway's reference returned at submission |
| correlationToken | string | yes | Gateway | Echoes the token submitted; used to correlate to `requestId` |
| status | string | yes | Gateway | `authorized` / `declined` / `error` |
| authCode | string | no | Gateway | Present when authorized |
| reasonCode | string | no | Gateway | Present when declined/error |
| signature | string | yes | Gateway | HMAC/signature over the callback body; must verify |

### Outbound Payloads

#### Immediate Acknowledgement

| Field | Type | Required | Destination | Rules / Notes |
|---|---|---|---|---|
| trackingId | string | yes | Requesting system | Returned synchronously; equals or maps to `requestId` |
| status | string | yes | Requesting system | Literal `accepted` |
| receivedAt | date-time | yes | Requesting system | ISO-8601 |

#### Outcome Notification

| Field | Type | Required | Destination | Rules / Notes |
|---|---|---|---|---|
| requestId | string | yes | Requesting system | Correlates to the original request |
| merchantRef | string | yes | Requesting system | Echoed from the request |
| outcome | string | yes | Requesting system | `authorized` / `declined` / `error` / `timeout` |
| authCode | string | no | Requesting system | Present when authorized |
| reasonCode | string | no | Requesting system | Present when declined/error/timeout |
| completedAt | date-time | yes | Requesting system | When the outcome was determined |

Example (outcome notification):

```json
{
  "requestId": "REQ-0a9f31",
  "merchantRef": "ORD-55012",
  "outcome": "authorized",
  "authCode": "A12345",
  "completedAt": "2026-06-06T14:22:40Z"
}
```

## Functional Requirements

- FR-001: The integration shall accept an authorization request synchronously and return an immediate acknowledgement carrying a tracking id.
- FR-002: The integration shall durably persist the in-flight request keyed by `requestId` before submitting to the gateway.
- FR-003: The integration shall submit the request to the payment gateway and store the returned `gatewayRef` against the request.
- FR-004: The integration shall accept the gateway's asynchronous callback, verify its signature, and reject unverifiable callbacks.
- FR-005: The integration shall correlate a verified callback to its original request and record the final outcome exactly once.
- FR-006: The integration shall deliver an outcome notification to the requester for every completed request.
- FR-007: The integration shall detect requests that receive no callback within the configured timeout and emit a `timeout` outcome for operator and requester attention.

## Validation and Business Rules

- Request validation: `requestId`, `amount > 0`, `currency`, `paymentToken`, and `merchantRef` are required; raw card numbers are never accepted.
- Idempotency: the business key is `requestId`. A repeat request returns the existing tracking id/outcome and must not create a second gateway submission.
- Callback authenticity: the callback `signature` must verify against the shared gateway secret; failures are rejected and dead-lettered.
- Callback idempotency: a duplicate callback for an already-finalized request is acknowledged but does not produce a second outcome notification.
- Correlation: a callback whose `correlationToken`/`gatewayRef` matches no known request is dead-lettered as unmatched.

## Error Handling

- Expected validation failures: a malformed request is rejected synchronously with a 400-style error and never persisted/submitted.
- Submission failures: a transient gateway-submission failure is retried with backoff; an exhausted retry marks the request `error` and notifies the requester.
- Callback failures: an unverifiable or unmatched callback is dead-lettered with the reason and a correlation id.
- Timeout: a request with no callback within the timeout window is swept to a `timeout` outcome; the gateway is optionally queried for status if a status endpoint exists. [ASSUMPTION: timeout window is 15 minutes; a status-query endpoint may not exist.]
- Error response contract: dead-letter entries carry the original payload, `requestId`/`gatewayRef`, the failing rule, and the correlation id.

## Non-Functional Requirements

- Performance / throughput: sustain ~50,000 requests/day with checkout-time peaks; intake acknowledgement returns in well under a second independent of gateway latency.
- Availability / SLA: the callback endpoint must be highly available so gateway callbacks are never dropped; outcome delivery is eventually consistent within the timeout window.
- Security / identity: the gateway secret used to verify callback signatures is referenced from a secret store, never inline; outbound gateway auth uses a stored credential reference or managed identity; the callback endpoint authenticates the gateway.
- Data classification / compliance: restricted. Payment data is in scope for cardholder-data regulations; this integration handles only gateway tokens and must never persist or log raw card data. `paymentToken` and `merchantRef` must not be emitted to any public channel without redaction.
- Observability: a correlation id linking the request, submission, callback, and notification is propagated and logged at each hop; no sensitive token values are logged.
- Retention / archival: in-flight and completed request records retained per payment-audit policy. [ASSUMPTION: 13-month retention for payment audit.]

## Dependencies and External Constraints

- The payment gateway's submission API, asynchronous callback contract, signing scheme, and (optionally) a status-query endpoint.
- A durable store for in-flight and completed requests, supporting idempotent upsert by `requestId`.
- A secret store holding the gateway credentials and callback-signing secret.
- The requester's outcome-delivery mechanism (callback URL or subscribed result channel).

## Assumptions and Open Questions

### Assumptions

- [ASSUMPTION: the requester provides a callback URL or subscribes to a result channel for outcome delivery.]
- [ASSUMPTION: `callbackUrl` is present when push delivery is used.]
- [ASSUMPTION: the timeout window is 15 minutes.]
- [ASSUMPTION: a gateway status-query endpoint may not exist, so timeout handling cannot always confirm a missed result.]
- [ASSUMPTION: payment-audit retention is 13 months.]

### Open Questions

- OQ-001: What is the gateway's callback signing scheme (algorithm, header layout) and key rotation process?
- OQ-002: Does the gateway expose a status-query endpoint to reconcile timed-out requests, and what are its rate limits?
- OQ-003: How does the requester want the outcome delivered — push to a callback URL, a subscribed channel, or both — and with what authentication?
- OQ-004: What is the exact final-outcome SLA the requester expects (e.g. 95% within N minutes)?
