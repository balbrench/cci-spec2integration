---
name: ir-authoring
description: Authoring rules, validation steps, and style guide for integration-ir.yaml.
---

# Integration IR Authoring

## Authoring domain.yaml

`domain.yaml` sits above `integration-ir.yaml` in the hierarchy. Run `/domain` to produce it via the `domain-architect` agent; the guidance below is for manual review and hand-editing.

### When to create a domain.yaml

Create one domain.yaml per business domain whenever:
- Two or more integrations belong to the same business domain and exchange messages with each other.
- A canonical event schema needs to be owned at a level above any single integration.
- Domain-wide policy (auth, classification, DLQ) needs to be enforced consistently.

A single standalone integration that has no cross-integration messaging does not need a domain.yaml — `metadata.domain` as a plain string tag is sufficient for that case.

### Layer assignment rules

Set `integrations[].layer` based on the integration's primary role:

- `experience` — the integration's inbound trigger is `kind: http` and is exposed to external consumers. It should carry API Management wiring, external OAuth2 or API-key auth, and consumer-friendly error responses.
- `process` — the integration orchestrates across multiple systems or other integrations. It handles saga compensation, cross-system correlation, and business-rule routing.
- `system` — the integration wraps a single backend system (one `rest`, `db`, or `grpc` dependency). It handles connection management, low-level retry, and circuit breaking.

When a single deployment spans layers, set `layer` on individual flows rather than the domain registration.

### Canonical event rules

Only list an event in `domain.events[]` when:
1. Its schema is **owned by the domain** — not by a single integration.
2. At least one integration produces it **and** at least one integration consumes it.
3. A canonical schema file exists (or will exist before `/review` runs).

Do not list internal integration-private messages as domain events — they belong in `messages[]` within their integration.

### Policy inheritance

Domain policy sets the floor. Individual integrations may only tighten it:
- `dataClassification`: integration may declare `confidential` when domain is `internal`; never `public` when domain is `internal`.
- `errorHandling.retry.count`: integration may declare a higher count; never lower.
- `auth`: integration may declare a stricter auth scheme; never `none` when domain is `oauth2`.

### Checklist for domain.yaml

- [ ] `metadata.name` is kebab-case and matches `metadata.domain` in every registered integration.
- [ ] Every `integrations[].path` resolves to an existing `integration-ir.yaml` (path is relative to the domain folder).
- [ ] Every `events[].schemaRef` resolves to an existing schema file.
- [ ] `events[].producers` and `events[].consumers` name real integration `metadata.name` values.
- [ ] `policy.dataClassification` is not looser than any integration's `metadata.classification`.
- [ ] File passes schema validation against `domain-ir.schema.json`.

## Validate before writing

After drafting the IR, validate against the schema:

```
npx -y ajv-cli validate \
  -s schemas/integration-ir.schema.json \
  -d specs/*/*/integration-ir.yaml
```

If `ajv-cli` isn't available, hand the schema and the IR draft to a JSON-Schema validator of your choice. Do not emit an invalid IR.

## Naming

- `metadata.name`: kebab-case, unique in the repo.
- Channel names: kebab-case, end with `-<kind>` for clarity (e.g. `orders-topic`, `orders-dlq-queue`).
- Message names: PascalCase, match the schema filename under `contracts/schemas/`.
- Mapping names: PascalCase, read as `<Source>To<Target>` (e.g. `RawOrderToCanonical`, `OrderToCapturePayment`).
- Lookup names: PascalCase, describe the direction (e.g. `CountryNameToIso3166Alpha2`).
- Flow names: PascalCase, end in `Flow`.
- Step ids: camelCase.

## Style

- One flow per business process. Do not bundle.
- One trigger per flow.
- Steps form a DAG; cycles are invalid.
- Every branch path must eventually reach either a `send` or a terminal step with no `next`.
- `errorHandling` at the top level sets defaults; override per flow only when justified in a trailing `# rationale:` comment.
- Prefer `managedIdentity: system` unless multiple apps share identity.

## Authoring mappings

The `mappings` block carries **all** source→target transformation logic. Do not leave transforms as opaque symbolic names; that pushes the actual work into the platform pack and makes two packs silently disagree.

- **Engine:** default to `jsonata` for JSON ↔ JSON. Use `xslt` for XML ↔ XML, `liquid` when a platform demands it for template-style output, `jslt` only if a team has standardised on it. Never mix engines within one mapping.
- **Choose one style per mapping:**
  - `rules` — readable per-field table. Prefer when source and target are mostly 1:1 or when business analysts need to review (this form drives the auto-generated STM document).
  - `expression` — one whole-document expression. Prefer for heavy restructuring, collection shaping, or when rule tables would balloon.
- **Every rule needs at least one of** `source` / `expression` / `lookup` / `default`. `default` protects against null inputs from flaky sources.
- **Use `lookup` for reference data** (country codes, region-to-queue, SKU prefixes). Do not hard-code value lists inside expressions — that hides domain knowledge from the STM doc and the reviewer.
- **Tests are required** for every mapping. Reference fixture payloads under `contracts/examples/`. If a payload doesn't exist yet, create it — it doubles as documentation.
- **Reference from flows** via `mappingRef: <MappingName>`. Do not leave `transform: <SymbolicName>` on new steps.
- **Structured router predicates** (`when:` with explicit `engine` and `expression` fields) are preferred over raw-string predicates so the expression engine is explicit and reviewable.
- **Emit YAML-safe expression scalars.** Any JSONata / selector / predicate text containing YAML-significant characters such as `:`, `?`, `#`, `{}`, `[]`, or a leading `@`, `&`, or `*` MUST be written as a quoted string or a block scalar (`>-` for one-line expressions, `|-` for multi-line expressions). Do not rely on YAML plain scalars for ternaries or other punctuation-heavy expressions; the IR viewer loads with `js-yaml` and must parse the file without ambiguity.

### When a mapping doesn't fit JSONata

- XML → XML: use `engine: xslt` with `expression` carrying an `<xsl:stylesheet>`.
- Flat-file / CSV: model the parsed shape as a JSON message (set `format: csv` on the source `messages[]` entry) and use JSONata from there.
- Binary / EDI: declare with `format: edi-x12` / `edifact` / `binary`. Packs are responsible for the parse step; the mapping then runs against the parsed JSON tree.

### Header and property mapping

Use `messages[].headers[]` to declare message-level metadata (AMQP/Service Bus properties, HTTP headers, Kafka headers). Each header has a `source` (`literal` | `body` | `requestHeader` | `context` | `generated`) and, for non-generated headers, a `value` (literal or JSONata expression). Packs bind these to the platform's native header/property API.

### YAML-safe expression examples

- Single-line rule expression:

  ```yaml
  - target: correlationId
    expression: >-
      correlationId ? correlationId : customer.customerId
  ```

- Structured router predicate:

  ```yaml
  when:
    engine: jsonata
    expression: >-
      $exists(customer.customerId) and $count(customer.orderItems[$exists(lineNumber) and $exists(productId) and $exists(quantity)]) > 0
  ```

- Whole-document mapping:

  ```yaml
  expression: |-
    (
      $base := {"status": 400};
      $base
    )
  ```

## Authoring checklist

Before handing off to `planner`:

- [ ] Every IR explicitly sets `metadata.scenario: migration | greenfield`. Reverse-engineered IRs also have a top-level `source:` block with `platform: biztalk | mulesoft | tibco | boomi | informatica | ssis`; greenfield IRs omit `source:`. The pipeline supports both modes, but a single IR must commit to exactly one mode.
- [ ] Every `messages[]` entry with `format` in `xml | flat-file | edi-x12 | edifact` has `nativeSchemaRef` pointing at an on-disk XSD. Same for `mappings[].engine: xslt` and `codeRef`.
- [ ] Every channel referenced by a step exists in `channels[]`.
- [ ] Every message in `messages[]` has a schema under `contracts/schemas/` and an explicit `format`.
- [ ] Every `transform` step has a `mappingRef`; every `enrich` step has either a `mappingRef` or a declared `dependency`.
- [ ] Every `mappings[]` entry has at least one test and either `expression` or `rules` (not both).
- [ ] Every `mappings[].rules[]` entry has at least one of `source`, `expression`, `lookup`, `default`, or `redact`.
- [ ] Every `invoke` has a matching entry in `dependencies[]`.
- [ ] Every `aggregator` has `correlation`.
- [ ] Every `router` covers all business cases or has a `default: true` route.
- [ ] Every external hop is covered by `errorHandling.retry` and `errorHandling.dlq`.
- [ ] Every queue/topic channel declares `delivery` (default `at-least-once`) and, where order matters, `ordering` + `orderingKey`.
- [ ] Every external inbound message declares `idempotencyKey` (Article III).
- [ ] Every message carrying PII declares `pii: true` (message or per-rule) and every PII field routed through a `classification: public` channel declares `redact`.
- [ ] Every step that needs an error detour declares `errorHandling.fallback` pointing at a step in the same flow.
- [ ] Every `claimCheck` points `store` at a `kind: blob` channel and names a `referenceMessageRef`.
- [ ] Every `wireTap` targets an outbound diagnostic channel.
- [ ] Every `saga` child pair names both a `forward` and a `compensate` step in the same flow; no id is reused.
- [ ] Every `throttler` with `strategy: queue` sets `burst`.
- [ ] Every `resequencer` sets both `orderingKey` and `window`.
- [ ] Every topic `subscription.filter.kind: sql` uses an expression the target broker supports (or the pack is prepared to emit a Sev-2 "feature not supported" finding).
- [ ] Every inbound queue/topic that needs a consumer pool declares `consumer.count`; use `subscription.filter` before `consumer.selector` when the broker can evaluate server-side.
- [ ] Every dependency's protocol-specific fields match its `kind` (grpc → `streaming`; rest → `idempotencyHeader`/`rateLimit`/`circuitBreaker`; db → `driver`/`txBoundary`).
- [ ] Every inbound HTTP endpoint in `endpoints[]` declares `method`, `path`, `requestBody.messageRef`, at least one entry in `responses`, and any header/query parameters; `ir-validator` fails on divergence with the generated OpenAPI.
- [ ] Every endpoint that needs idempotent-POST semantics declares `idempotencyHeader` (and the bound channel's message carries `idempotencyKey`).
- [ ] Every `flows[]` whose trigger message carries `correlationId` declares at least one matching `tracked[]` entry (Article IV).
- [ ] Every flow-level test in `flows[].tests[]` references fixtures under the integration folder and names the trigger channel that matches the flow's own trigger.
- [ ] `identity` does not contain inline secrets.
- [ ] `nonFunctionals` reflects NFRs from `spec.md`.
- [ ] File passes schema validation.
- [ ] `mappings/<Name>.md` STM documents are regenerated and committed.

## Messaging semantics (Phase 6)

The IR's default delivery guarantee is `at-least-once` with `ordering: none`. Tighten these when the business requires it:

- **Ordering by business key.** Use `ordering: byKey` with `orderingKey: body.orderId` (or a header name). On session-aware brokers (Service Bus, JMS) also set `sessionKey` so packs can set `SessionId`.
- **Exactly-once is rare.** Only valid on brokers that support it natively. `ir-validator` rejects `exactly-once` on `http` and `eventgrid`.
- **DLQ vs retry count.** `maxDeliveryCount` is the broker's redelivery limit before dead-lettering. Keep it higher than `errorHandling.retry.count` (which is per-attempt) so retries don't get truncated.
- **Retention vs TTL.** `ttl` is per-message expiration; `retention` is Article V policy for the broker entity (how long the entity remembers any message). PRDs that mandate "retain for N days" should set `retention: P<N>D`.

## Idempotency, correlation, data handling

- Put `idempotencyKey` on the message, not on the flow — the key is a property of the contract, not the orchestration.
- `correlationId` can be a body path (`body.correlationId`) OR a header name (`X-Correlation-Id`). Packs propagate both forms.
- Classify at the coarsest usable level. Set `classification` on the message when the whole payload is uniform; drop down to per-rule `classification` only when fields differ.
- Prefer `redact: hash` for analytics sinks (keeps cardinality, removes PII), `redact: mask` for log outputs, `redact: drop` when the field is not needed downstream.

## Channel bindings cookbook (Phase 7)

`channel.binding` is an open object whose shape depends on `kind`. Packs compile the binding into broker-native resource properties; unsupported fields emit Sev-2 "feature not supported by pack" findings rather than getting silently dropped.

### `http`
```yaml
- name: orders-http
  kind: http
  direction: inbound
  binding:
    method: POST                 # GET | POST | PUT | PATCH | DELETE
    path: /orders
    query: [region]
    cors: { origins: ['https://portal.example.com'], methods: [POST], headers: ['*'] }
    rateLimit: { rps: 1000, burst: 200 }
    signatureHeader: X-Hub-Signature-256
    polling: push                # push | polling
```

### `queue` / `topic` — Service Bus / SQS / JMS
```yaml
- name: orders-topic
  kind: topic
  direction: outbound
  binding:
    sessionRequired: true
    partitionCount: 4
    autoDeleteOnIdle: P7D
    duplicateDetection: true
```

### `topic` — Kafka / Event Hubs
```yaml
- name: orders-events
  kind: topic
  direction: outbound
  binding:
    partitionKey: body.order.orderId
    consumerGroup: orders-eu
    compaction: true
    offsetReset: earliest        # earliest | latest | none
```

### `topic` — MQTT
```yaml
- name: telemetry-mqtt
  kind: topic
  direction: inbound
  binding:
    qos: 1                       # 0 | 1 | 2
    retained: false
    cleanSession: true
```

### `queue` — AMQP / RabbitMQ
```yaml
- name: invoice-queue
  kind: queue
  direction: inbound
  binding:
    exchangeType: direct         # direct | fanout | topic | headers
    routingKey: invoice.created
    bindingKey: invoice.*
```

### `timer`
```yaml
- name: nightly-run
  kind: timer
  direction: inbound
  binding: { cron: "0 2 * * *" } # or { interval: PT15M }
```

### `blob`
```yaml
- name: orders-blob
  kind: blob
  direction: inbound
  binding:
    pathPattern: orders/{yyyy}/{MM}/{dd}/
    triggerEvent: blobCreated
```

### `eventgrid`
```yaml
- name: tenant-events
  kind: eventgrid
  direction: inbound
  binding:
    eventType: Microsoft.Storage.BlobCreated
    subjectPattern: /blobServices/default/containers/orders/blobs/
```

### Subscriptions with filters

`channel.subscription` may be a plain string (just the subscription name) or an object with a broker-native filter. Packs compile SQL filters to Service Bus `SqlFilter`, SNS filter policies, or a best-effort correlation filter on brokers that don't support SQL.

```yaml
- name: orders-eu-subscription
  kind: topic
  direction: inbound
  subscription:
    name: orders-eu
    filter:
      kind: sql                  # sql | correlation | header
      expression: "region = 'EU'"
```

## Selective and competing consumers (Phase 7)

Use `consumer` on inbound queue/topic channels to size the consumer pool and apply server-side selection:

```yaml
- name: orders-eu-topic
  kind: topic
  direction: inbound
  subscription: { name: orders-eu, filter: { kind: sql, expression: "region = 'EU'" } }
  consumer:
    count: 4                     # competing consumers
    selector: "priority = 'high'"  # additional client-side filter
```

- `count` sizes the pool of competing consumers; packs compile to Logic Apps `splitOn` + `concurrency`, SQS visibility + parallelism, Kafka consumer-group replicas.
- `selector` is a JSONata/SQL expression evaluated per message. Prefer `subscription.filter` where the broker can evaluate server-side (cheaper); use `selector` only when the filter must run on the client.

## Dependency protocol detail (Phase 7)

Promote transport specifics that used to live inside pack templates into the dependency entry:

```yaml
dependencies:
  - name: PaymentsApi
    kind: rest
    contractRef: contracts/openapi-payments.yaml
    timeout: PT3S
    retry: { policy: exponential, count: 3, interval: PT1S }
    idempotencyHeader: Idempotency-Key
    rateLimit: { rps: 50, burst: 10 }
    circuitBreaker: { failureRatio: 0.5, windowSeconds: 60 }

  - name: InventoryStream
    kind: grpc
    streaming: serverStream      # none | clientStream | serverStream | bidi
    timeout: PT10S

  - name: OrdersDb
    kind: db
    driver: postgres
    txBoundary: perFlow          # perCall | perFlow
    timeout: PT2S
```

Packs propagate `idempotencyHeader` from the message's `idempotencyKey` on every call, and compile `circuitBreaker` into the platform's native breaker (Polly, Hystrix, Istio retry budget, etc.).

## Endpoints, flow tests, and observability (Phase 8)

### Endpoints carry HTTP transport detail

Put authoritative HTTP surface data on `endpoints[]`, not scattered across OpenAPI and pack templates. `contract-designer` projects these fields into `contracts/openapi.yaml`; `ir-validator` fails on divergence. Packs must consume endpoint detail from the IR, never by re-parsing OpenAPI.

```yaml
endpoints:
  - name: CreateOrder
    channel: orders-http
    operation: request
    contractRef: contracts/openapi.yaml
    method: POST
    path: /orders
    requestBody: { messageRef: Order, contentTypes: [application/json] }
    responses:
      '202': { description: Accepted }
      '400': { description: Bad request }
      '500': { description: Internal error }
    parameters:
      - { in: header, name: X-Correlation-Id, required: true }
    idempotencyHeader: Idempotency-Key
    rateLimit: { rps: 1000, burst: 200 }
    cors:
      origins: ['https://portal.example.com']
      methods: [POST]
```

### Flow-level tests

`flows[].tests[]` drives a flow through the in-process interpreter. One test per business scenario; one fixture file per trigger and per expected body. Use `context.correlationId` to pin values that would otherwise be generated.

```yaml
tests:
  - name: happy-path-eu
    trigger: { channel: orders-http, path: tests/fixtures/order-eu.json }
    context: { correlationId: '11111111-1111-1111-1111-111111111111' }
    expect:
      - channel: orders-eu-topic
        body: { path: tests/fixtures/order-created-eu.json }

  - name: payments-fail-to-dlq
    trigger: { channel: orders-http, path: tests/fixtures/order-us.json }
    faults: [{ step: invokePayments, error: '503', afterAttempts: 3 }]
    expect:
      - error: { code: '503', dlqChannel: orders-dlq-queue, afterRetries: 3 }
```

Prefer `subscription.filter` or `selector` at the channel level to model real routing; save `faults[]` for exercising DLQ paths.

### Observability declarations

Every flow whose trigger message carries `correlationId` must wire it through `tracked[]` — otherwise packs have nothing to propagate into platform observability and `reviewer` cites Article IV.

```yaml
flows:
  - name: OrderIntakeFlow
    tracked:
      - { name: correlationId, source: $context.correlationId }
      - { name: orderId,       source: body.order.orderId, classification: internal }
    metrics:
      - { name: orders_received_total, type: counter, source: '1' }
    logSampling: { rate: 1.0, level: info }
```

## Authoring custom code (reverse-engineering path)

When a reverse-engineering agent produces an IR from a source platform that contains custom code, use the following rules to represent it correctly. Forward-engineering (spec → IR) should never produce `engine: custom`, `execute` steps, or `function` dependencies — those only appear when migrating existing integrations.

### Choosing the right construct

| Source artefact | IR construct |
|---|---|
| Scripting functoid, DataWeave transform, Groovy map | `mappings[].engine: custom` with `codeRef` |
| BRE policy, custom pipeline component, validation script | `steps[].type: execute` with `codeRef` |
| C# helper class, Java utility, JS module used by multiple steps | `dependencies[].kind: function` with `codeRef` + `invoke` steps |
| XLANG/BizTalk expression used in a router or filter predicate | `when`/`predicate` with `engine: expression` — translate intent; fall back to `execute` if too complex |

### Setting `migrationHint`

Set `migrationHint` based on the analysis verdict from the reverse-engineering agent. Never guess; only set it after actual analysis:

- `auto` — the code was successfully decompiled and a standard engine equivalent exists. Update `engine` to the standard engine and remove `codeRef` when this is reached.
- `local-function` — the code can run in-process alongside the integration but requires a wrapper. Pack will generate the function stub.
- `azure-function` — the code needs a sidecar. Pack will emit a Sev-2 finding. A human must implement and deploy the function separately.
- `manual` — the code cannot be compiled at all (missing source, unsupported BRE construct, circular dependency). Pack emits Sev-1 and generates no output for the affected flow. **Do not use this unless you are certain no automated path exists.**

### `codeRef` file conventions

- Store extracted code files under `artifacts/custom/<OriginalName>.<ext>` relative to the integration folder.
- One file per artefact — do not concatenate multiple extracted files.
- The file must exist and be committed before the IR is validated (`ir-validator` checks `codeRef` existence).
- Binary artefacts (compiled DLLs without source) are represented with a `.dll.stub` extension and a comment file explaining what the DLL does.

### Tests on `engine: custom` mappings

- Tests are **still required** on `engine: custom` mappings (same Sev-2 rule as other mappings).
- If the extracted code can be run locally (e.g. a Node.js script), wire the test to call it. If not, create a golden-file test with the expected output for the known happy-path input — this serves as a specification for whoever reimplements it.

### Checklist additions for custom code

Before handing off an IR that contains custom code:

- [ ] Every `engine: custom` mapping has `codeRef`, `runtime`, and `migrationHint`.
- [ ] Every `execute` step has `codeRef` and `migrationHint`.
- [ ] Every `kind: function` dependency has `codeRef`, `runtime`, and `migrationHint`.
- [ ] All `codeRef` files exist relative to the integration folder.
- [ ] No `migrationHint: manual` exists without a comment explaining why automation is impossible.
- [ ] All flows that depend (directly or transitively) on a `migrationHint: manual` artefact have a `# BLOCKED:` comment in the IR noting that pack output will be incomplete.

## Common mistakes

- Using `send` for a request-reply; use `invoke`.
- Using `queue` when multiple consumers are needed; use `topic`.
- Forgetting `timeout` on `invoke`.
- Using vendor-specific naming ("servicebus", "eventgrid") in names; use pattern-oriented names.
- Leaving `transform: <SymbolicName>` on a step with no matching `mappings[]` entry — forces the pack to invent the mapping.
- Embedding platform expressions (e.g. `@triggerBody()?['x']`) inside a mapping. Use portable JSONata; packs translate to native expressions.
- Duplicating lookup tables across rules instead of declaring them once under `mappings[].lookups[]`.
- Omitting `format` / `encoding` on non-JSON messages — packs will pick the wrong parser.
- Declaring HTTP method/path on the OpenAPI document but not on the IR `endpoint` — the IR is authoritative; `ir-validator` will fail.
- Setting `endpoint.rateLimit` and `channel.binding.rateLimit` to different values on the same HTTP surface.
- Declaring `flows[].tests[]` without matching fixture files — `ir-validator` rejects missing fixtures the same way it rejects missing schemas.
- A flow whose trigger message declares `correlationId` but `flows[].tracked[]` is empty — packs have no way to carry the id into observability, and `reviewer` cites Article IV.
