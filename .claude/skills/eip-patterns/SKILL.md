---
name: eip-patterns
description: Reference catalogue of Hohpe Enterprise Integration Patterns, with the IR node type each maps to and guidance on when to use which.
---

# EIP Pattern Catalogue

Use this as a lookup when designing flows in `integration-ir.yaml`. Every pattern below maps to a typed IR node in `integration-ir.schema.json`.

## Message construction

| Pattern             | IR node     | When to use                                                  |
|---------------------|-------------|--------------------------------------------------------------|
| Message             | `message`   | Any payload crossing a channel boundary.                     |
| Command Message     | `message`   | Intent to change state.                                      |
| Event Message       | `message`   | Notification that state changed.                             |
| Document Message    | `message`   | Transfer of a data structure (no intent implied).            |

## Message routing

| Pattern              | IR node          | When to use                                                     |
|----------------------|------------------|-----------------------------------------------------------------|
| Content-Based Router | `router`         | Next step depends on payload fields.                            |
| Message Filter       | `filter`         | Drop messages that fail a predicate.                            |
| Recipient List       | `recipientList`  | Same message delivered to several recipients in parallel.       |
| Splitter             | `splitter`       | One message yields many (line items, batched events).           |
| Aggregator           | `aggregator`     | Merge N correlated messages into one.                           |
| Scatter-Gather       | `scatterGather`  | Fan-out query + merged reply.                                   |
| Routing Slip         | chain of `next`  | Predetermined itinerary; encoded as explicit `next` links.      |

## Message transformation

All transformation IR nodes reference an entry in `mappings[]` via `mappingRef`. The mapping holds the platform-neutral logic (JSONata by default; XSLT / Liquid / JSLT for specialised cases). Do not encode transformation logic inside `transform:` as a symbolic name — that pushes the design into the platform pack.

| Pattern               | IR node      | Mapping shape                                                | When to use                                                 |
|-----------------------|--------------|--------------------------------------------------------------|-------------------------------------------------------------|
| Message Translator    | `transform`  | `expression` or full `rules` table with source→target pairs  | Change shape without changing meaning.                      |
| Content Enricher      | `enrich`     | Mapping merges dependency response into message              | Add fields by looking them up in a dependency.              |
| Content Filter        | `transform`  | Rules with `condition` or omit/default rules to drop fields  | Remove or redact fields.                                    |
| Claim Check           | `claimCheck` | —                                                            | Payload too big for channel; store in object store and emit a reference envelope. |
| Normalizer            | `router` + `transform` per branch | One mapping per input shape, all targeting the canonical message | Multiple input shapes to one canonical. |
| Envelope Wrapper      | `transform`  | `expression` producing `{ header, body }`                    | Wrap payload in protocol envelope.                          |
| Value Translator      | `transform`  | Rules using `lookup:` against a reference table              | Swap coded values (country names → ISO codes, etc.).        |

## Messaging endpoints

| Pattern                 | IR node     | When to use                                              |
|-------------------------|-------------|----------------------------------------------------------|
| Point-to-Point Channel  | `queue`     | Exactly one consumer per message.                        |
| Publish-Subscribe       | `topic`     | Zero or more consumers per message.                      |
| Request-Reply           | `invoke`    | Synchronous call needing a response.                     |
| Idempotent Receiver     | contract    | Declare idempotency key in `messages[].schemaRef`.       |

## System management

| Pattern            | IR node            | When to use                                         |
|--------------------|--------------------|-----------------------------------------------------|
| Dead Letter Channel| `errorHandling.dlq`| Unprocessable messages after retries.               |
| Invalid Message    | `errorHandling.dlq`| Messages that fail schema validation.               |
| Wire Tap           | `wireTap`          | Non-blocking duplicate onto a diagnostic channel.    |
| Throttler          | `throttler`        | Cap throughput upstream of a rate-limited dependency.|
| Resequencer        | `resequencer`      | Reorder by `orderingKey` within a window.            |
| Process Manager    | `saga`             | Long-running flow with explicit compensating steps.  |
| Control Bus        | external           | Out of scope for the IR.                            |

## Phase 7 node details

### `claimCheck`
Store a large payload in object storage and emit a small reference envelope downstream.

```yaml
- id: checkPayload
  type: claimCheck
  store: orders-blob            # channels[] entry, kind: blob
  keyExpression: "'orders/' & order.orderId & '.json'"
  referenceMessageRef: OrderReference
  next: publishReference
```

### `wireTap`
Duplicate every message onto a diagnostic channel. The wire tap must never fail the primary flow; packs compile it so the tap publish runs after the main path with `runAfter` on `Succeeded` only.

```yaml
- id: tap
  type: wireTap
  target: orders-audit-topic
  next: route
```

### `throttler`
Cap throughput with an explicit disposition on overflow.

```yaml
- id: throttle
  type: throttler
  rps: 50
  burst: 20
  strategy: shed                # shed | queue | block
  next: invokePayments
```

### `saga`
Long-running orchestration with compensating actions. Each `children[]` entry declares a forward step and its compensation; on failure of forward step N, compensate N-1..0 run in reverse.

```yaml
- id: checkout
  type: saga
  children:
    - forward: reserveInventory
      compensate: releaseInventory
    - forward: capturePayment
      compensate: refundPayment
    - forward: createShipment
      compensate: cancelShipment
  next: done
```

### `resequencer`
Buffer out-of-order messages by `orderingKey` within a bounded `window`; forward in-order or give up and forward in arrival order.

```yaml
- id: resequence
  type: resequencer
  orderingKey: body.sequenceNumber
  window: PT30S
  next: aggregate
```

## Decision guide (fast)

- "Same message to many targets" -> `recipientList`.
- "Pick one of several targets based on fields" -> `router`.
- "Fan-out and merge responses" -> `scatterGather`.
- "Collect N then emit one" -> `aggregator` with `correlation`.
- "One to many" -> `splitter`.
- "Call a REST dependency and wait" -> `invoke`.
- "Publish without waiting" -> `send` with a `topic` channel.

## Phase 8 — endpoints, flow tests, observability

### Endpoints carry HTTP transport detail
Put `method`, `path`, `requestBody.messageRef`, `responses`, `parameters`, `idempotencyHeader`, `rateLimit`, and `cors` on `endpoints[]`. `contract-designer` projects these into OpenAPI; `ir-validator` fails if the two ever diverge.

### Flow-level tests
Use `flows[].tests[]` for happy-path and error-path coverage. Use `faults[]` to force a step to fail and assert the DLQ envelope. Use `context` to pin correlation ids, uuids, and timestamps so deep compares are stable.

### Observability declarations
Every flow declares `tracked[]`, `metrics[]`, and `logSampling` so packs have a uniform source for platform-native observability. The minimum bar is at least one `tracked[]` entry carrying the correlation id for any flow whose trigger message has `correlationId`.

## Anti-patterns (reject in review)

- A `router` with no `default` branch when business rules require total coverage.
- An `aggregator` without `correlation`.
- An `invoke` without `timeout`.
- A flow with no explicit `errorHandling` resolution.
- A `send` to a `queue` expected to fan out (use `topic`).
- A `transform` or `enrich` with no `mappingRef` (or a `mappingRef` pointing at a mapping that doesn't exist in `mappings[]`).
- A `mappings[]` entry that embeds platform-specific expression syntax (e.g. `@triggerBody()?['x']`, DataWeave `%dw 2.0`). Use portable JSONata; packs translate.
- A router `when` that is a raw string when the rest of the flow uses structured predicates — one style per flow.
- A queue/topic channel with `ordering: byKey` but no `orderingKey` — partition is undefined.
- A channel with `delivery: exactly-once` backed by an at-most-once transport (`http`, `eventgrid`).
- An inbound external message with no `idempotencyKey` — Article III Sev-1.
- A `pii: true` field routed through a `classification: public` channel without `redact` — Article V Sev-1.
- A step with `onError: fallback` but no `fallback` id, or a `fallback` pointing at a step id outside the flow.
- The same error code in both `retryableErrors` and `nonRetryableErrors` on a single step.
- A `claimCheck` whose `store` channel is not `kind: blob` — the referenced envelope must point at object storage.
- A `wireTap` with an inbound `target` — wire taps publish, never receive.
- A `saga` pair where `forward` equals `compensate`, or the same `forward` appears in more than one pair.
- A `throttler` with `strategy: queue` but no `burst` — buffer size is undefined.
- A topic `subscription` with a SQL filter on a broker that only supports correlation filters (packs must demote to `correlation` or emit a Sev-2 "feature not supported by pack" finding).
- An `endpoint` whose `method`/`path` disagree with the bound channel's `binding.method`/`binding.path`, or with the generated OpenAPI document.
- An `endpoint` declaring `idempotencyHeader` when the bound inbound channel's message does not declare `idempotencyKey`.
- A flow whose trigger message declares `correlationId` but the flow's `tracked[]` entries do not reference it (Article IV).
- A `flows[].tests[]` fixture path that doesn't exist, or a `trigger.channel` that doesn't match the flow's own trigger.
