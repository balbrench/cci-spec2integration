# Example PRDs

These are sample **Product Requirement Documents** — the platform-neutral entry point to the greenfield pipeline. Each one is a ready-to-use input for `/specify` (or `/run-pipeline --mode greenfield`), and together they exercise the breadth of integration archetypes the pipeline supports.

## How a PRD fits the pipeline

A PRD is the *only* artifact that precedes specification. Everything downstream is derived from it:

```
PRD  →  /specify   → spec.md
        /clarify   → clarifications.md   (loop until closed)
        /model     → data-model.md
        /contracts → contracts/          (OpenAPI + AsyncAPI + JSON Schema)
        /map       → mappings/           (platform-neutral STM + IR mappings)
        /architect → integration-ir.yaml (vendor-neutral, EIP-aligned)
        /review    → review-report.md     (constitution audit)
        /plan      → plan.md
        /tasks     → tasks.md
        /implement-azure → deployable artifacts
```

A PRD is **platform-neutral** by design — no Azure / AWS / Logic Apps / queue / topic vocabulary (see `templates/core/prd.md` and the `prd-author` agent). Platform selection happens later, at `/platform`. The PRD's job is to surface enough about *interfaces, payloads, validation, idempotency, classification/PII, retries, and retention* that the constitution's articles can be honoured downstream without guessing.

Each example deliberately leaves `[ASSUMPTION: …]` markers and `OQ-NNN` open questions — exactly what `/clarify` is built to resolve before design begins.

## The examples

| File | Integration archetype | Trigger | Transport / format highlights | Pipeline features it stresses |
|---|---|---|---|---|
| [PRD1.md](PRD1.md) | Synchronous request-response | HTTP request | JSON over HTTP | Validation + synchronous error response (OpenAPI-centric) |
| [02-edi-purchase-order-exchange.md](02-edi-purchase-order-exchange.md) | B2B / EDI document exchange | EDI interchange arrival | X12 850/855/997 over AS2/SFTP | Trading-partner agreements, EDI translation, 997 ack, idempotency, 7-yr retention (`edi-x12`) |
| [03-sftp-product-catalog-batch.md](03-sftp-product-catalog-batch.md) | Scheduled batch file ingestion | Scheduled SFTP poll | Pipe-delimited flat file → JSON | Flat-file layout, header/trailer reconciliation, per-record dead-lettering, batched upsert (`batch-processing`) |
| [04-order-event-fanout.md](04-order-event-fanout.md) | Event-driven publish/subscribe | Order accepted | JSON event to a topic, 3 subscribers | Pub/sub fan-out, per-subscription DLQ, consumer idempotency, PII on events (`event-grid` / `service-bus`) |
| [05-nightly-customer-data-sync.md](05-nightly-customer-data-sync.md) | Scheduled bulk ETL | Nightly schedule | Incremental DB extract → warehouse bulk load | Watermark/incremental, restartable upsert, data minimization, large-volume movement (`data-factory`) |
| [06-device-telemetry-ingestion.md](06-device-telemetry-ingestion.md) | High-throughput streaming | Continuous stream | JSON readings, partitioned by device | Hot/cold path split, checkpointing, staleness/quarantine, backpressure (`event-hubs`) |
| [07-async-payment-with-callback.md](07-async-payment-with-callback.md) | Asynchronous request + callback | HTTP request, then webhook | JSON request / signed webhook callback | Ack-then-callback correlation, exactly-once, signature verification, restricted/PCI data (claim-check / async patterns) |
| [08-flat-file-etl-warehouse.md](08-flat-file-etl-warehouse.md) | Flat-file → ETL → warehouse | Scheduled / file arrival | Fixed-width flat file → partitioned warehouse fact table | Bulk positional parse, implied decimals, control-total reconciliation, schema-drift tolerance, partition-overwrite idempotency, quarantine (`data-factory` + `batch-processing`) |

## Running an example

Point the pipeline at any of these files:

```
/run-pipeline --mode greenfield --input examples/04-order-event-fanout.md
```

or advance one stage at a time:

```
/specify examples/04-order-event-fanout.md
/clarify
/model
...
```

You can also start from a one-line brief and let `/draft-prd` build a PRD in this same shape:

```
/draft-prd "Order intake from HTTP, validate, publish an order-placed event to fulfillment, notifications, and analytics"
```
