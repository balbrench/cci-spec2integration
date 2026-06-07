# IR Authoring Guide

Practical guide for reading, writing, and validating `integration-ir.yaml`. For the formal specification, see [ir-spec.md](ir-spec.md).

---

## Overview

The Integration IR is the central artifact of the pipeline. It is:
- **Vendor-neutral** — no platform-specific syntax
- **EIP-aligned** — based on Hohpe Enterprise Integration Patterns
- **Machine-readable** — validated against `schemas/integration-ir.schema.json`
- **The single source of truth** for platform packs (they consume only the IR and `contracts/`, never the PRD, spec, or data model)

---

## File Structure

```yaml
apiVersion: spec2integration/v1
kind: Integration
metadata:
  name: order-intake              # kebab-case, unique in the repo
  domain: order-management
  owner: orders-team
channels: []          # transport-level endpoints
messages: []          # named typed payloads
mappings: []          # source→target transformations
endpoints: []         # synchronous HTTP surfaces
flows: []             # orchestrations as EIP node DAGs
errorHandling: {}     # global defaults
identity: {}          # managed identity references
nonFunctionals: {}    # SLOs, throughput targets
dependencies: []      # external systems
```

---

## Migration vs greenfield

The IR serves two scenarios. Pick the right one **before** you author any other section.

### Three-question flowchart

1. **Does this integration already exist on another platform** (BizTalk, MuleSoft, TIBCO, Boomi, SSIS, Informatica)?
   - **No** → `metadata.scenario: greenfield`. Stop here.
   - **Yes** → continue.
2. **Are you migrating its logic, or just modelling its contract?**
   - Modelling only → greenfield is fine; treat the existing system as a `dependency`.
   - Migrating → `metadata.scenario: migration` and `metadata.sourcePlatform: <platform>`.
3. **For each map / transform: does the original artifact (XSL, DWL, Groovy, etc.) still exist on disk?**
   - Yes → set `mappings[].origin: preserved`, fill `sourceArtifact.<kind>`, set `migrationHint: preserve`. Pack ships it byte-for-byte where it can (`transforms.<pack>: passthrough`) or runs the declared adapter.
   - No (logic only lives in compiled form or in the developer's head) → set `origin: authored` and write `rules` / `expression` from scratch; pick the appropriate `migrationHint` (`auto`, `local-function`, `azure-function`, `manual`).

### Greenfield rules

- MUST set `metadata.scenario: greenfield`.
- MUST NOT set `source:`.
- MUST NOT set `messages[].nativeSchemaSource` with `origin: preserved`.
- MUST NOT set `mappings[].origin: preserved` or `mappings[].migrationHint: preserve`.
- All schemas live under `contracts/`; all mapping logic is `rules` or `expression`.

### Migration rules

- MUST set `metadata.scenario: migration` AND `metadata.sourcePlatform: <platform>` (not `greenfield`).
- MUST set `source:` with at minimum `platform` and `artifactsRoot`.
- For every message backed by an XSD/Avro/Protobuf/flat-file schema from the source platform: set `nativeSchemaSource: { origin: preserved, path: <rel> }`.
- For every preserved mapping: set `origin: preserved`, at least one `sourceArtifact.<kind>`, `engine` matching the artifact (e.g. `xslt` for `.xsl`/`.xslt`), `migrationHint: preserve`, and a `transforms` map covering each target pack you intend to deploy to.
- Authored mappings inside a migration IR are allowed (e.g. greenfield enrichment glue) \u2014 mark them `origin: authored`.

### Worked example: BizTalk OnboardingRequest \u2192 CustomerRegistration

A BizTalk solution ships a `.btm` map and its compiled `.xslt`. Reverse engineering produces:

```yaml
metadata:
  name: customer-onboarding
  domain: customer
  owner: integration-team
  scenario: migration
  sourcePlatform: biztalk

source:
  platform: biztalk
  artifactsRoot: ./Artifacts
  preservedRoot: C:/Projects/LogicApp1/App1/OnboardCustomer
  inventoryRef: ../biztalk-inventory.md

messages:
  - name: OnboardingRequest
    schemaRef: contracts/schemas/OnboardingRequest.json
    nativeSchemaSource:
      origin: preserved
      path: Schemas/OnboardingRequest.xsd
    schemaLanguage: xsd
    format: xml
    contentType: application/xml
    idempotencyKey: body.Email

mappings:
  - name: OnboardingRequestToCustomerRegistration
    source: { messageRef: OnboardingRequest }
    target: { messageRef: CustomerRegistration }
    origin: preserved
    migrationHint: preserve
    engine: xslt
    sourceArtifact:
      btm:  Maps/OnboardingRequestToCustomerRegistrationMap.btm
      xslt: Maps/OnboardingRequestToCustomerRegistrationMap.xslt
    transforms:
      logic_apps_standard: passthrough
      mulesoft:            xslt_to_dataweave
      azure_functions:     xslt_to_local_function
    parameters:
      - name: registrationDateTime
        binding: "@{utcNow()}"
```

The Logic Apps Standard pack ships the `.xslt` byte-for-byte into the workflow's artifacts folder; the MuleSoft pack runs the `xslt_to_dataweave` adapter; the Azure Functions pack wraps the XSLT in a local function. None of them re-derives the mapping from the IR's (absent) `rules` block \u2014 that's Article II.a.

---

## Naming Conventions

| Element | Case | Example |
|---------|------|---------|
| `metadata.name` | kebab-case | `order-intake` |
| Channel names | kebab-case, suffix with `-<kind>` | `orders-topic`, `orders-dlq-queue` |
| Message names | PascalCase, match schema filename | `Order`, `OrderCreated` |
| Mapping names | PascalCase, `<Source>To<Target>` | `RawOrderToCanonical` |
| Lookup names | PascalCase, direction | `CountryNameToIso3166Alpha2` |
| Flow names | PascalCase, suffix `Flow` | `OrderIntakeFlow` |
| Step ids | camelCase | `validateOrder`, `routeByRegion` |

---

## Channels

Channels declare transport-level endpoints. Every channel referenced by a flow step must exist in `channels[]`.

```yaml
channels:
  - name: orders-http
    kind: http          # http | queue | topic | blob | timer | eventgrid
    direction: inbound  # inbound | outbound
    auth: managedIdentity
    schemaRef: Order    # references messages[].name
```

### Key fields

| Field | Default | Notes |
|-------|---------|-------|
| `delivery` | `at-least-once` | `at-most-once`, `at-least-once`, `exactly-once` |
| `ordering` | `none` | `none`, `fifo`, `byKey` (requires `orderingKey`) |
| `ack` | `peekLock` | `auto`, `peekLock`, `manual` |
| `classification` | — | `public`, `internal`, `confidential`, `restricted` |
| `retention` | — | ISO-8601 duration for Article V compliance |
| `ttl` | — | Per-message expiration |

### Channel bindings

The `binding` object carries broker-specific metadata. Shape depends on `kind`:

```yaml
# HTTP
binding:
  method: POST
  path: /orders
  rateLimit: { rps: 1000, burst: 200 }

# Topic (Service Bus style)
binding:
  sessionRequired: true
  partitionCount: 4
  duplicateDetection: true

# Timer
binding: { cron: "0 2 * * *" }

# Blob
binding:
  pathPattern: orders/{yyyy}/{MM}/{dd}/
  triggerEvent: blobCreated
```

---

## Messages

Messages declare named, typed payloads with metadata for parsing, deduplication, tracing, and data-handling policy.

```yaml
messages:
  - name: Order
    schemaRef: contracts/schemas/Order.json
    contentType: application/json
    format: json              # json | xml | csv | edi-x12 | avro | protobuf | ...
    encoding: utf-8
    idempotencyKey: orderId   # MANDATORY on external inbound messages (Article III)
    correlationId: X-Correlation-Id
    classification: confidential
    pii: true
    headers:
      - name: correlationId
        type: uuid
        required: true
        source: generated     # literal | body | requestHeader | context | generated
```

### Rules to remember

- `idempotencyKey` is mandatory on any message consumed from an external inbound channel (Article III). Missing = Sev-1.
- `correlationId` can be a body path (`body.correlationId`) or header name (`X-Correlation-Id`).
- Set `classification` and `pii` at message level; override per-field only when fields differ.
- `format` drives the default mapping engine: `json` → JSONata, `xml` → XSLT.

---

## Mappings

The `mappings` block carries **all** transformation logic. Two mutually exclusive styles:

### Style 1: Rules (preferred for 1:1 mappings)

```yaml
mappings:
  - name: RawOrderToCanonical
    source: { messageRef: Order }
    target: { messageRef: CanonicalOrder }
    engine: jsonata
    rules:
      - target: sourceOrderId
        source: orderId
      - target: orderTotal
        expression: "$sum(items.(quantity * unitPrice))"
      - target: shippingAddress.countryCode
        source: deliveryAddress.country
        lookup: CountryNameToIso3166Alpha2
        default: "ZZ"
    lookups:
      - name: CountryNameToIso3166Alpha2
        entries:
          "United Kingdom": GB
          "United States": US
    tests:
      - name: happy-path
        input:  { path: contracts/examples/order-uk.json }
        expect: { path: contracts/examples/canonical-order-uk.json }
```

### Style 2: Expression (preferred for restructuring)

```yaml
mappings:
  - name: OrderToCapturePayment
    source: { messageRef: Order }
    target: { messageRef: CapturePayment }
    engine: jsonata
    expression: |
      {
        "orderId":    orderId,
        "amount":     totalAmount,
        "currency":   currency,
        "customerId": customerId
      }
```

### Engine selection

| Format | Engine | When |
|--------|--------|------|
| JSON ↔ JSON | `jsonata` (default) | Most cases |
| XML ↔ XML | `xslt` | Native XML transforms |
| Template output | `liquid` | Template-style rendering |
| JSON (alt) | `jslt` | If team standardized on it |

Never mix engines within one mapping. Never use platform-specific syntax (Logic Apps `@...`, DataWeave `%dw`).

### Rule fields

| Field | Purpose |
|-------|---------|
| `target` | Path on target document (required) |
| `source` | Path on source document (copy-through) |
| `expression` | Engine expression computing the value |
| `default` | Literal fallback for null inputs |
| `condition` | Predicate gating rule application |
| `lookup` | Reference to a `lookups[]` entry |
| `pii` / `redact` | Data handling per-field |
| `notes` | Human-readable rationale (surfaces in STM) |

### Tests are required

Every mapping needs at least one test with golden-file fixtures. Fixtures under `contracts/examples/` double as documentation.

---

## Flows

A flow is a DAG of typed steps. Each step has a stable `id`, a `type`, and either `next` or `routes`.

### EIP node types

| Type | Purpose |
|------|---------|
| `receive` | Entry point bound to a channel |
| `transform` | Message transformation via `mappingRef` |
| `enrich` | Look up data from a dependency |
| `filter` | Drop messages not matching a predicate |
| `router` | Content-based routing with `routes[]` |
| `recipientList` | Fan-out to N steps in parallel |
| `splitter` | Break one message into many |
| `aggregator` | Collect N messages by correlation key |
| `scatterGather` | Fan-out + aggregate |
| `send` | Publish to an outbound channel |
| `invoke` | Synchronous call to a dependency |
| `claimCheck` | Store large payload in blob, emit reference |
| `wireTap` | Non-blocking copy to diagnostic channel |
| `throttler` | Cap throughput |
| `saga` | Long-running orchestration with compensation |
| `resequencer` | Reorder messages by key within a window |

### Example flow

```yaml
flows:
  - name: OrderIntakeFlow
    trigger: orders-http
    steps:
      - id: receive
        type: receive
        channel: orders-http
        next: validate
      - id: validate
        type: transform
        mappingRef: RawOrderToCanonical
        next: route
      - id: route
        type: router
        routes:
          - when: { engine: jsonata, expression: "region = 'EU'" }
            next: publishEu
          - when: { engine: jsonata, expression: "region = 'US'" }
            next: publishUs
          - default: true
            next: rejectRegion
      - id: publishEu
        type: send
        channel: orders-eu-topic
      - id: publishUs
        type: send
        channel: orders-us-topic
```

### Flow rules

- One trigger per flow
- One flow per business process (don't bundle)
- Steps form a DAG — cycles are invalid
- Every branch must reach a `send` or a terminal step with no `next`
- Prefer structured router predicates: `when: { engine: jsonata, expression: "..." }`

### Choosing the target compute host (Azure pack)

Each flow may declare an `implementation` block that routes it to the right Azure compiler. When the field is omitted, the Azure pack defaults to `logic-app-standard`.

```yaml
flows:
  - name: BulkCustomerLoad
    implementation:
      host: data-factory
      rationale: "Nightly batch CSV copy from SFTP to ADLS Gen2, 2M rows."
    ...
```

| `implementation.host` | Use when | Azure compiler | Output |
|---|---|---|---|
| `logic-app-standard` (default) | Event-driven workflows, HTTP request/response, sub-second orchestration | `azure-logic-apps-compiler` | `app/<Flow>/workflow.json` |
| `function-app` | Code-first orchestration, Durable Functions patterns (fan-out, monitor, aggregator), CPU-heavy transforms | `azure-functions-compiler` | `FunctionApps/<Flow>/` |
| `data-factory` | Bulk data movement, schema-drift transformations, scheduled batch loads | `azure-data-factory-compiler` | `adf/pipelines/<Flow>.json` |

The `target-architecture` agent sets this block automatically based on the IR shape; you only need to author it by hand when the engagement skips the architecture-document stage. `ir-validator` rejects `data-factory` for HTTP-triggered or sync-reply flows.

---

## Error Handling

```yaml
errorHandling:
  retry:
    policy: exponential   # fixed | exponential
    count: 4
    interval: PT5S
  dlq:
    channel: orders-dlq   # must exist in channels[]
```

Top-level sets defaults. Override per-flow or per-step when justified.

Per-step error handling adds:
- `retryableErrors` / `nonRetryableErrors` — error code lists
- `onError` — `continue`, `dlq`, `fallback`, `fail`
- `fallback` — step id in the same flow

> **Constitution:** Every external hop must have explicit retry + DLQ (Article VI). Missing = Sev-1.

---

## Identity

```yaml
identity:
  managedIdentity: system       # system | userAssigned
  principalRef: mi-orders       # required if userAssigned
  roleAssignments:
    - scope: serviceBusNamespace
      role: Azure Service Bus Data Sender
```

> **Constitution:** No shared secrets in generated files. No inline API keys for services that support OAuth/MI (Article V).

---

## Dependencies

External systems the integration calls:

```yaml
dependencies:
  - name: PaymentsApi
    kind: rest
    contractRef: contracts/openapi-payments.yaml
    timeout: PT3S
    retry: { policy: exponential, count: 3, interval: PT1S }
    circuitBreaker: { failureRatio: 0.5, windowSeconds: 60 }
```

### Protocol-specific fields

| Kind | Extra fields |
|------|-------------|
| `rest` | `idempotencyHeader`, `rateLimit`, `circuitBreaker` |
| `grpc` | `streaming` (`none`, `clientStream`, `serverStream`, `bidi`) |
| `db` | `driver`, `txBoundary` (`perCall`, `perFlow`) |
| `function` | `codeRef`, `runtime`, `migrationHint` |

---

## Observability (Article IV)

Every flow whose trigger carries `correlationId` must declare `tracked[]`:

```yaml
flows:
  - name: OrderIntakeFlow
    tracked:
      - { name: correlationId, source: $context.correlationId }
      - { name: orderId, source: body.order.orderId }
    metrics:
      - { name: orders_received_total, type: counter, source: '1' }
```

---

## Validation

### Schema validation

```bash
npx -y ajv-cli validate \
  -s schemas/integration-ir.schema.json \
  -d integration-ir.yaml
```

### Cross-reference checks (ir-validator)

The `ir-validator` agent checks:
- Every step `next` resolves to a step in the same flow
- Every `mappingRef` matches a `mappings[].name`
- Every `schemaRef` file exists
- Every trigger channel exists
- Names are unique within their scope
- Every `fallback` resolves to a step in the same flow
- `delivery: exactly-once` not used on `http`/`eventgrid`
- `ordering: byKey` has `orderingKey`

---

## Authoring Checklist

Before handing off to `/plan`:

- [ ] Every channel referenced by a step exists in `channels[]`
- [ ] Every message has a schema under `contracts/schemas/` and a `format`
- [ ] Every `transform` step has a `mappingRef`
- [ ] Every `mappings[]` entry has tests and either `expression` or `rules`
- [ ] Every `invoke` has a matching `dependencies[]` entry
- [ ] Every router covers all cases or has `default: true`
- [ ] Every external hop has `errorHandling.retry` and `errorHandling.dlq`
- [ ] Every external inbound message has `idempotencyKey` (Article III)
- [ ] PII fields routed through public channels declare `redact` (Article V)
- [ ] `identity` has no inline secrets (Article V)
- [ ] `nonFunctionals` reflects NFRs from `spec.md`
- [ ] File passes schema validation
- [ ] STM documents (`mappings/<Name>.md`) are regenerated and committed

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Leaving `transform: <Name>` instead of `mappingRef` | Use `mappingRef: <MappingName>` |
| Platform-specific syntax in mappings | Use JSONata/XSLT/Liquid only |
| Missing `idempotencyKey` on inbound messages | Add body path or header name |
| No tests on a mapping | Add at least one golden-file test |
| Inline secrets in `identity` | Use secret-store references |
| Missing `errorHandling` on `invoke` steps | Add retry + DLQ |
| `ordering: byKey` without `orderingKey` | Add `orderingKey` |
| Cycles in flow DAG | Refactor to eliminate back-edges |
