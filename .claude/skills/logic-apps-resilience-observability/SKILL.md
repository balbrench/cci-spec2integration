---
name: logic-apps-resilience-observability
description: Implementation grounding for Logic Apps Standard error handling, retries, dead-lettering, throttling, large-message handling, observability (App Insights, tracked properties, correlation, tracking schemas), and reliability/DR (zone redundancy, multi-region). Grounds constitution Article IV (observability) and Article VI (retries + DLQ) with the concrete Logic Apps wire shapes. Consumed by azure-logic-apps-compiler (to emit correct retry/scope/tracking) and azure-reviewer (to verify them). Bundles the official Microsoft docs under reference/.
---

# logic-apps-resilience-observability skill

Turns the constitution's *requirements* (Article IV observability, Article VI retries + DLQ) into the concrete Logic Apps Standard shapes that satisfy them. The `reference/` docs are the source of truth.

## reference/ contents

- `reference/Error Handling/` — `error-exception-handling.md` (Scope + `runAfter` try/catch/finally), `handle-throttling-problems-429-errors.md`, `logic-apps-handle-large-messages.md`, `handle-long-running-stored-procedures-sql-connector.md`, `logic-apps-diagnosing-failures.md`.
- `reference/Monitoring/` — `enable-enhanced-telemetry-standard-workflows.md`, `monitor-logic-apps-reference.md`, `tracking-schemas-standard.md`, `monitor-track-b2b-transactions-standard.md`, `view-workflow-metrics.md`, `monitor-health-standard-workflows.md`, and more.
- `reference/Reliability/` — `reliability-logic-apps.md`, `set-up-zone-redundancy-availability-zones.md`, `multi-region-disaster-recovery.md`, `create-replication-tasks-azure-resources.md`, B2B business-continuity.

## 1. Retry policy (Article VI) — every external hop

Each `Http` / `ServiceProvider` / `InvokeFunction` action that crosses a trust boundary MUST carry an explicit `retryPolicy` in `inputs`:

```jsonc
"retryPolicy": {
  "type": "exponential",        // exponential | fixed | none
  "count": 4,                    // 1..90
  "interval": "PT7S",            // ISO-8601; minimum varies by connector
  "minimumInterval": "PT5S",     // exponential only
  "maximumInterval": "PT1H"      // exponential only
}
```
- Map the IR `errorHandling.retry` (`maxAttempts`, `backoff`, `interval`) onto these fields. `none` is only valid when the IR explicitly opts out (e.g. non-idempotent side effect guarded elsewhere).
- 429 / throttling: prefer `exponential` with `maximumInterval`; see `handle-throttling-problems-429-errors.md`. Do not silently swallow 429 — retry then DLQ.

## 2. Try / catch / DLQ (Article VI) — the Scope + runAfter pattern

Logic Apps has no `try/catch` keyword; it is expressed with `Scope` + `runAfter` (`error-exception-handling.md`):
- Wrap the risky actions in a `Scope`.
- The DLQ/compensation action sets `runAfter: { "<Scope>": ["Failed", "TimedOut"] }`.
- A "finally" action runs after both with `runAfter: ["Succeeded","Failed","Skipped","TimedOut"]`.
- The IR `errorHandling.dlq` channel becomes a Service Bus `sendMessage` (or the declared DLQ channel) on the failure `runAfter`. Every flow's failure edge must reach its declared DLQ — a missing DLQ branch is an Article VI violation.

## 3. Large messages & long-running ops

- Bodies over the connector limit: use the **claim-check** pattern (Blob `uploadBlob` + reference envelope) per `logic-apps-handle-large-messages.md`. The IR `claimCheck` node compiles to this.
- Long-running SQL: use the SQL connector's long-running/stored-procedure handling (`handle-long-running-stored-procedures-sql-connector.md`) rather than a synchronous `executeQuery` that risks timeout.

## 4. Observability (Article IV) — correlation, structured logs, traces

- **Correlation id end-to-end:** propagate via `clientTrackingId` on the trigger (`triggerOutputs()?['clientTrackingId']` or a header) and via `trackedProperties` on each outbound action. Set the IR's correlation field (e.g. `X-Correlation-Id`) as the workflow's `clientTrackingId` so all runs of the business transaction correlate.
- **trackedProperties:** emit on lead/outbound actions (`tracking-schemas-standard.md`, `monitor-logic-apps-reference.md`). **An action's `trackedProperties` expression may reference ONLY that same action's own inputs/outputs, the trigger's inputs/outputs, `workflow()`, and parameters — NEVER another action's `outputs(...)`/`body(...)`.** A cross-action reference (e.g. a `trackedProperties` on `Insert_Order_Header` that calls `outputs('Set_PurchaseOrder_Xml')`) is rejected at creation and by the unit-test host (verified): *"The tracked property in action '<X>' is referencing action(s) '<Y>'. Tracked properties can only reference its own action's inputs and outputs, trigger inputs and outputs and parameters."* To track a business key (e.g. PONumber) computed by an upstream action, re-derive it from the trigger body in this action's own tracked property, or place the tracked property ON that upstream action. Include the correlation id and the business idempotency key.
- **Enhanced telemetry → App Insights:** the Bicep must wire App Insights + Log Analytics and set the host telemetry settings per `enable-enhanced-telemetry-standard-workflows.md` (this is what `azure-bicep-author` provisions for Article IV). W3C `traceparent` propagation flows automatically when App Insights is enabled.
- **B2B tracking:** for EDI/AS2 flows use B2B transaction tracking (`monitor-track-b2b-transactions-standard.md`).

## 5. Reliability / DR (when NFRs demand it)

- **Zone redundancy:** WS-plan zone redundancy per `set-up-zone-redundancy-availability-zones.md` — enable when the NFR requires it (`azure-bicep-author`).
- **Multi-region DR:** active/passive + replication tasks per `multi-region-disaster-recovery.md` / `create-replication-tasks-azure-resources.md`. Only when an NFR mandates RTO/RPO; otherwise note as out of scope.
- General SLAs and limits: `reliability-logic-apps.md`.

## How the agents use this

- **azure-logic-apps-compiler:** emit `retryPolicy` (§1), the Scope+runAfter DLQ pattern (§2), claim-check for large bodies (§3), and `trackedProperties`/`clientTrackingId` (§4) — grounded in these docs, not invented.
- **azure-reviewer:** verify every external hop has a retry + reaches its DLQ (Article VI) and that correlation id + tracked properties + App Insights wiring exist (Article IV). Cite the relevant `reference/` doc in findings.
- **azure-bicep-author:** App Insights/Log Analytics + telemetry settings (§4); zone redundancy / DR modules when NFRs require (§5).
