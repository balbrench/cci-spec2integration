---
name: eip-to-azure-mapping
description: Mapping from Integration IR node types and channel kinds to Logic Apps Standard constructs and Azure Integration Services primitives.
---

# EIP -> Azure mapping

Use this when compiling IR steps to `workflow.json` actions.

## Node types

| IR `type`       | Primary Logic Apps action        | Notes                                                                                       |
|-----------------|----------------------------------|---------------------------------------------------------------------------------------------|
| `receive`       | Trigger (Request / SB / EG / Blob / Recurrence) | Bind schema from `messages[].schemaRef`.                                          |
| `transform`     | `Compose` (preferred) / `Data Mapper` / `Liquid` / `Transform XML` / `JavaScriptCode` | Chosen by `mappings[mappingRef].engine` and the planning ladder; see "Compiling mappings".    |
| `enrich`        | `Http` + `Compose`               | `Http` calls `dependencies[<name>]`; follow with `Compose` to apply `mappingRef` that merges response into the flow message. |
| `filter`        | `Condition`                      | False branch terminates or goes to DLQ. Compile `predicate` with the "Predicates" table.    |
| `router`        | `Switch`                         | One `cases` entry per route; `default` required. Compile each `when` with the "Predicates" table. |
| `recipientList` | `Parallel`                       | One branch per target; each target is a `send`.                                             |
| `splitter`      | `For_each`                       | Batch when upstream size is unbounded; set `runtimeConfiguration.concurrency`.              |
| `aggregator`    | `Until` + state variable or Stateful workflow pattern | Correlation key held in a workflow variable; timeout safeguard required.|
| `scatterGather` | `Parallel` + post-join `Compose` | Synthesise merged response from branch outputs.                                             |
| `send`          | Managed API connector action (SB/EG) | Use `ManagedServiceIdentity` connection; never connection strings.                      |
| `invoke`        | `Http`                           | Must set `retryPolicy` from IR `errorHandling.retry` (or the dependency-level `retry`).    |
| `claimCheck`    | `Azure Blob — Create Blob` + `Compose` | Upload body to the `store` channel's Blob container at `keyExpression`; emit the `referenceMessageRef` envelope with the blob URL as `storeRef`. |
| `wireTap`       | `Parallel` branch with managed connector `send`, `runAfter: [status: [Succeeded, Skipped]]` on the main branch so a tap failure never blocks the flow. | Publish to `target` without awaiting; use `SetVariable` + `Scope` to isolate failures. |
| `throttler`     | `strategy: shed` → API Management rate-limit policy upstream; `strategy: queue` → Service Bus queue with capped `concurrency.maxConcurrent`; `strategy: block` → Logic App `concurrency` trigger setting. | `rps`/`burst` translate to APIM `rate-limit-by-key` (`calls`, `renewal-period`). |
| `saga`          | Explicit state-machine workflow: one `Scope` per `forward` with a `runAfter: [status: [Failed]]` branch triggering the paired `compensate` step; compensation order enforced by reversed `runAfter` chain. | Maps directly to Durable Functions saga sample; Logic Apps Standard models as nested scopes. |
| `resequencer`   | `Scope` + state variable keyed by `orderingKey`; `Until` loop forwards in order, with an `After` branch that fires on `window` expiry to flush in arrival order. | Acceptable fidelity; for strict resequencing an Azure Functions durable orchestrator is preferable. |

## Channel kinds

> **Cross-reference**: For BizTalk-specific adapter→connector mappings (39 adapters with service provider IDs, operation names, and connection parameters), see `.claude/skills/biztalk-to-azure-mapping/SKILL.md`.

| IR `kind`  | Azure resource            | Trigger / action family           | Auth                   |
|------------|---------------------------|-----------------------------------|------------------------|
| `http`     | Logic App HTTP endpoint   | Request / Response                | Easy Auth / APIM       |
| `queue`    | Service Bus Queue         | Service Bus built-in connector    | Managed Identity       |
| `topic`    | Service Bus Topic         | Service Bus built-in connector    | Managed Identity       |
| `eventgrid`| Event Grid Topic          | Event Grid Publisher              | Managed Identity       |
| `blob`     | Storage Blob              | Azure Blob built-in               | Managed Identity       |
| `timer`    | N/A                       | Recurrence                        | N/A                    |

## Channel bindings (Phase 7)

The `channel.binding` block is the source of truth for broker-native settings. Pull fields from the binding instead of re-inventing them from `path` or `subscription` strings.

| IR `kind`   | IR `binding` field     | Azure target                                                           |
|-------------|------------------------|------------------------------------------------------------------------|
| `http`      | `method`               | Request trigger `method` property.                                     |
| `http`      | `path`                 | Request trigger `relativePath`.                                        |
| `http`      | `query`                | `parameters.request.properties.queries` schema entries.                |
| `http`      | `cors`                 | API Management CORS policy (preferred) or Logic App `cors` setting.     |
| `http`      | `rateLimit`            | API Management `rate-limit-by-key` policy (`calls`, `renewal-period`).  |
| `http`      | `signatureHeader`      | APIM `validate-content` policy with HMAC verification on the header.    |
| `http`      | `polling`              | `push` keeps the Request trigger; `polling` swaps to a Recurrence + Http action pair. |
| `queue`/`topic` (SB) | `sessionRequired`, `partitionCount`, `autoDeleteOnIdle`, `duplicateDetection` | Bicep queue/topic resource properties; surface as-is. |
| `topic` (Kafka via Event Hubs) | `partitionKey`, `consumerGroup`, `compaction`, `offsetReset` | Event Hubs consumer group + `partitionKey` on publish; `compaction` and `offsetReset` emit Sev-2 "feature not supported" if the namespace tier doesn't support them. |
| `topic` (MQTT) | `qos`, `retained`, `cleanSession`             | Not natively supported by Logic Apps; emit Sev-2 and fall back to Event Grid MQTT broker where available. |
| `queue` (AMQP) | `exchangeType`, `routingKey`, `bindingKey`   | Not natively supported; emit Sev-2 "feature not supported by pack". |
| `timer`     | `cron` / `interval`    | Recurrence trigger `frequency`/`interval` or `schedule`.               |
| `blob`      | `pathPattern`, `triggerEvent` | Blob trigger `path` and `Event Grid` binding events.             |
| `eventgrid` | `eventType`, `subjectPattern` | Event Grid subscription filter `includedEventTypes` / `subjectBeginsWith`. |

Any field listed above that the pack can't honour (MQTT QoS on a Logic Apps runtime, AMQP routing keys, Kafka compaction on a Basic Event Hubs namespace) must surface as a Sev-2 "feature not supported by pack" finding — never silently dropped.

### Subscriptions with filters

| IR `subscription.filter.kind` | Azure Service Bus construct |
|---|---|
| `sql`         | `SqlFilter` on the subscription rule (`filter: { sqlExpression: '<expression>' }`). |
| `correlation` | `CorrelationFilter` — compile `expression` into the property map. |
| `header`      | `CorrelationFilter` restricted to `user properties`. |

### Selective / competing consumers

| IR `consumer` | Logic Apps Standard |
|---|---|
| `count`       | Trigger `runtimeConfiguration.concurrency.runs` = `count`; Bicep app plan scaled accordingly. |
| `selector`    | Post-receive `Condition` gate evaluating the selector as a JSONata expression (via `JavaScriptCode` with `jsonata`); prefer `subscription.filter` when possible (server-side). |

## Compiling mappings

> **Cross-reference**: For BizTalk orchestration shape→Logic Apps action mappings (22 shapes including Decide, Loop, Listen, Parallel, Scope, CallOrchestration, StartOrchestration, Delay, CallRules), expression conversions (50+ XLANG/s→WDL), and custom code migration paths (13 patterns), see `.claude/skills/biztalk-to-azure-mapping/SKILL.md`.

The core IR carries every transformation inside `mappings[]`. A pack must translate the chosen `engine` into the right Logic Apps action, preserving the portable semantics.

| IR `engine` | Logic Apps action | Strategy |
|---|---|---|
| `jsonata` (default, JSON↔JSON) | `Compose` when the mapping is expressible as a static object of Logic Apps `@` expressions; `Data Mapper` for declarative greenfield field-to-field mappings that are clearer as a first-class artifact; otherwise `JavaScriptCode` embedding the JSONata expression evaluated against `workflowContext.trigger.outputs.body` via the `jsonata` npm module. | Prefer `Compose` for trivial reshaping: walk `mappings[].rules[]` and emit `"<target>": "@<translated-expr>"`. Prefer Data Mapper when the greenfield output should stay declarative and maintainable as `Artifacts/DataMapper/<MapName>.lml`. Fall back to `JavaScriptCode` only when JSONata constructs (e.g. `$uuid()`, `$sum()`, deep reduce) have no safe one-shot `@` equivalent. |
| `xslt` (XML↔XML) | Built-in `Transform XML` action. | Emit the XSL stylesheet as a Map asset under `Artifacts/Maps/`, and reference it from the action's `mapName`. |
| `liquid` (JSON/text templating) | Built-in `Transform JSON to JSON` (Liquid) action. | Emit the Liquid template under `Artifacts/Liquid/`. |
| `jslt` | `JavaScriptCode` embedding the JSLT interpreter. | Advisory only; warn the user if the target project has no JSLT runtime configured. |
| `expression` | `Compose` using the raw string as-is. | Escape hatch for already-native expressions; reject during review unless explicitly whitelisted. |

### JSONata rule → Logic Apps `Compose` translation

Simple field copies and arithmetic are safe to inline as `@` expressions. Walk each rule:

| JSONata rule form | `Compose` emission |
|---|---|
| `target: X`, `source: a.b` | `"X": "@triggerBody()?['a']?['b']"` |
| `target: X`, `expression: "a * b"` | `"X": "@mul(triggerBody()?['a'], triggerBody()?['b'])"` |
| `target: X`, `expression: "$uuid()"` | `"X": "@guid()"` |
| `target: X`, `expression: "$now()"` | `"X": "@utcNow()"` |
| `target: X`, `source: s`, `lookup: T` | Emit the lookup table as a `variables[T]` object; `"X": "@variables('T')[triggerBody()?['s']]"` |
| `target: X`, `default: D` (with any other field) | Wrap the result in `coalesce(..., 'D')`. |

Anything more structural (`items.{ ... }`, aggregate `$sum`, conditional rule bodies) should compile to `JavaScriptCode` with an inline `jsonata` evaluation so the semantic stays identical across packs.

### Predicates (router `when` / filter `predicate`)

| IR predicate form | Logic Apps construct |
|---|---|
| `{ engine: jsonata, expression: "region = 'EU'" }` | `Switch` case expression: `"@equals(triggerBody()?['region'], 'EU')"` |
| `{ engine: xpath, expression: "//Order[@region='EU']" }` | `Transform XML` precheck + `Condition`. |
| Raw string (legacy) | Translate as if it were a JSONata predicate; log a deprecation warning. |

### Message format → parser/serializer

| IR `messages[].format` | Logic Apps action family |
|---|---|
| `json` (default) | Native; no action required. |
| `xml` | `Transform XML` + `Parse JSON` (`xml(triggerBody())`). |
| `csv` / `flat-file` | Built-in `Flat File` actions (`Flat File Encoding/Decoding`). |
| `edi-x12`, `edifact` | Azure Integration Account EDI actions; the pack must provision an Integration Account when any `edi-*` format is used. |
| `avro`, `protobuf` | `JavaScriptCode` with the respective npm package; warn the user if the workflow runtime is constrained. |
| `binary` | Pass-through; rejected by `transform`/`enrich` unless the mapping's engine is `expression`. |

### Headers & properties (from `messages[].headers[]`)

| IR `source`        | Logic Apps binding                                                                  |
|--------------------|-------------------------------------------------------------------------------------|
| `literal`          | Static value on the outbound action's `properties` / `headers` map.                 |
| `body`             | `@triggerBody()?['<path>']` or `@outputs('previousAction')?['body']?['<path>']`.    |
| `requestHeader`    | `@triggerOutputs()?['headers']?['<Name>']`.                                         |
| `context`          | Workflow variable set earlier in the flow (e.g. `correlationId`).                   |
| `generated`        | `@guid()` / `@utcNow()` / etc., matching the header `type`.                         |

## Error handling

| IR                          | Azure construct                                                                 |
|-----------------------------|---------------------------------------------------------------------------------|
| `errorHandling.retry`       | Action `retryPolicy` block (`type`, `count`, `interval`).                       |
| `errorHandling.dlq`         | `runAfter: [status: [Failed, TimedOut]]` branch that publishes to DLQ channel.  |
| `errorHandling.circuitBreaker` | Storage Table flag + `Condition` gate upstream of `invoke`; advisory for v1. |

## Dependency protocol detail (Phase 7)

| IR dependency field         | Azure construct                                                                 |
|-----------------------------|---------------------------------------------------------------------------------|
| `retry` (dependency-level)  | Inherited by every `invoke` step against this dependency when the step has no own `retry`; compile to the `Http` action's `retryPolicy`. |
| `idempotencyHeader` (rest)  | `Http` action adds the header on every call, sourcing the value from the message's `idempotencyKey`. |
| `rateLimit` (rest)          | APIM `rate-limit-by-key` policy on the outbound backend (prefer) or Logic Apps `runtimeConfiguration.concurrency`. |
| `circuitBreaker` (rest)     | APIM circuit-breaker policy; fall back to a per-dependency Table flag + `Condition` gate. |
| `streaming` (grpc)          | Logic Apps Standard has no native gRPC; emit a Sev-2 "feature not supported by pack" and hand off to a sidecar Azure Function. |
| `driver` / `txBoundary` (db) | Pick the built-in SQL/PostgreSQL/MySQL connector per `driver`; `perFlow` transactions require an explicit `Transaction Scope` or Durable Functions fallback — emit Sev-2 if the chosen connector can't honour it. |

## Identity

| IR                                       | Azure construct                                                     |
|------------------------------------------|---------------------------------------------------------------------|
| `identity.managedIdentity: system`       | `identity.type: SystemAssigned` on the Logic App.                   |
| `identity.managedIdentity: userAssigned` | `identity.type: UserAssigned` + `userAssignedIdentities.<id>`.      |
| `identity.roleAssignments[]`             | `Microsoft.Authorization/roleAssignments` scoped per entry.         |

## Stateful vs Stateless Decision Matrix

Every workflow must be marked `Stateful` or `Stateless`. Use this matrix when the IR's `flows[].stateful` is not explicitly set (default: `Stateful`).

| Choose **Stateful** when | Choose **Stateless** when |
|---|---|
| Flow contains `aggregator`, `saga`, `resequencer`, or `claimCheck` nodes | Flow is a simple request-reply (receive → transform → respond) |
| Flow needs run history and resubmission | Flow is a fire-and-forget message relay |
| Flow calls child workflows via `InvokeWorkflow` and needs to track their status | Flow does not need run history retention |
| Flow has `delivery: exactly-once` on any channel | All channels use `delivery: at-least-once` or `at-most-once` |
| Flow contains `Until` loops or long-running waits (`Delay` > 5 min) | Flow completes in < 5 minutes with no loops |
| NFR requires durable execution (survives restart) | NFR prioritizes throughput over durability |
| Flow needs to access run history via the Logic Apps REST API | Flow doesn't need programmatic run inspection |

**Performance trade-off**: Stateless workflows have ~2x throughput and lower latency because they skip checkpoint writes. Stateful workflows persist state to storage after every action, enabling resubmission and run history but adding I/O overhead.

**Reviewer rule**: If a workflow is marked `Stateless` but contains any pattern from the "Choose Stateful" column, flag as Major finding.

## Logic Apps Standard Runtime Limits

These hard limits apply to all Logic Apps Standard workflows. The compiler and reviewer must validate generated workflows against them.

| Limit | Value | Impact |
|---|---|---|
| Max actions per workflow | 500 | Split large orchestrations into child workflows |
| Max nesting depth | 8 levels | Avoid deeply nested Scopes/Conditions/ForEach |
| Max `For_each` iterations | 100,000 (default 20 in Stateless) | Use `SplitOn` for large batches; increase via `runtimeConfiguration.concurrency` |
| Max `Until` iterations | 5,000 (default 60) | Set explicit `count` and `timeout` |
| Max `Until` timeout | 1 hour (`PT1H`) | For longer waits, use Durable Functions |
| Max concurrent trigger runs | 100 (Stateful), 50 (Stateless) | Set via `runtimeConfiguration.concurrency.runs` |
| Max message size (inline) | 104,857,600 bytes (100 MB) | Use chunking for larger payloads |
| Max expression length | 8,192 characters | Break complex expressions into multiple Compose steps |
| Synchronous request timeout | 120 seconds (2 min) | Async pattern (202 + callback) for longer operations |
| Max tracked properties per action | 16 | Prioritize correlationId, runId, workflowName |
| Max workflow run retention | 90 days (Stateful) | Configure via `runtimeConfiguration.lifetime` |
| Max `Switch` cases | 25 | Use nested Switches or a router workflow for more branches |
| Max `Parallel` branches | 50 | Group related branches if you exceed this |
| HTTP action timeout | 230 seconds | Use async polling for long-running HTTP calls |
| Workflow definition max size | 1 MB (JSON) | Split into child workflows if definition is too large |

> **Compiler rule**: If a generated workflow exceeds any of these limits, the compiler must split it into child workflows connected via `InvokeWorkflow` actions. Flag as a TODO in the summary if automatic splitting is not possible.

> **Reviewer rule**: Check generated workflows against these limits. Any violation is a Critical finding.

## Observability

- Every action emits `trackedProperties.correlationId`.
- Diagnostic settings forward all categories to Log Analytics.
- Application Insights instrumented via `APPLICATIONINSIGHTS_CONNECTION_STRING` app setting.
