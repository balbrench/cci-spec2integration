---
name: logic-app-patterns
description: Reference patterns for common Logic Apps Standard workflow scenarios — HTTP request-response, try-catch with scopes, for-each with concurrency, Service Bus peek-lock, pagination, retry policy authoring, parallel branches. Pattern narratives that sit above the concrete `templates/azure/reference-workflows/` JSON. Consumed alongside `workflow-json-rules` and `logic-apps-planning-rules` by `azure-logic-apps-compiler` when choosing the shape of a flow. Adapted from the AVN-Agents AIS framework.
---

# Logic Apps Standard — Common Workflow Patterns

> **Purpose**: Pattern narratives for the most common workflow shapes. Each pattern names the trigger/action combination and points to the concrete JSON in `templates/azure/reference-workflows/`. Use this skill when *deciding* the shape of a flow; use `workflow-json-rules` for the authoring rules of the resulting `workflow.json`; use `logic-apps-planning-rules` for the prerequisites and component-priority decisions.

---

## 1. HTTP Request-Response

**Use when**: synchronous HTTP API endpoint that processes input and returns a response.

```json
{
  "triggers": {
    "When_a_HTTP_request_is_received": {
      "type": "Request",
      "kind": "Http",
      "inputs": { "schema": {} }
    }
  },
  "actions": {
    "Process": { "type": "Compose" },
    "Response": {
      "type": "Response",
      "inputs": { "statusCode": 200, "body": "@outputs('Process')" },
      "runAfter": { "Process": ["Succeeded"] }
    }
  }
}
```

- Use the `Response` action, not `HTTP` — only `Response` returns to the original caller.
- Place the `Response` inside the main `actions{}`, not inside a Scope (or the caller times out).
- For async-with-status, return `202` + a status URL and use a separate polling endpoint.
- When an `If` / `Condition` branches into different success and rejection payloads, add a branch-local `Compose_<Purpose>` immediately before each `Response` and have the `Response` body point at `@outputs('Compose_<Purpose>')`. Keep the first nested branch action on `runAfter: {}` — the branch boundary already enforces the outer dependency chain.

---

## 2. Try-Catch with Scope

**Use when**: business actions need a deterministic catch path on failure.

```json
{
  "Try_Scope": {
    "type": "Scope",
    "actions": { "/* happy path actions */": {} }
  },
  "Catch_Scope": {
    "type": "Scope",
    "actions": {
      "Log_Error": { "type": "Compose", "inputs": "@result('Try_Scope')" },
      "Error_Response": { "type": "Response", "inputs": { "statusCode": 500 } }
    },
    "runAfter": { "Try_Scope": ["Failed", "TimedOut"] }
  }
}
```

- `runAfter` array on `Catch_Scope` must include every failure status (`Failed`, `TimedOut`, often `Skipped`).
- Use `@result('Try_Scope')` to read every action's status/outputs inside the scope — not `@actions('Try_Scope')`.
- Add a `Finally_Scope` with `runAfter` covering both `Succeeded` and the catch outcomes for cleanup.

---

## 3. For-Each with Concurrency Control

**Use when**: processing an array in parallel up to a bounded concurrency.

```json
{
  "For_each_record": {
    "type": "Foreach",
    "foreach": "@triggerBody()?['records']",
    "actions": { "/* per-item actions */": {} },
    "runtimeConfiguration": {
      "concurrency": { "repetitions": 10 }
    }
  }
}
```

- Default concurrency is **20** repetitions sequential — always set explicit `concurrency.repetitions` for parallelism > 1.
- Cap at the downstream system's safe throughput, not arbitrarily high.
- For sequential ordering, set `concurrency.repetitions: 1`.

---

## 4. Service Bus Peek-Lock

**Use when**: receiving from Service Bus and you need explicit complete/dead-letter on outcome.

- Trigger: `When messages are available in a queue (peek-lock)`.
- On success path: `Complete the message`.
- On failure path: `Dead-letter the message` (inside the catch scope).
- Set the trigger's `splitOn` to `@triggerOutputs()?['body']` so each message is its own run.
- See `templates/azure/reference-workflows/sb-trigger-splitOn/` for the canonical JSON.

---

## 5. Pagination for Large Result Sets

**Use when**: a connector returns paged results (REST API, Dataverse, SharePoint, etc.).

```json
{
  "runtimeConfiguration": {
    "paginationPolicy": { "minimumItemCount": 5000 }
  }
}
```

- Logic Apps automatically follows `nextLink` / continuation tokens.
- `minimumItemCount` is the **floor** — the runtime keeps paging until at least that many items are gathered (or the source runs out).
- Not all connectors support pagination — check the connector reference before relying on it.

---

## 6. Retry Policy Configuration

```json
{
  "retryPolicy": {
    "type": "exponential",
    "count": 4,
    "interval": "PT7S",
    "minimumInterval": "PT5S",
    "maximumInterval": "PT1H"
  }
}
```

Types:

| Type | Behaviour |
|---|---|
| `none` | No retries. Use only when caller already retries or operation is non-idempotent. |
| `fixed` | Fixed `interval` between attempts. |
| `exponential` | Exponential backoff between `minimumInterval` and `maximumInterval`. **Default for transient-error-prone actions.** |

Defaults are 4 retries on `exponential` with 7-second base — override only with a documented reason.

---

## 7. Parallel Branches (Scatter-Gather)

**Use when**: independent actions can run in parallel and you need to merge results.

- Define each branch as a sibling action with the same `runAfter` ancestor.
- Use a `Compose` or `Parse JSON` downstream with `runAfter` covering both branches to aggregate.
- For dynamic parallelism over an array, use For-Each with concurrency (§3) instead.

---

## 8. Long-Running with Webhook Callback

**Use when**: external system processes asynchronously and calls back when done.

- Use the `HTTP Webhook` action — it subscribes, suspends, and resumes on callback.
- The action's `subscribe` block POSTs the registration; the action waits for the callback URL to be invoked.
- Configure `timeout` on the action — Logic Apps Standard supports very long waits (days), but the source system may not.

---

## 9. Conditional Routing

**Use when**: branching based on payload.

- **Single binary condition** → `If` action.
- **Multiple discrete branches** → `Switch` action on a single property.
- **Complex predicates** → `Condition` action with composed expression in `expression.and / or`.

See `templates/azure/reference-workflows/if-condition/` and `templates/azure/reference-workflows/switch/` for canonical JSON.

---

## 10. Observability

- Enable **Application Insights** integration in `host.json` (see `logicapp-cloud-deployment` §2 for the required app settings).
- Set `trackedProperties` on key actions for business-level monitoring (e.g. correlation IDs, partner IDs).
- Use diagnostic settings to send runtime logs to Log Analytics.
- Create Azure Monitor alerts for failed workflow runs and high run duration.

---

## Cross-references

- `.claude/skills/workflow-json-rules/SKILL.md` — authoring rules for `workflow.json` (trigger output verification, splitOn, runAfter, scenario-specific overrides)
- `.claude/skills/logic-apps-planning-rules/SKILL.md` — component-priority ladder (built-in → expression → Compose → Data Mapper → local function)
- `templates/azure/reference-workflows/` — the concrete JSON each pattern compiles to
