# Flat-File Sales Transactions ETL to Warehouse

## Overview

- Purpose: Bulk-load large fixed-width sales transaction files dropped daily by store point-of-sale systems into the analytics data warehouse, applying column-level transformation and tolerating minor layout drift, as a scheduled ETL pipeline.
- Outcome: A reliable, restartable daily load that turns raw positional sales files into a clean, query-ready warehouse sales fact table partitioned by business date and store, with full control-total reconciliation.
- In scope: Scheduled discovery of one or more inbound flat files, parsing of a fixed-width header/detail/trailer layout, control-total reconciliation, column-level transformation and type conversion, partitioned bulk load into the warehouse fact table, quarantine of rejected rows, schema-drift tolerance for appended optional columns, and a per-file load report.
- Out of scope: Real-time/streaming sales capture, the POS systems themselves, downstream reporting/marts built on the fact table, master-data management of stores/products, and any file format other than the agreed fixed-width sales layout.

## Business Context

### Problem Statement

Each store's point-of-sale system exports the prior day's sales as a large fixed-width flat file. Volumes are far too high for record-by-record API ingestion, the files occasionally gain a new trailing field when POS software is upgraded, and a failed or partial load currently corrupts the day's numbers. The business needs a bulk ETL pipeline that loads millions of rows per night, reconciles against each file's control totals, isolates bad rows without failing the whole file, survives layout drift, and can be safely re-run to reproduce a day's partition exactly.

### Success Criteria

- All of a night's store files are loaded before the reporting window opens.
- Each file's loaded row count and monetary total reconcile to its trailer control totals, or the file is flagged and its partition is not published.
- A re-run of the same file reproduces the same warehouse partition with no duplicates (idempotent by business date + store).
- A POS layout change that only appends a new optional field does not break the load.
- Rejected rows are quarantined with a reason; the rest of the file still loads.

## Actors and Systems

| Name | Type | Role |
|---|---|---|
| Store POS systems | external | Export daily fixed-width sales files to the landing location |
| File landing store | system | Hosts inbound files and an archive/quarantine area |
| ETL pipeline | system | Discovers, parses, reconciles, transforms, and bulk-loads the files |
| Data warehouse | system | Destination sales fact table, partitioned by business date and store |
| Data platform team | human | Monitors loads, reviews quarantined rows and reconciliation failures |

## Triggers and Flow Summary

| Flow | Trigger | Source | Destination | Frequency / Volume |
|---|---|---|---|---|
| Daily sales load | Scheduled run (and/or file-arrival) after the nightly export window | Store POS flat files | Warehouse sales fact table | Daily; ~200–2,000 files/night, 1M–50M rows total |
| Row quarantine | A detail row fails validation | ETL pipeline | Quarantine table | Per invalid row |
| Load report | End of each file's load | ETL pipeline | Data platform notification channel | One per file (plus a run rollup) |

## Input and Output Contracts

### Inbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| Sales file landing | File drop (polled or event-on-arrival) | flat-file (fixed-width) | text/plain; UTF-8; CRLF | One file per store per business day; filename pattern `SALES_<storeId>_YYYYMMDD.dat` [ASSUMPTION: store id and business date are encoded in the filename] |

### Outbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| Warehouse bulk load | Bulk load into the warehouse fact table (via staging) | Tabular | UTF-8 | Partition-scoped overwrite keyed by `businessDate` + `storeId` |
| Processed-file archive | File move | flat-file | as received | File moved to a dated archive path after a successful, reconciled load |
| Quarantine write | Append to a quarantine table/store | Tabular / JSON | UTF-8 | Rejected rows with reason, source line number, and file id |
| Load report | HTTP or email | JSON or text | application/json; UTF-8 | Counts, control-total comparison, partition published yes/no |

## Payload Definitions

### Inbound Payloads

The inbound payload is a fixed-width flat file with three record types (header, detail, trailer); see the layout section below for positions. The detail record maps to one warehouse fact row.

### Outbound Payloads

#### Warehouse Sales Fact Row

| Field | Type | Required | Destination | Rules / Notes |
|---|---|---|---|---|
| businessDate | date | yes | Fact table (partition key) | From the header `businessDate` |
| storeId | string | yes | Fact table (partition key) | From the header `storeId`; must match filename |
| transactionId | string | yes | Fact table | From detail; unique within file |
| lineNumber | integer | yes | Fact table | From detail; transaction line sequence |
| productCode | string | yes | Fact table | Trimmed; mapped to warehouse product key where possible |
| quantity | number | yes | Fact table | Parsed from implied-decimal field; may be negative for returns |
| unitPrice | number | yes | Fact table | Parsed from implied-decimal field (2 dp) |
| lineAmount | number | yes | Fact table | Validated: `quantity * unitPrice` within tolerance |
| currency | string | yes | Fact table | ISO-4217; from header |
| paymentType | string | yes | Fact table | Mapped from POS code (e.g. `01` → `cash`, `02` → `card`) |
| loadRunId | string | yes | Fact table | Correlates rows to the load that produced them |
| sourceFileId | string | yes | Fact table | Lineage back to the source file |

Example (single fact row):

```json
{
  "businessDate": "2026-06-05",
  "storeId": "S-0427",
  "transactionId": "T-99183",
  "lineNumber": 1,
  "productCode": "WIDGET-BLUE-240",
  "quantity": 2,
  "unitPrice": 3.25,
  "lineAmount": 6.50,
  "currency": "USD",
  "paymentType": "card",
  "loadRunId": "run-20260606-0200",
  "sourceFileId": "SALES_S-0427_20260605.dat"
}
```

## Flat-File or Delimited Layouts

### Store Sales File

- Format style: fixed-width
- Character encoding: UTF-8
- Line ending: CRLF
- Header record: yes (one, first line)
- Trailer record: yes (one, last line)
- Delimiter: none (positional)
- Quote character: not applicable
- Record discriminator: position 1 (`H` header, `D` detail, `T` trailer)
- Implied decimals: monetary and quantity fields carry no decimal point; the rightmost 2 digits are decimals (e.g. `0000000650` → `6.50`)
- Schema drift: a POS upgrade may append a new optional field to the **end** of the detail record; unknown trailing positions must be ignored, not rejected [ASSUMPTION: drift is append-only at end-of-record]

| Record / Segment | Field | Start | Length | Type | Required | Rules / Notes |
|---|---|---|---|---|---|---|
| Header (`H`) | recordType | 1 | 1 | string | yes | Literal `H` |
| Header (`H`) | storeId | 2 | 8 | string | yes | Left-justified, space-padded; must match filename |
| Header (`H`) | businessDate | 10 | 8 | date | yes | `YYYYMMDD`; must match filename |
| Header (`H`) | currency | 18 | 3 | string | yes | ISO-4217 |
| Detail (`D`) | recordType | 1 | 1 | string | yes | Literal `D` |
| Detail (`D`) | transactionId | 2 | 12 | string | yes | Unique within file |
| Detail (`D`) | lineNumber | 14 | 4 | integer | yes | Zero-padded |
| Detail (`D`) | productCode | 18 | 20 | string | yes | Right-trimmed |
| Detail (`D`) | quantity | 38 | 8 | number | yes | Signed implied-decimal (2 dp); negative = return |
| Detail (`D`) | unitPrice | 46 | 10 | number | yes | Implied-decimal (2 dp) |
| Detail (`D`) | lineAmount | 56 | 12 | number | yes | Implied-decimal (2 dp) |
| Detail (`D`) | paymentTypeCode | 68 | 2 | string | yes | Mapped to `paymentType` |
| Trailer (`T`) | recordType | 1 | 1 | string | yes | Literal `T` |
| Trailer (`T`) | detailCount | 2 | 10 | integer | yes | Count of `D` records; must reconcile |
| Trailer (`T`) | amountTotal | 12 | 15 | number | yes | Implied-decimal (2 dp); sum of `lineAmount`; must reconcile |

Sample (positions shown by value, not to scale):

```text
HS-0427  20260605USD
DT-99183    0001WIDGET-BLUE-240     0000000200000003250000000006502
DT-99183    0002WIDGET-RED-120      0000000100000003250000000003251
T0000000002000000000000975
```

## Functional Requirements

- FR-001: The integration shall run on a schedule (and/or on file arrival) and discover all sales files for the target business day in the landing location.
- FR-002: The integration shall parse each file's fixed-width header, detail, and trailer records using the declared positional layout.
- FR-003: The integration shall ignore unknown trailing fields appended to the detail record (append-only schema drift) rather than rejecting the row.
- FR-004: The integration shall validate and transform each detail row into the warehouse fact row, converting implied-decimal numerics, mapping payment codes, and stamping lineage (`loadRunId`, `sourceFileId`).
- FR-005: The integration shall reconcile the parsed detail row count and summed `lineAmount` against the trailer `detailCount` and `amountTotal`.
- FR-006: The integration shall bulk-load the transformed rows into the warehouse fact table using a partition-scoped overwrite keyed by `businessDate` + `storeId`, so a re-run reproduces the partition without duplicates.
- FR-007: The integration shall publish a file's partition only when reconciliation passes; on a reconciliation failure it shall flag the file and withhold publication.
- FR-008: The integration shall quarantine each invalid detail row with a reason and source line number without aborting the file, and archive the source file after a successful, reconciled load.
- FR-009: The integration shall emit a per-file load report (rows read, loaded, rejected; trailer vs computed totals; partition published yes/no) and a nightly run rollup.

## Validation and Business Rules

- File-level: header `storeId`/`businessDate` must match the filename; trailer `detailCount` must equal the number of detail rows; trailer `amountTotal` must equal the summed `lineAmount` within tolerance.
- Record-level: required positional fields present and the correct type; implied-decimal fields parse to numbers; `paymentTypeCode` maps to a known `paymentType`; `lineAmount` equals `quantity * unitPrice` within a rounding tolerance.
- Idempotency: the load is a partition-scoped overwrite keyed by `businessDate` + `storeId`; re-processing the same file yields an identical partition. File-level reprocessing is the unit of replay.
- Schema drift: trailing detail fields beyond the known layout are ignored; a change to the position/length of an existing field is a hard failure, not drift.
- Late/duplicate files: a re-delivered file for an already-loaded `businessDate` + `storeId` overwrites that partition (latest wins). [ASSUMPTION: latest-file-wins is the correct policy for re-sent files.]
- Currency/code mapping: `paymentTypeCode` → `paymentType` and `productCode` → warehouse product key are driven by reference tables; an unmapped product code loads with the raw code and is flagged, while an unmapped payment code rejects the row. [ASSUMPTION: unmapped product is tolerable; unmapped payment is not.]

## Error Handling

- Expected validation failures: a malformed or out-of-range detail row is written to quarantine with its source line number, the file id, and the failing rule; the file continues loading.
- Reconciliation failure: when trailer totals do not match the computed totals, the file's partition is not published, the file is flagged for review, and the run report records the discrepancy.
- Layout failure: a structural mismatch (wrong record length for a non-drift reason, missing header/trailer) fails the whole file and routes it to quarantine intact.
- Expected integration failures: a transient landing-read or warehouse-load error is retried with backoff; an exhausted retry fails that file cleanly, leaving any prior partition untouched and the file unarchived for safe re-run.
- Partial-load safety: rows are bulk-loaded to a staging area and swapped into the published partition atomically, so a mid-load failure never exposes partial numbers to reporting. [ASSUMPTION: staging-then-swap (or transactional partition switch) is available in the warehouse.]
- Error response contract: quarantine entries and the load report carry the file id, business date, store id, failing rule/step, control-total comparison, and a correlation id.

## Non-Functional Requirements

- Performance / throughput: load up to ~50M rows across ~2,000 files within the nightly window; files load in parallel and rows load in partitioned bulk batches sized to the warehouse's bulk-load limits.
- Availability / SLA: all files for a business day must be loaded and reconciled before the reporting window opens. [ASSUMPTION: reporting opens at 06:00 local.]
- Security / identity: landing-store and warehouse access use managed identity with least-privilege; no inline credentials. Write access scoped to the staging area and the target fact table only.
- Data classification / compliance: confidential. Sales data is commercially sensitive; it contains no cardholder data (POS exports tokenized payment type only, never card numbers) and no customer PII. [ASSUMPTION: files contain no PII or raw card data.]
- Observability: a per-run `loadRunId`/correlation id is logged and stamped on every loaded row; structured logs at discover, parse, reconcile, load, and publish for each file; counts and reconciliation status emitted as metrics.
- Retention / archival: processed files archived for 1 year for audit and re-load; quarantine rows retained for 90 days; warehouse partition retention governed by the warehouse policy. [ASSUMPTION: 1-year archive and 90-day quarantine retention are acceptable.]

## Dependencies and External Constraints

- A file landing store reachable by the ETL pipeline, with archive and quarantine areas.
- The warehouse fact table, its partitioning scheme, its bulk-load mechanism, and atomic staging/partition-swap capability.
- Reference tables for `paymentTypeCode` → `paymentType` and `productCode` → warehouse product key.
- An agreed, versioned fixed-width layout per POS software version, with the append-only drift contract.

## Assumptions and Open Questions

### Assumptions

- [ASSUMPTION: store id and business date are encoded in the filename `SALES_<storeId>_YYYYMMDD.dat`.]
- [ASSUMPTION: schema drift is append-only at end-of-record; existing field positions never move.]
- [ASSUMPTION: latest-file-wins for a re-sent file of an already-loaded business date + store.]
- [ASSUMPTION: an unmapped product code is tolerable (load + flag); an unmapped payment code rejects the row.]
- [ASSUMPTION: staging-then-swap / transactional partition switch is available for partial-load safety.]
- [ASSUMPTION: the reporting window opens at 06:00 local, bounding the load SLA.]
- [ASSUMPTION: files contain no PII or raw card data.]
- [ASSUMPTION: 1-year file archive and 90-day quarantine retention are acceptable.]

### Open Questions

- OQ-001: What is the exact monetary tolerance for `lineAmount = quantity * unitPrice` and for trailer-total reconciliation (exact match, or rounding tolerance)?
- OQ-002: Are partial-day partitions ever published (some stores late), or is publication all-or-nothing per business date?
- OQ-003: How is the fixed-width layout versioned across POS releases, and how is a true layout change (not append-only) signalled in advance?
- OQ-004: What partition granularity and bulk-load batch size does the warehouse support at the 50M-row peak?
- OQ-005: Should an unreconciled file block the whole nightly run's rollup status, or only its own partition?
