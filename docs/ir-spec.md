# IR Specification

Spec2Integration uses two IR artifact kinds, forming a two-level hierarchy:

```
kind: Domain          → specs/<domain>/domain.yaml
  └── kind: Integration  → specs/<domain>/NNN-<slug>/integration-ir.yaml
        └── flow
              └── step
```

Validated by:
- `schemas/domain-ir.schema.json`
- `schemas/integration-ir.schema.json`

---

## kind: Domain

A Domain groups one or more Integration artifacts that belong to the same business domain (e.g. Order Management, Customer, Inventory). It owns the canonical domain events — messages that cross integration boundaries — and sets policy defaults that all member integrations inherit.

```yaml
apiVersion: spec2integration/v1
kind: Domain
metadata:
  name: order-management          # kebab-case; must match metadata.domain in every registered Integration
  description: Manages the full order lifecycle from intake to fulfilment.
  owner: orders-team
  classification: internal        # public | internal | confidential | restricted

integrations:
  - path: 001-order-intake/integration-ir.yaml
    layer: experience             # experience | process | system  (default: process)
  - path: 002-order-orchestration/integration-ir.yaml
    layer: process
  - path: 003-sap-order-adapter/integration-ir.yaml
    layer: system

events:
  - name: OrderCreated            # PascalCase; canonical cross-integration message
    schemaRef: contracts/schemas/OrderCreated.json
    version: 1.0.0
    compatibility: backward       # backward | forward | full | none
    classification: internal
    pii: false
    producers: [order-intake]     # metadata.name of producing integration
    consumers: [order-orchestration, inventory-reservation]

  - name: OrderFulfilled
    schemaRef: contracts/schemas/OrderFulfilled.json
    version: 1.0.0
    compatibility: backward
    producers: [order-orchestration]
    consumers: [notification-service]

policy:
  auth: oauth2                    # default auth for all channels in this domain
  errorHandling:
    retry: { policy: exponential, count: 4, interval: PT5S }
    dlq: { channel: domain-dlq }
  dataClassification: internal
  pii: false                      # when true, all messages assumed PII unless declared otherwise

nonFunctionals:
  rps: 500
  p95LatencyMs: 2000
  slo: { availability: 99.9, errorBudgetDays: 30 }
```

### Policy inheritance

Domain `policy` sets defaults that integrations inherit. Integrations may override with **stricter** values only — they may never loosen a domain policy. The precedence chain is:

```
step-level > flow-level > integration-level > domain-level
```

### Canonical domain events

An event in `domain.events[]` is the **authoritative schema** for that message. Every integration that produces or consumes the event must reference the same `schemaRef`. The `ir-validator` cross-checks this when `domain.yaml` is present.

### Layer assignment

`integrations[].layer` declares the architectural tier of the whole integration. When a single deployed integration spans tiers (e.g. a Logic Apps app with both experience and process flows), set `layer` on individual flows via `flows[].layer` and record the primary tier in the Domain.

| Layer | Meaning |
|---|---|
| `experience` | Consumer-facing APIs — API Management, external auth, versioned contracts |
| `process` | Business orchestration — correlation, saga, cross-system error handling |
| `system` | Backend adapters — connection pooling, circuit breaker, low-level retry |

---

## kind: Integration

The Integration IR (`integration-ir.yaml`) is the vendor-neutral, EIP-aligned description of one deployable integration unit. It is the contract between core agents and platform packs.

Validated by `schemas/integration-ir.schema.json`.

## Top-level shape

```yaml
apiVersion: spec2integration/v1
kind: Integration
metadata:
  name: string                 # kebab-case, unique within the repo
  domain: string               # business domain
  owner: string                # team or individual
  scenario: greenfield         # required: greenfield | migration
  sourcePlatform: greenfield   # greenfield | biztalk | mulesoft | tibco | boomi | informatica | ssis  (required when scenario: migration; must not be 'greenfield')
source: {}                     # required when scenario: migration. See "Migration mode" below.
channels: []                   # transport-level endpoints (http/queue/topic/blob/timer)
messages: []                   # named message types, each references a schema (JSON/XML/EDI/Avro/...)
mappings: []                   # platform-neutral source->target transformations (default engine: JSONata)
endpoints: []                  # synchronous surfaces (request/reply)
flows: []                      # orchestrations composed of EIP nodes
errorHandling: {}              # defaults; flows may override
identity: {}                   # managed identity references and scopes
nonFunctionals: {}             # rps, p95LatencyMs, SLOs
dependencies: []               # external systems this integration depends on
```

## Migration mode

Every IR MUST set `metadata.scenario` explicitly. Set `metadata.scenario: migration` (and `metadata.sourcePlatform`) when the IR is reverse-engineered from an existing integration platform (BizTalk, MuleSoft, TIBCO, etc.). Set `metadata.scenario: greenfield` for net-new integrations.

When `scenario: migration`, the top-level `source` block is **required**:

```yaml
metadata:
  scenario: migration
  sourcePlatform: biztalk

source:
  platform: biztalk            # required \u2014 must match metadata.sourcePlatform
  artifactsRoot: ./Artifacts   # required \u2014 root for preserved artifact paths (relative to IR folder)
  preservedRoot: C:/Projects/MyBizTalkSolution   # optional \u2014 absolute path to original solution
  inventoryRef: ../biztalk-inventory.md          # optional pointer to the inventory doc
  manifestRef:  ../_extracted/_manifest.json     # optional pointer to extraction manifest
```

**Path resolution order** for `nativeSchemaSource.path`, `sourceArtifact.*`, and `codeRef.path`:

1. `source.preservedRoot` (if set)
2. `source.artifactsRoot`
3. The IR folder itself

This lets the IR reference assets that physically live outside the repo (a checked-out BizTalk solution on disk) without copying them in, while the platform pack still resolves them deterministically.

**Article II.a (Asset Preservation).** When `scenario: migration`, the compiler MUST preserve original platform artifacts (schemas, maps) byte-for-byte from `source.artifactsRoot`. Per-target adaptation occurs only via declared `transforms` adapters; in-IR `rules` for a preserved mapping are documentation only and MUST NOT be re-emitted. Article II (IR-first) continues to govern artifacts where `origin: authored`.

## Channels

```yaml
channels:
  - name: orders-http
    kind: http                 # http | queue | topic | blob | timer | eventgrid
    direction: inbound         # inbound | outbound
    auth: managedIdentity      # managedIdentity | apiKey | none  — OR an OAuth2 object (see below)
    schemaRef: Order           # messages[].name

  - name: orders-topic
    kind: topic
    direction: outbound
    schemaRef: OrderCreated
    delivery: at-least-once    # at-most-once | at-least-once | exactly-once   (default at-least-once)
    ordering: byKey            # none | fifo | byKey                           (default none)
    orderingKey: body.orderId  # required when ordering: byKey; body path OR header name
    sessionKey: orderId        # optional alias for session-aware brokers (Service Bus, JMS)
    ack: peekLock              # auto | peekLock | manual                     (default peekLock on queue/topic)
    concurrency:               # inbound consumers only
      prefetch: 32
      maxConcurrent: 8
    maxDeliveryCount: 5        # broker-level redelivery limit before DLQ
    ttl: P7D                   # ISO-8601 duration — message TTL default
    retention: P30D            # ISO-8601 duration — Article V retention hook
    classification: internal   # public | internal | confidential | restricted
```

### Messaging semantics

Platform packs translate these fields to the closest native primitive:

| Field              | Azure Service Bus                | MuleSoft JMS / Kafka                | SAP CPI                       |
|--------------------|----------------------------------|-------------------------------------|-------------------------------|
| `delivery`         | sessions + duplicate detection   | `acks=all` / transaction            | "Exactly Once" channel flag   |
| `ordering: fifo`   | partitioned entity with 1 part.  | single-consumer queue               | "Process sequentially"        |
| `ordering: byKey`  | `SessionId` (maps to `sessionKey`)| Kafka partition key                | `MessageId` pattern           |
| `ack: peekLock`    | PeekLock receive mode            | JMS CLIENT_ACKNOWLEDGE              | "Exactly Once" + settle       |
| `maxDeliveryCount` | queue property                   | DLQ policy attempts                 | Retry config + DLQ            |
| `ttl` / `retention`| queue TTL / entity retention     | JMS TTL / topic retention policy    | Message Store expiration      |

`ir-validator` rejects `delivery: exactly-once` on `http` / `eventgrid` channels (they can't provide it), and rejects `ordering: byKey` without `orderingKey`.

### Channel bindings (Phase 7)

`channel.binding` carries broker-native metadata that used to live inside pack templates. The object's shape depends on `kind`; see the "Channel bindings cookbook" in `ir-authoring` for every kind's schema. Packs must honour supported fields or emit a Sev-2 "feature not supported by pack" finding — silent drops are rejected.

```yaml
- name: orders-http
  kind: http
  direction: inbound
  binding:
    method: POST
    path: /orders
    rateLimit: { rps: 1000, burst: 200 }
    cors: { origins: ['https://portal.example.com'], methods: [POST] }
```

### Subscriptions with filters (Phase 7)

`subscription` may be a plain string (name only) or an object carrying a broker-native filter:

```yaml
- name: orders-eu
  kind: topic
  direction: inbound
  subscription:
    name: orders-eu
    filter: { kind: sql, expression: "region = 'EU'" }  # sql | correlation | header
```

### Selective and competing consumers (Phase 7)

`channel.consumer` on inbound queue/topic channels sizes the consumer pool and applies an additional client-side selector:

```yaml
consumer:
  count: 4
  selector: "priority = 'high'"
```

`count` maps to Logic Apps `splitOn` + `concurrency`, SQS visibility + parallelism, or Kafka consumer-group replicas. Prefer `subscription.filter` over `consumer.selector` when the broker can evaluate server-side.

### OAuth2 auth

When a channel is protected by OAuth2, replace the `auth` string with an object:

```yaml
channels:
  - name: payment-api
    kind: http
    direction: outbound
    auth:
      type: oauth2
      issuer: https://login.microsoftonline.com/<tenant>/v2.0
      audience: api://payment-service
      scopes:
        - payment.capture
        - payment.refund
      clientCredentials:          # optional — only when client-credentials flow is used
        clientIdRef: PAYMENT_CLIENT_ID          # parameter / env-var name; never a literal
        clientSecretRef: https://myvault.vault.azure.net/secrets/payment-client-secret
```

`issuer` and `audience` are informational for platform packs — they surface in the OpenAPI `securitySchemes` as `x-tokenIssuer` / `x-tokenAudience`. `scopes` drives what the pack requests when acquiring a token. `clientSecretRef` must always be a secret-store reference (Key Vault URI, AWS Secrets Manager ARN, etc.); a literal secret value here is a Sev-1 constitution violation (Article V).

## Messages

A message declares a named, typed payload. `format`, `encoding`, `schemaLanguage`, `headers`, `examples`, and the messaging-semantics fields (`idempotencyKey`, `correlationId`, `version`, `classification`, `pii`) give packs everything they need to parse, validate, deduplicate, trace, and enforce data-handling policy.

```yaml
messages:
  - name: Order
    schemaRef: contracts/schemas/Order.json
    contentType: application/json
    format: json                 # json | xml | csv | edi-x12 | edifact | avro | protobuf | flat-file | text | binary
    encoding: utf-8              # utf-8 (default) | utf-16 | iso-8859-1 | us-ascii | base64 | binary
    schemaLanguage: json-schema  # json-schema (default) | xsd | avro-schema | protobuf-schema | flat-file-schema | none
    nativeSchemaSource:          # NEW — replaces nativeSchemaRef. Required for messages backed by a preserved or generated native schema.
      origin: preserved          # preserved | generated
      path:   contracts/xsd/Order.xsd   # resolved against source.preservedRoot, then source.artifactsRoot, then the IR folder
    # nativeSchemaRef: contracts/xsd/Order.xsd   # DEPRECATED — alias of nativeSchemaSource.path with implicit origin: preserved
    headers:
      - name: correlationId
        type: uuid
        required: true
        source: generated         # literal | body | requestHeader | context | generated
      - name: subject
        type: string
        source: literal
        value: order.created.v1
    examples:
      - name: happy-path-uk
        path: contracts/examples/order-uk.json
    idempotencyKey: orderId      # body path OR header name
    dedupWindow: PT24H           # ISO-8601 — how long consumers must remember the key
    correlationId: X-Correlation-Id
    version: 1.0.0
    compatibility: backward      # backward | forward | full | none
    classification: confidential # per-message default; rules may override per field
    pii: true                    # message-level flag; rules may narrow it
```

`format` drives which default mapping engine applies (JSONata for JSON, XSLT for XML, etc.). Packs must reject a mapping whose engine is incompatible with the end formats.

### Idempotency and correlation

- `idempotencyKey` is **mandatory** on any message consumed from an external inbound channel (Article III). `ir-validator` emits Sev-1 if missing; `reviewer` cites Article III explicitly.
- `correlationId` is a body path or header name; when set, packs guarantee that the same value flows through every outbound message and every log / trace span derived from this one.
- `version` + `compatibility` let packs decide whether a new deployment is safe to roll out alongside the old one. `backward` (default in most registries) means readers built for the old schema can still read new payloads.

### Classification and PII

Use `classification` and `pii` at the message level to set the default for the whole payload. Use per-field overrides on `mappings[].rules[].classification` / `rules[].pii` when only a subset of the message is sensitive. The `pii-flow-checker` agent walks the graph to make sure a `pii: true` field never reaches a `classification: public` channel without `redact`.

## Mappings

The `mappings` block is the platform-neutral, executable description of every source→target transformation in the integration. Each entry is named and is referenced from a flow step via `mappingRef`. Packs compile each mapping into their native equivalent (Logic Apps `Compose` expressions, MuleSoft DataWeave, SAP CPI Message Mapping, Boomi Map shape, etc.).

**Default engine: JSONata.** Chosen because it is JSON-native, vendor-neutral (originally specified by IBM), and already runs inside multiple integration platforms (Node-RED, Stedi, IBM App Connect, AWS Step Functions). The `engine` field stays pluggable (`jsonata` | `jslt` | `xslt` | `liquid` | `expression`) so XML-to-XML (XSLT), non-JSON templating (Liquid), and platform-native fallbacks stay available.

A mapping expresses logic in exactly one of two mutually exclusive styles:

- `expression` — a single whole-document transformation (concise; ideal for non-trivial restructuring).
- `rules` — a per-field table (readable; ideal for wide, mostly-one-to-one mappings; drives the auto-generated STM document).

```yaml
mappings:
  - name: RawOrderToCanonical
    description: Validate, enrich, and canonicalise an inbound order.
    source: { messageRef: Order }
    target: { messageRef: CanonicalOrder }
    engine: jsonata              # default; can be jslt | xslt | liquid | expression
    rules:
      - target: canonicalOrderId
        expression: "$uuid()"
        notes: Generated by the integration.
      - target: sourceOrderId
        source: orderId
      - target: customerId
        source: customerId
      - target: lineItems
        expression: |
          items.{
            "sku":        sku,
            "quantity":   quantity,
            "unitPrice":  unitPrice,
            "lineTotal":  quantity * unitPrice
          }
      - target: orderTotal
        expression: "$sum(items.(quantity * unitPrice))"
      - target: shippingAddress.countryCode
        source: deliveryAddress.country
        lookup: CountryNameToIso3166Alpha2
        default: "ZZ"
      - target: currency
        source: currency
      - target: receivedAt
        expression: "$now()"
    lookups:
      - name: CountryNameToIso3166Alpha2
        keyType: string
        valueType: string
        entries:
          "United Kingdom": GB
          "United States":  US
    tests:
      - name: happy-path-uk
        input:  { path: contracts/examples/order-uk.json }
        expect: { path: contracts/examples/canonical-order-uk.json }
```

Or the equivalent `expression` form:

```yaml
mappings:
  - name: OrderToCapturePayment
    source: { messageRef: Order }
    target: { messageRef: CapturePayment }
    engine: jsonata
    expression: |
      {
        "orderId":       orderId,
        "amount":        totalAmount,
        "currency":      currency,
        "customerId":    customerId,
        "correlationId": $context.correlationId
      }
```

### Mapping-level migration fields

When the IR is reverse-engineered from a source platform (`metadata.scenario: migration`), a mapping declares whether its logic is **preserved verbatim** from the original platform artifact or **authored** from rules. Greenfield IRs may omit these fields entirely (defaults apply).

| Field             | Purpose                                                                                                |
|-------------------|--------------------------------------------------------------------------------------------------------|
| `origin`          | `preserved` (logic comes from `sourceArtifact`) or `authored` (logic comes from `rules`/`expression`). |
| `sourceArtifact`  | Object naming the original artifact. Keys: `btm`, `xslt`, `dwl`, `groovy`, `jslt`, `liquid`, `csharp`. At least one required when `origin: preserved`. Values are paths or `file://` URIs. |
| `transforms`      | Per-target adapter map. Keys are platform pack identifiers (e.g. `logic_apps_standard`, `mulesoft`, `azure_functions`). Values: `passthrough` (ship the artifact unchanged), `xslt_to_dataweave`, `xslt_to_local_function`, `xslt_to_azure_function`, `regenerate`. |
| `parameters`      | List of parameters the preserved artifact expects at runtime, each `{ name, binding, type, description }`. `binding` is a workflow expression (e.g. `"@{utcNow()}"`). |
| `migrationHint`   | `preserve` (mandatory when `origin: preserved`), `auto`, `local-function`, `azure-function`, `manual`. |

When `origin: preserved`, in-IR `rules` and `expression` are **documentation only** and platform packs MUST NOT re-emit them as transformation logic (Article II.a). Packs translate by either shipping `sourceArtifact` byte-for-byte (`transforms[<pack>] = passthrough`) or running the declared adapter.

```yaml
mappings:
  - name: OnboardingRequestToCustomerRegistration
    source: { messageRef: OnboardingRequest }
    target: { messageRef: CustomerRegistration }
    origin: preserved
    migrationHint: preserve
    engine: xslt
    sourceArtifact:
      btm:  Maps/OnboardingRequestToCustomerRegistrationMap.btm
      xslt: file:///C:/Projects/LogicApp1/App1/OnboardCustomer/Artifacts/Maps/OnboardingRequestToCustomerRegistrationMap.xslt
    transforms:
      logic_apps_standard: passthrough
      mulesoft:            xslt_to_dataweave
      azure_functions:     xslt_to_local_function
    parameters:
      - name: registrationDateTime
        binding: "@{utcNow()}"
```

### Rule fields

| Field            | Purpose                                                                         |
|------------------|---------------------------------------------------------------------------------|
| `target`         | Path on the target document (dotted for JSON, XPath for XML). Required.         |
| `source`         | Path on the source document. Used alone for copy-through fields.                |
| `expression`     | Engine expression computing the target value. Wins over source+lookup.          |
| `default`        | Literal fallback when source is missing / expression is null.                   |
| `condition`      | Engine predicate gating whether the rule applies.                               |
| `lookup`         | Name of a `mappings[].lookups[]` entry; applied to the source value.            |
| `notes`          | Human-readable rationale. Surfaces in the generated STM document.               |
| `classification` | Per-field classification override (`public | internal | confidential | restricted`). |
| `pii`            | `true` when this field carries PII, regardless of the message-level flag.       |
| `redact`         | `none | hash | mask | drop`. Packs compile to the platform's native masking primitive. |

### Lookups

Reference tables are declared inline (`entries`) or loaded from an external file (`sourceRef`). Packs compile them to the platform's native lookup (Logic Apps inline `createObject`, DataWeave `lookup`, SAP CPI value mapping, etc.).

### Tests

Each mapping may declare golden-file tests. The `mapping-designer` and `/review` commands execute them with the JavaScript JSONata reference implementation (or the engine's reference implementation) to prove the mapping produces the expected target shape before packs compile it.

### Referencing mappings from flow steps

`transform` and `enrich` steps reference a mapping by name:

```yaml
steps:
  - id: normalize
    type: transform
    mappingRef: RawOrderToCanonical
    next: route
```

The legacy `transform: <SymbolicName>` form is retained as a fallback but is deprecated — packs will warn when they see it.

### Structured router predicates

Router `when` may be a raw string (legacy) or a typed predicate object (preferred):

```yaml
- id: route
  type: router
  routes:
    - when: { engine: jsonata, expression: "region = 'EU'" }
      next: publishEu
    - when: { engine: jsonata, expression: "region = 'US'" }
      next: publishUs
    - default: true
      next: rejectRegion
```

## Flows and EIP nodes

A flow is a DAG of typed steps. Each step has a stable `id`, a `type`, inputs, and either a single `next` or a `routes` block.

### Flow-level implementation host (Azure pack)

Each flow may declare a target compute host that drives which Azure compiler picks it up:

```yaml
flows:
  - name: OrderIntake
    implementation:
      host: logic-app-standard            # default — also: function-app | data-factory | container-app | synapse-pipeline
      hostingPlan: consumption            # function-app only — also: flex-consumption | premium | dedicated | container-apps
      durablePattern: fan-out-fan-in      # function-app only when orchestration is required
      rationale: "Sub-second HTTP request/response, no batch movement."
    ...
```

| Host value | Compiler | Output tree |
|---|---|---|
| `logic-app-standard` (default) | `azure-logic-apps-compiler` | `app/<Flow>/workflow.json` |
| `function-app` | `azure-functions-compiler` | `FunctionApps/<Flow>/` (stand-alone .NET 8 isolated-worker project) |
| `data-factory` | `azure-data-factory-compiler` | `adf/pipelines/<Flow>.json` + datasets, linked services, triggers |

`implementation` is set by the `target-architecture` agent (or hand-authored in the IR) and consumed by `/implement-azure`. When the field is omitted, the Azure pack defaults to `logic-app-standard`. `ir-validator` rejects `data-factory` for HTTP-triggered or sync-reply flows because ADF is fundamentally bulk data movement.

Supported node types (mirrors Hohpe EIP):

| Type           | Purpose                                                         |
|----------------|-----------------------------------------------------------------|
| `receive`      | Entry point bound to a channel.                                 |
| `transform`    | Deterministic message transformation. Must set `mappingRef`.    |
| `enrich`       | Look up additional data from a dependency. May set `mappingRef` to merge results. |
| `filter`       | Drop messages that don't match a predicate.                     |
| `router`       | Content-based routing: `routes` maps predicate -> next.         |
| `recipientList`| Fan-out to N next steps (in parallel).                          |
| `splitter`     | Break one message into many.                                    |
| `aggregator`   | Collect N messages by correlation key into one.                 |
| `scatterGather`| Fan-out + aggregate in one node.                                |
| `send`         | Publish to an outbound channel.                                 |
| `invoke`       | Synchronous call to a dependency; must declare retry + timeout. |
| `claimCheck`   | Store a large payload in an object store (`store` channel, `kind: blob`) and emit a reference message (`referenceMessageRef`). |
| `wireTap`      | Non-blocking duplicate of every message onto a diagnostic outbound channel (`target`). |
| `throttler`    | Cap throughput. Required: `rps`; `burst` optional; `strategy: shed | queue | block`. |
| `saga`         | Long-running orchestration. `children[]` is a list of `{ forward, compensate }` step-id pairs; compensation runs in reverse on failure. |
| `resequencer`  | Reorder messages by `orderingKey` within a bounded `window` (ISO-8601 duration); gives up and forwards in arrival order when the window elapses. |

Example:

```yaml
flows:
  - name: OrderIntake
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
      - id: publishEu
        type: send
        channel: orders-eu-topic
      - id: publishUs
        type: send
        channel: orders-us-topic
```

## Error handling

```yaml
errorHandling:
  retry:
    policy: exponential         # fixed | exponential
    count: 4
    interval: PT5S
  dlq:
    channel: orders-dlq         # must exist in channels[]
  circuitBreaker:
    failureRatio: 0.5
    windowSeconds: 60
```

Per-flow overrides are allowed under `flows[].errorHandling`. Per-step overrides live on `flows[].steps[].errorHandling` and add these step-scoped fields:

```yaml
steps:
  - id: invokePayments
    type: invoke
    dependency: PaymentsApi
    timeout: PT3S
    retry:                          # per-step retry (today, flow-level retry only applied to invoke)
      policy: exponential
      count: 3
      interval: PT1S
    errorHandling:
      retryableErrors: [TransientHttpError, 503, 504]
      nonRetryableErrors: [ValidationError, 400]
      onError: fallback             # continue | dlq | fallback | fail  (default dlq)
      fallback: rejectRegion        # must resolve to a step id in the same flow
      dlq:
        channel: orders-dlq-queue
```

`ir-validator` asserts every `fallback` resolves to a step in the same flow, and rejects `onError: fallback` without a `fallback` id, or the same error code appearing in both `retryableErrors` and `nonRetryableErrors`.

## Identity

```yaml
identity:
  managedIdentity: system       # system | userAssigned
  principalRef: mi-orders       # required if userAssigned
  roleAssignments:
    - scope: serviceBusNamespace
      role: Azure Service Bus Data Sender
```

## Non-functionals

```yaml
nonFunctionals:
  rps: 50
  p95LatencyMs: 2000
  slo:
    availability: 99.9
    errorBudgetDays: 30
```

## Custom code

When a reverse-engineering agent encounters source-platform logic that cannot be expressed in a standard engine (scripting functoids, BRE policies, DataWeave scripts, C# helpers, Java classes), it uses three IR extensions to preserve that information in a platform-neutral, auditable form.

### `engine: custom` on mappings

Use when the transformation is implemented in source-platform code rather than a standard engine:

```yaml
mappings:
  - name: ParseFlatFile
    source: { messageRef: RawFlatFile }
    target: { messageRef: Order }
    engine: custom
    codeRef: artifacts/custom/FlatFileParser.cs   # extracted source, checked into the repo
    runtime: dotnet                                # dotnet | java | js | python | xslt-ext | bre
    migrationHint: local-function                  # auto | local-function | azure-function | manual
    description: "BizTalk scripting functoid: FlatFileParser.Parse(). Parses legacy positional format."
    tests:
      - name: happy-path
        input:  { path: tests/fixtures/raw-flat-file.txt }
        expect: { path: tests/fixtures/order-parsed.json }
```

`codeRef` is mutually exclusive with `expression` and `rules`. Tests still apply and should exercise the extracted code where possible.

### `execute` step type

Use for custom logic that is not a message transformation — BRE policies, custom pipeline components, validation scripts, or any callable that doesn't fit the standard EIP node types:

```yaml
steps:
  - id: applyBusinessRules
    type: execute
    codeRef: artifacts/custom/OrderValidationRules.xml   # BRE policy XML
    runtime: bre
    migrationHint: conditions
    description: "BRE policy: validates order line items against pricing rules"
    next: route
    errorHandling:
      onError: dlq
```

`execute` requires `codeRef`. `next` and `errorHandling` work identically to other step types.

### `kind: function` on dependencies

Use for reusable callable code (C# helpers, Java classes, JS modules) invoked from multiple steps via the existing `invoke` step type:

```yaml
dependencies:
  - name: JsonXmlBridge
    kind: function
    codeRef: artifacts/custom/JsonXmlBridge.cs
    runtime: dotnet
    migrationHint: local-function
    description: "Converts JSON↔XML. Extracted from BizTalk custom pipeline component."
    timeout: PT1S
```

Steps invoke it the same way as any other dependency:

```yaml
- id: convertToXml
  type: invoke
  dependency: JsonXmlBridge
  timeout: PT1S
```

### `migrationHint` values

| Value | Meaning | Pack behaviour |
|---|---|---|
| `auto` | Pack can compile natively | Compile; no warning |
| `local-function` | Needs a co-deployed in-process function | Emit function wrapper + invoke action |
| `azure-function` | Needs a sidecar Azure Function | Emit TODO + Sev-2 finding |
| `manual` | Human required — STRUCTURAL blocker | Emit no output for flows that depend on this; surface as Sev-1 |

`manual` is the only value that blocks a pack from generating output for the affected flow. All other values allow the pack to proceed, with appropriate findings emitted.

### `runtime` values

| Value | Environment |
|---|---|
| `dotnet` | .NET / C# |
| `java` | JVM / Java |
| `js` | JavaScript / Node.js |
| `python` | Python |
| `xslt-ext` | XSLT with extension object DLL |
| `bre` | Business Rules Engine (e.g. BizTalk BRE, Drools) |

## Dependencies

```yaml
dependencies:
  - name: InventoryApi
    kind: rest
    contractRef: contracts/openapi-inventory.yaml
    timeout: PT3S
    retry: { policy: exponential, count: 3, interval: PT1S }
    idempotencyHeader: Idempotency-Key
    rateLimit: { rps: 50, burst: 10 }
    circuitBreaker: { failureRatio: 0.5, windowSeconds: 60 }

  - name: InventoryStream
    kind: grpc
    streaming: serverStream        # none | clientStream | serverStream | bidi
    timeout: PT10S

  - name: OrdersDb
    kind: db
    driver: postgres
    txBoundary: perFlow            # perCall | perFlow
    timeout: PT2S
```

`retry` is a first-class sibling of `timeout`: invoke steps without their own retry block inherit the dependency-level policy. `idempotencyHeader` tells packs to propagate the message-level `idempotencyKey` into that header on every REST call. `streaming` is rejected on non-gRPC dependencies; `driver` and `txBoundary` are rejected on non-DB dependencies.

## Endpoints (Phase 8)

The `endpoints` block carries authoritative HTTP-surface detail for synchronous integrations. `contract-designer` projects every field into `contracts/openapi.yaml`; `ir-validator` fails on divergence between the IR and the generated OpenAPI document. Packs consume the IR directly — they are never required to re-parse OpenAPI for transport detail.

```yaml
endpoints:
  - name: CreateOrder
    channel: orders-http
    operation: request
    contractRef: contracts/openapi.yaml
    method: POST
    path: /orders
    requestBody:
      messageRef: Order
      contentTypes: [application/json]
      required: true
    responses:
      '202': { description: Accepted }
      '400': { description: Bad request }
      '409': { messageRef: OrderDuplicate, description: Duplicate orderId }
      '500': { description: Internal error }
    parameters:
      - in: header
        name: X-Correlation-Id
        required: true
        schemaRef: contracts/schemas/CorrelationId.json
    idempotencyHeader: Idempotency-Key
    rateLimit: { rps: 1000, burst: 200 }
    cors:
      origins: ['https://portal.example.com']
      methods: [POST]
      headers: ['Content-Type', 'X-Correlation-Id']
    contractTests:
      - name: consumer-driven-createOrder
        role: provider
        pactFile: contracts/pacts/portal-createOrder.json
```

`method` and `path` must agree with the bound channel's `binding.method` / `binding.path` when both are set. `idempotencyHeader` requires the bound inbound channel's message to declare `idempotencyKey`. `rateLimit` on the endpoint wins over `channel.binding.rateLimit`; when both are set, `ir-validator` emits Sev-2 `ENDPOINT_RATELIMIT_SHADOWS_BINDING` so the redundancy is made explicit.

## Flow tests (Phase 8)

`flows[].tests[]` drives a flow through the in-process interpreter and asserts emitted messages, reached steps, and DLQ envelopes. `flow-tester` (agent) / `/test-flows` (command) executes the block.

```yaml
flows:
  - name: OrderIntakeFlow
    trigger: orders-http
    tests:
      - name: happy-path-eu
        trigger:
          channel: orders-http
          path: tests/fixtures/order-eu.json
          headers: { X-Correlation-Id: '11111111-1111-1111-1111-111111111111' }
        context:
          correlationId: '11111111-1111-1111-1111-111111111111'
        expect:
          - channel: orders-eu-topic
            body: { path: tests/fixtures/order-created-eu.json }
            headers: { correlationId: '11111111-1111-1111-1111-111111111111' }

      - name: payments-fail-to-dlq
        trigger: { channel: orders-http, path: tests/fixtures/order-us.json }
        faults:
          - { step: invokePayments, error: '503', afterAttempts: 3 }
        expect:
          - error:
              code: '503'
              dlqChannel: orders-dlq-queue
              afterRetries: 3
              envelope: { path: tests/fixtures/order-dlq-envelope.json }
```

The interpreter is deterministic and pack-agnostic. Mapping expressions run against JSONata; dependency responses are mocked via `tests[].context.<dependencyName>`. For platform-native fidelity (Logic Apps `runAfter` wiring, APIM policies) use the pack's `<plat>-workflow-tester` agent.

## Observability (Phase 8)

Each flow may declare platform-neutral observability:

```yaml
flows:
  - name: OrderIntakeFlow
    tracked:
      - name: correlationId
        source: $context.correlationId
        description: End-to-end correlation id propagated from the inbound X-Correlation-Id header.
      - name: orderId
        source: body.order.orderId
        classification: internal
    metrics:
      - { name: orders_received_total,  type: counter,   source: '1',                     unit: '1' }
      - { name: order_total_amount,     type: histogram, source: body.order.totalAmount,  unit: minor-units }
    logSampling:
      rate: 1.0
      level: info
```

Packs compile these to the platform's native sink:

| IR field      | Azure Logic Apps          | AWS Lambda / Step Functions | MuleSoft / Boomi         |
|---------------|----------------------------|------------------------------|--------------------------|
| `tracked[]`   | `trackedProperties`        | OTEL span attributes         | Flow variables + OTEL    |
| `metrics[]`   | Application Insights custom | CloudWatch custom metrics    | Anypoint Monitoring      |
| `logSampling` | App Insights sampling      | Lambda log retention policy  | Anypoint Monitoring samp |

`reviewer` cites Article IV explicitly when a flow whose trigger message declares `correlationId` has no matching `tracked[]` entry referencing it.

## Validation

Run:

```
npx ajv validate -s schemas/integration-ir.schema.json -d specs/*/*/integration-ir.yaml
```

`integration-architect` runs this before writing the file. `planner` rejects plans built from an invalid IR.
