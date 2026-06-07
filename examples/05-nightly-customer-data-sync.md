# Nightly Customer Data Warehouse Sync

## Overview

- Purpose: Move changed customer records from the operational customer system into the analytics data warehouse every night, incrementally, so reporting reflects the prior day's changes.
- Outcome: Analysts query a warehouse that is at most one day stale, without queries hitting (and slowing) the operational system, and without re-copying the entire customer base each night.
- In scope: A scheduled incremental extract of customer records changed since the last successful run, type and shape transformation to the warehouse model, bulk load into the warehouse staging area, watermark advancement, and a load report.
- Out of scope: Real-time/streaming sync, downstream reporting/dashboards, master-data deduplication across systems, and any entity other than customer.

## Business Context

### Problem Statement

Reporting currently runs against the operational customer database, degrading transactional performance, and ad-hoc full copies are slow and expensive. The business needs a reliable nightly, incremental bulk movement of customer changes into the warehouse that is restartable and idempotent, so a failed or partial run can simply be re-run.

### Success Criteria

- Each night, only customer records changed since the last successful run are moved.
- A failed run can be re-run without producing duplicate or partial warehouse state.
- The warehouse reflects the prior day's customer changes before the reporting window opens.
- Every run records how many records were extracted, loaded, and rejected.

## Actors and Systems

| Name | Type | Role |
|---|---|---|
| Operational customer system | system | Source of customer records; exposes a change-queryable interface |
| Data sync boundary | system | Orchestrates extract, transform, bulk load, and watermark management |
| Data warehouse | system | Destination staging area for loaded customer records |
| Data platform team | human | Monitors run health, investigates rejects, manages the watermark |

## Triggers and Flow Summary

| Flow | Trigger | Source | Destination | Frequency / Volume |
|---|---|---|---|---|
| Incremental customer sync | Nightly schedule | Operational customer system | Data warehouse staging | Daily; ~50,000–500,000 changed records depending on activity |
| Load report | End of run | Data sync boundary | Data platform notification channel | One per run |

## Input and Output Contracts

### Inbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| Customer change extract | Database query or bulk export endpoint | Tabular / JSON rows | UTF-8 | Filtered by `lastModified > watermark`; read replica preferred [ASSUMPTION: a read replica or export endpoint is available to avoid loading the primary] |

### Outbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| Warehouse bulk load | Bulk load into the warehouse staging table | Tabular | UTF-8 | Set-based upsert keyed by `customerKey` |
| Load report | HTTP or email | JSON or text | application/json; UTF-8 | Counts, watermark before/after, duration |

## Payload Definitions

### Inbound Payloads

#### Source Customer Record

| Field | Type | Required | Source | Rules / Notes |
|---|---|---|---|---|
| customer_id | string | yes | Operational system | Natural key |
| first_name | string | no | Operational system | PII |
| last_name | string | no | Operational system | PII |
| email | string | no | Operational system | PII; format-validated when present |
| country_code | string | yes | Operational system | ISO-3166 alpha-2 |
| status_code | string | yes | Operational system | Source status enumeration |
| created_ts | date-time | yes | Operational system | Source create timestamp |
| modified_ts | date-time | yes | Operational system | Drives the incremental watermark |

### Outbound Payloads

#### Warehouse Customer Row

| Field | Type | Required | Destination | Rules / Notes |
|---|---|---|---|---|
| customerKey | string | yes | Warehouse staging | Maps from `customer_id`; upsert key |
| firstName | string | no | Warehouse staging | From `first_name`; PII |
| lastName | string | no | Warehouse staging | From `last_name`; PII |
| emailDomain | string | no | Warehouse staging | Derived from `email` (domain only) to limit PII in the warehouse [ASSUMPTION: only the email domain is needed for analytics] |
| country | string | yes | Warehouse staging | From `country_code`; validated |
| status | string | yes | Warehouse staging | Mapped from `status_code` to the warehouse enumeration |
| createdAt | date-time | yes | Warehouse staging | From `created_ts` |
| modifiedAt | date-time | yes | Warehouse staging | From `modified_ts` |
| loadRunId | string | yes | Warehouse staging | Correlates rows to the run that loaded them |

Example (single warehouse row):

```json
{
  "customerKey": "CUST-9931",
  "firstName": "Jo",
  "lastName": "Diaz",
  "emailDomain": "example.com",
  "country": "US",
  "status": "active",
  "createdAt": "2025-01-12T09:03:00Z",
  "modifiedAt": "2026-06-05T22:41:00Z",
  "loadRunId": "run-20260606-0200"
}
```

## Functional Requirements

- FR-001: The integration shall run on a nightly schedule and read the last successful watermark before extracting.
- FR-002: The integration shall extract only customer records whose `modified_ts` is greater than the stored watermark.
- FR-003: The integration shall transform each source record into the warehouse row model, mapping types, codes, and deriving the email domain.
- FR-004: The integration shall bulk-load the transformed rows into the warehouse staging area using a set-based upsert keyed by `customerKey`.
- FR-005: The integration shall advance the watermark to the maximum `modified_ts` processed only after a successful load.
- FR-006: The integration shall be restartable: a re-run after failure must not duplicate rows or skip changes.
- FR-007: The integration shall emit a load report with extracted, loaded, and rejected counts and the watermark before and after.

## Validation and Business Rules

- Watermark integrity: the watermark advances only on a fully successful load; a failed load leaves the watermark unchanged so the next run re-reads the same window.
- Idempotency: the load is an upsert keyed by `customerKey`; reloading the same window yields the same warehouse state.
- Record validation: `customer_id`, `country_code`, `status_code`, and `modified_ts` must be present; `email`, when present, must be well-formed before its domain is derived.
- Code mapping: `status_code` maps to the warehouse `status` enumeration; an unmapped status routes the record to rejects.
- Data minimization: only the email domain (not the full address) is loaded into the warehouse.

## Error Handling

- Expected validation failures: a record missing a required field or carrying an unmapped status is written to a rejects table with the reason; the run continues.
- Expected integration failures: a transient source-read or warehouse-load failure is retried with backoff; an exhausted retry fails the run cleanly, leaving the watermark unchanged for a safe re-run.
- Partial-load safety: the load is staged so a mid-run failure does not leave partially-applied state visible to reporting. [ASSUMPTION: a staging-then-swap or transactional batch is available in the warehouse.]
- Error response contract: the load report links to the rejects table and includes the failing step and a correlation id when the run fails.

## Non-Functional Requirements

- Performance / throughput: complete a 500,000-record incremental load within the nightly window; load in batches sized to the warehouse's bulk-load limits.
- Availability / SLA: the load must complete before the reporting window opens. [ASSUMPTION: reporting opens at 06:00 local.]
- Security / identity: source and warehouse connections use managed identity; no inline credentials. Read-replica/least-privilege access on the source.
- Data classification / compliance: confidential. Customer names and email are PII; only the email domain is persisted to the warehouse, and full names are loaded only into the controlled warehouse, never to any public channel.
- Observability: a per-run `loadRunId`/correlation id is logged and stamped on every loaded row; structured logs at extract, transform, load, and watermark advance.
- Retention / archival: rejects retained for 30 days; warehouse staging retention governed by the warehouse policy. [ASSUMPTION: 30-day rejects retention is acceptable.]

## Dependencies and External Constraints

- A change-queryable source interface (read replica or export endpoint) exposing `modified_ts`.
- The warehouse staging area, its bulk-load mechanism, and its upsert/transactional capabilities.
- A durable store for the watermark and the rejects.
- A status-code-to-warehouse-status mapping table.

## Assumptions and Open Questions

### Assumptions

- [ASSUMPTION: a read replica or export endpoint is available to avoid loading the primary database.]
- [ASSUMPTION: only the email domain is needed for analytics, so the full address is not persisted to the warehouse.]
- [ASSUMPTION: a staging-then-swap or transactional batch is available in the warehouse for partial-load safety.]
- [ASSUMPTION: the reporting window opens at 06:00 local, which bounds the load completion SLA.]
- [ASSUMPTION: 30-day rejects retention is acceptable.]

### Open Questions

- OQ-001: Are hard deletes in the source in scope (must the warehouse reflect deleted customers), or is this change/insert only?
- OQ-002: Is the watermark based on `modified_ts` reliable, or are out-of-order/clock-skew updates possible that require a safety overlap window?
- OQ-003: What is the authoritative `status_code` → warehouse `status` mapping?
- OQ-004: What batch size and parallelism does the warehouse bulk load support for the peak volume?
