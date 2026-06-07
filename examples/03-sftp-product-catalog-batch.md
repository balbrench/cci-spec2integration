# Scheduled Product Catalog Batch Ingestion

## Overview

- Purpose: Ingest a daily product catalog file dropped by a supplier on an SFTP server, validate it, transform each record to the internal product format, and upsert the products into the merchandising system in batches.
- Outcome: The merchandising catalog stays in sync with the supplier's daily feed without manual file handling, with bad records isolated rather than failing the whole file.
- In scope: Scheduled pickup of a delimited catalog file, header/trailer reconciliation, per-record validation and transformation, batched upsert to the product API, archival of the processed file, dead-lettering of rejected records, and a run summary.
- Out of scope: Real-time price changes, image/asset ingestion, supplier onboarding, and any feed other than the daily full catalog.

## Business Context

### Problem Statement

A supplier publishes its full product catalog once per day as a pipe-delimited flat file on an SFTP drop. Today the file is downloaded and loaded by hand, which is slow, error-prone, and fails entirely when a single row is malformed. The business needs an unattended, resumable batch process that loads good records, quarantines bad ones, and reports what happened.

### Success Criteria

- The daily file is picked up automatically within the processing window with no manual steps.
- Valid records are upserted to the merchandising system; invalid records are dead-lettered without aborting the run.
- The declared record count in the trailer matches the number of data records processed, or the run is flagged.
- Every run emits a summary (received, accepted, rejected) and the source file is archived.

## Actors and Systems

| Name | Type | Role |
|---|---|---|
| Supplier | external partner | Publishes the daily catalog file to the SFTP drop |
| SFTP drop | system | Hosts the inbound file and an archive location |
| Catalog ingestion boundary | system | Picks up, validates, transforms, and loads the file |
| Merchandising system | system | Receives upserted products via its product API |
| Catalog operations team | human | Reviews rejected records and run summaries |

## Triggers and Flow Summary

| Flow | Trigger | Source | Destination | Frequency / Volume |
|---|---|---|---|---|
| Catalog ingestion | Scheduled poll of the SFTP drop | Supplier SFTP file | Merchandising product API | Daily; ~50,000–200,000 records per file |
| Rejected-record handling | A record fails validation | Catalog ingestion boundary | Dead-letter store | Per invalid record |
| Run summary | End of a processing run | Catalog ingestion boundary | Operations notification channel | One per run |

## Input and Output Contracts

### Inbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| Catalog file pickup | SFTP (polled) | flat-file (delimited) | text/plain; UTF-8; CRLF | One file per day; filename pattern `CATALOG_YYYYMMDD.psv` [ASSUMPTION: filename carries the business date] |

### Outbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| Product upsert | HTTP | JSON | application/json; UTF-8 | Batched calls to the product API |
| Processed-file archive | SFTP | flat-file | as received | File moved to an archive folder after processing |
| Run summary notification | HTTP or email | JSON or text | application/json; UTF-8 | Counts and a link to the dead-letter store |

## Payload Definitions

### Inbound Payloads

The inbound payload is a delimited flat file; see the layout section below for positional detail. Each data record maps to the product structure consumed by the upsert.

### Outbound Payloads

#### Product Upsert Record

| Field | Type | Required | Destination | Rules / Notes |
|---|---|---|---|---|
| sku | string | yes | Product API | Idempotency key for the upsert |
| name | string | yes | Product API | Trimmed; non-empty |
| category | string | yes | Product API | Mapped from supplier category code |
| price | number | yes | Product API | Parsed from string; must be ≥ 0 |
| currency | string | yes | Product API | ISO-4217; defaulted to `USD` if blank [ASSUMPTION: USD default is acceptable] |
| active | boolean | yes | Product API | Derived from status flag (`A` → true, `D` → false) |
| effectiveDate | date | yes | Product API | ISO-8601, parsed from `YYYYMMDD` |

Example (single upsert record):

```json
{
  "sku": "WIDGET-BLUE-240",
  "name": "Blue Widget 240ct",
  "category": "widgets",
  "price": 3.25,
  "currency": "USD",
  "active": true,
  "effectiveDate": "2026-06-06"
}
```

## Flat-File or Delimited Layouts

### Supplier Catalog File

- Format style: delimited
- Character encoding: UTF-8
- Line ending: CRLF
- Header record: yes (one)
- Trailer record: yes (one)
- Delimiter: pipe (`|`)
- Quote character: double quote (`"`), used only when a field contains the delimiter

| Record / Segment | Field | Start | Length | Delimiter Position | Type | Required | Rules / Notes |
|---|---|---|---|---|---|---|---|
| Header (`H`) | recordType | — | — | 1 | string | yes | Literal `H` |
| Header (`H`) | feedDate | — | — | 2 | date | yes | `YYYYMMDD`; must match filename date |
| Header (`H`) | supplierId | — | — | 3 | string | yes | Must match the configured supplier |
| Data (`D`) | recordType | — | — | 1 | string | yes | Literal `D` |
| Data (`D`) | sku | — | — | 2 | string | yes | Non-empty; unique within file |
| Data (`D`) | name | — | — | 3 | string | yes | Non-empty |
| Data (`D`) | categoryCode | — | — | 4 | string | yes | Mapped to internal category |
| Data (`D`) | priceText | — | — | 5 | string | yes | Numeric; ≥ 0 |
| Data (`D`) | currency | — | — | 6 | string | no | ISO-4217 or blank |
| Data (`D`) | statusFlag | — | — | 7 | string | yes | `A` or `D` |
| Data (`D`) | effectiveDate | — | — | 8 | date | yes | `YYYYMMDD` |
| Trailer (`T`) | recordType | — | — | 1 | string | yes | Literal `T` |
| Trailer (`T`) | recordCount | — | — | 2 | integer | yes | Count of `D` records; must reconcile |

Sample:

```text
H|20260606|SUPP-001
D|WIDGET-BLUE-240|Blue Widget 240ct|WGT|3.25|USD|A|20260606
D|WIDGET-RED-120|Red Widget 120ct|WGT|3.25||A|20260606
T|2
```

## Functional Requirements

- FR-001: The integration shall poll the SFTP drop on a schedule and pick up a catalog file matching the expected filename pattern.
- FR-002: The integration shall parse the header, data, and trailer records using the declared delimited layout.
- FR-003: The integration shall reconcile the trailer `recordCount` against the number of data records and flag a mismatch.
- FR-004: The integration shall validate each data record and transform valid records into the product upsert format.
- FR-005: The integration shall upsert valid records to the product API in batches, keyed by `sku`.
- FR-006: The integration shall route each invalid record to a dead-letter store with the reason and original line, without aborting the run.
- FR-007: The integration shall archive the source file after processing and emit a run summary with received, accepted, and rejected counts.

## Validation and Business Rules

- File-level: the header `feedDate` must match the filename date; the `supplierId` must match the configured supplier; the trailer count must equal the number of data records.
- Record-level: `sku` and `name` non-empty; `priceText` parses to a number ≥ 0; `statusFlag` is `A` or `D`; `effectiveDate` parses as a valid date.
- Deduplication: a duplicate `sku` within a single file is rejected as a duplicate (first occurrence wins). [ASSUMPTION: first-occurrence-wins is acceptable for intra-file duplicates.]
- Idempotency: upsert is keyed by `sku`; re-processing the same file produces the same end state.
- Transformation: supplier `categoryCode` is mapped to an internal category; blank currency defaults to `USD`; `statusFlag` maps to the `active` boolean.

## Error Handling

- Expected validation failures: a malformed or out-of-range record is dead-lettered with its line number and the failing rule; the run continues.
- File-level failure: a trailer count mismatch flags the run for review but still processes valid records [ASSUMPTION: a count mismatch is a warning, not a hard stop — to be confirmed].
- Expected integration failures: transient product API errors are retried with backoff per batch; a batch that still fails is dead-lettered as a unit with its records.
- Missing file: if no file is present in the processing window, the run logs a no-file outcome and notifies operations.
- Error response contract: dead-letter entries carry the original line, the parsed record (if available), the failing rule, and a correlation id.

## Non-Functional Requirements

- Performance / throughput: process a 200,000-record file within the processing window; batch size tuned to the product API's limits.
- Availability / SLA: the daily file must be fully processed before the start of business [ASSUMPTION: start of business is 06:00 local].
- Security / identity: SFTP access uses key-based authentication; keys are referenced from a secret store, never inline. Product API access uses a managed identity or a stored credential reference.
- Data classification / compliance: internal. Catalog data is commercially sensitive but not personal.
- Observability: a per-run correlation id is logged with the file name, counts, and outcome; each batch call is logged.
- Retention / archival: processed files retained in the archive for 90 days; dead-letter records retained for 30 days. [ASSUMPTION: 90/30-day retention is acceptable.]

## Dependencies and External Constraints

- SFTP server reachability and credentials for both the inbound drop and the archive folder.
- The merchandising product API, its batch-size limits, and its authentication model.
- A supplier-category-to-internal-category mapping table.
- A dead-letter store and an operations notification channel.

## Assumptions and Open Questions

### Assumptions

- [ASSUMPTION: filename carries the business date as `CATALOG_YYYYMMDD.psv`.]
- [ASSUMPTION: USD is an acceptable default when currency is blank.]
- [ASSUMPTION: first-occurrence-wins is acceptable for intra-file duplicate SKUs.]
- [ASSUMPTION: a trailer count mismatch is a warning, not a hard stop.]
- [ASSUMPTION: the full file must be processed before 06:00 local start of business.]
- [ASSUMPTION: 90-day file archive and 30-day dead-letter retention are acceptable.]

### Open Questions

- OQ-001: What is the maximum batch size the product API accepts per call, and is there a rate limit?
- OQ-002: Is the feed a full catalog each day (records absent from the file should be deactivated) or incremental (only changed records present)?
- OQ-003: Should a trailer count mismatch hard-stop the run, or continue with valid records and flag?
- OQ-004: What is the authoritative supplier-category-to-internal-category mapping, and how is it maintained?
