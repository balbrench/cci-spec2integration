---
name: ears-requirements
description: Authoritative notation for writing spec.md functional requirements in EARS (Easy Approach to Requirements Syntax) — the five trigger→response patterns, the RFC-2119 keyword that sets each requirement's level (SHALL/MUST, SHOULD, MAY), one keyword per FR, and free-form→EARS rewrites. EARS-shaped FRs trace mechanically to IR constructs in spec-coverage-checker and let the reconciler quote the exact at-risk behaviour. Consumed by requirements-analyst and biztalk-spec-author when writing or enriching FRs, and by spec-coverage-checker when parsing them. NFRs are out of scope — they stay measured thresholds.
---

# ears-requirements skill

Every **functional requirement** in `spec.md` is written as one EARS statement: an optional trigger or condition, then the system's observable response. Free-form prose ("duplicate submissions should be handled") is neither testable nor traceable; an EARS statement ("IF a submission repeats an `orderId` already accepted THEN THE SYSTEM SHALL reject it without creating a second order") names both the trigger and the response, so `spec-coverage-checker` can match it to an IR construct and a tester can write a case for it.

EARS was introduced by Mavin et al. at Rolls-Royce (RE'09). This skill adapts it to RFC-2119 requirement levels.

## The five patterns

| Pattern | Template | Use when |
|---|---|---|
| **Ubiquitous** | `THE SYSTEM SHALL <response>.` | The behaviour always holds, with no trigger. |
| **Event-driven** | `WHEN <trigger> THE SYSTEM SHALL <response>.` | Something arrives or happens (a message, a file, a schedule tick, a call). The most common pattern in integrations. |
| **State-driven** | `WHILE <state> THE SYSTEM SHALL <response>.` | The behaviour applies for as long as a condition holds (a dependency is down, a batch window is open). |
| **Unwanted behaviour** | `IF <condition> THEN THE SYSTEM SHALL <response>.` | Failures, invalid input, duplicates, timeouts. Every error path gets one of these. |
| **Optional feature** | `WHERE <feature is present> THE SYSTEM SHALL <response>.` | Behaviour that applies only when a configured feature or variant is in use. |

Patterns can be combined when one trigger is not enough, keeping the keyword order WHERE → WHILE → WHEN / IF: `WHILE the CRM is unavailable, WHEN an order arrives THE SYSTEM SHALL queue it for redelivery.`

## Requirement level — the keyword in the SHALL slot

Classic EARS uses only `SHALL`. This pipeline also needs SHOULD- and MAY-level requirements, so the EARS structure stays fixed and the **RFC-2119 keyword** in the response position sets the level:

| Keyword | Level | Coverage-checker severity if unsatisfied |
|---|---|---|
| `SHALL`, `SHALL NOT`, `MUST`, `MUST NOT` | MUST | Sev-1 `FR_NOT_SATISFIED` |
| `SHOULD`, `SHOULD NOT` | SHOULD | Sev-2 `FR_NOT_SATISFIED_SOFT` |
| `MAY` | MAY | none (advisory) |

Prefer `SHALL` for mandatory behaviour; `MUST` is accepted as an equivalent.

## Rules

1. **One keyword per FR.** A requirement with two responses ("SHALL validate and SHALL publish") becomes two FRs. Compound requirements hide partial satisfaction.
2. **Uppercase keywords** (`WHEN`, `WHILE`, `IF … THEN`, `WHERE`, `THE SYSTEM`, `SHALL`). The checker matches keywords case-sensitively, so lowercase `shall` is not a requirement keyword.
3. **Observable trigger and response.** Name the message, file, endpoint, or schedule that triggers the behaviour and the concrete effect the system produces. Avoid "handle", "support", "manage", and "process" on their own; say what the system does.
4. **Name the business key and the target.** For idempotency, name the key (`orderId`). For a transform, name the source and target messages (`Order` → `OrderAccepted`). These names are what the coverage checker's rules match.
5. **The id markup does not change.** Keep `FR-N.` (or `**FR-N.**`), the numbering, and the trailing `[PRD: <quote>]` / `[source: …]` citation exactly as before. EARS changes only the requirement text.
6. **NFRs stay measured thresholds** — throughput, latency, availability, retention, and compliance are numbers or standards, not WHEN/THEN behaviours. Do not force them into EARS.
7. **Do not invent triggers.** If the source doesn't say what triggers a behaviour, write an `OQ-N` rather than guessing a WHEN clause.

## Free-form → EARS examples

| Free-form | EARS |
|---|---|
| Orders are received over HTTP. | `WHEN a client POSTs an Order to /orders THE SYSTEM SHALL accept it and return 202 with the orderId.` |
| Duplicate submissions should be handled. | `IF an Order repeats an orderId already accepted THEN THE SYSTEM SHALL return the original result without creating a second order.` |
| Transform the order for the warehouse. | `WHEN an Order is accepted THE SYSTEM SHALL transform it into a WarehouseOrder and publish it to the warehouse-orders topic.` |
| Failed messages go to an error queue. | `IF delivery to the warehouse fails after the retry policy is exhausted THEN THE SYSTEM SHALL move the message to the dead-letter queue.` |
| Nightly sync of customers. | `WHEN the 02:00 UTC schedule fires THE SYSTEM SHALL copy customers changed since the last run from the CRM to the warehouse.` |
| Late files can be picked up next time. | `IF a batch file arrives after the cut-off THEN THE SYSTEM SHOULD process it in the next window.` |
| Supports the express-shipping variant. | `WHERE express shipping is enabled THE SYSTEM SHALL route express orders to the priority queue.` |

## How the pipeline uses EARS

- **`spec-coverage-checker`** records each FR's EARS pattern and its **response clause** (the text after the keyword), and runs its forward-trace rules against the response first. "SHALL reject it without creating a second order" matches `R-IDEMPOTENT`; "SHALL move the message to the dead-letter queue" matches `R-DLQ`. Full prose often matches nothing and falls to `MANUAL_TRACE_REQUIRED`.
- **The reconciler** (`/reconcile`) quotes the EARS trigger→response when it reports a requirement that the IR satisfies but no deployed artifact implements, so the at-risk behaviour is explicit.
- **Existing specs** keep parsing. EARS applies to newly written or enriched FRs; free-form FRs are not migrated.
