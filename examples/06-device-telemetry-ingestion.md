# Device Telemetry Stream Ingestion

## Overview

- Purpose: Continuously ingest high-volume telemetry from connected field devices, validate and enrich each reading, raise alerts when readings breach thresholds (hot path), and archive all readings for later analysis (cold path).
- Outcome: Operations gets near-real-time alerts on out-of-range conditions while a complete, durable history of all readings is retained for analytics, from a single ingestion pipeline.
- In scope: Receiving a continuous telemetry stream, per-reading validation and enrichment, threshold evaluation with alert emission, durable archival of every accepted reading, and handling of malformed or out-of-order readings.
- Out of scope: Device provisioning/management, command-and-control back to devices, the alerting UI, and long-term analytics/ML on the archived data.

## Business Context

### Problem Statement

Thousands of devices emit readings every few seconds. A request-response or batch model cannot keep up, and coupling alerting to archival means a slow archive delays alerts. The business needs a streaming ingestion boundary that scales to the device population, separates a low-latency alert path from a durable archive path, and tolerates bursts and brief downstream outages.

### Success Criteria

- Sustained ingestion keeps up with peak device emission without backpressure loss within the retention window.
- Threshold breaches produce an alert within seconds of the reading arriving.
- Every accepted reading is durably archived exactly once for analytics.
- Malformed or stale readings are isolated without stalling the stream.

## Actors and Systems

| Name | Type | Role |
|---|---|---|
| Field devices | external | Emit telemetry readings continuously |
| Telemetry ingestion boundary | system | Receives the stream, validates, enriches, branches to hot/cold paths |
| Alerting service | system | Receives threshold-breach alerts (hot path) |
| Telemetry archive | system | Durable store of all accepted readings (cold path) |
| Operations team | human | Acts on alerts; reviews quarantined readings |

## Triggers and Flow Summary

| Flow | Trigger | Source | Destination | Frequency / Volume |
|---|---|---|---|---|
| Telemetry ingest | Reading arrives on the stream | Field devices | Hot + cold paths | Continuous; ~5,000 readings/sec sustained, higher in bursts |
| Threshold alert (hot) | A validated reading breaches a threshold | Telemetry ingestion boundary | Alerting service | Per breaching reading |
| Archive (cold) | A reading is accepted | Telemetry ingestion boundary | Telemetry archive | Per accepted reading |
| Quarantine | A reading fails validation | Telemetry ingestion boundary | Quarantine store | Per invalid reading |

## Input and Output Contracts

### Inbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| Telemetry stream | High-throughput event stream | JSON | application/json; UTF-8 | Partitioned by `deviceId` to preserve per-device order [ASSUMPTION: per-device ordering matters; cross-device ordering does not] |

### Outbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| Alert publish | HTTP or event stream | JSON | application/json; UTF-8 | Hot path; low latency |
| Archive write | Bulk/append store write | JSON or columnar | UTF-8 | Cold path; durable, append-only |
| Quarantine write | Append store write | JSON | application/json; UTF-8 | Invalid/stale readings with reason |

## Payload Definitions

### Inbound Payloads

#### Telemetry Reading

| Field | Type | Required | Source | Rules / Notes |
|---|---|---|---|---|
| deviceId | string | yes | Device | Partition key; component of the idempotency key |
| sequence | integer | yes | Device | Monotonic per device; component of the idempotency key |
| readingTime | date-time | yes | Device | ISO-8601; used for staleness check |
| metric | string | yes | Device | e.g. `temperatureC`, `pressureKpa` |
| value | number | yes | Device | Numeric reading |
| unit | string | yes | Device | Must match the metric's expected unit |

Example (single reading):

```json
{
  "deviceId": "DEV-00471",
  "sequence": 1043887,
  "readingTime": "2026-06-06T14:22:05.120Z",
  "metric": "temperatureC",
  "value": 92.4,
  "unit": "C"
}
```

### Outbound Payloads

#### Threshold Alert

| Field | Type | Required | Destination | Rules / Notes |
|---|---|---|---|---|
| alertId | string | yes | Alerting service | Unique per alert |
| deviceId | string | yes | Alerting service | From the reading |
| metric | string | yes | Alerting service | From the reading |
| value | number | yes | Alerting service | The breaching value |
| threshold | number | yes | Alerting service | The threshold that was breached |
| severity | string | yes | Alerting service | Derived from how far the value is out of range |
| detectedAt | date-time | yes | Alerting service | When the breach was detected |
| correlationId | string | yes | Alerting service | Links alert to the source reading |

Example (alert):

```json
{
  "alertId": "alrt-7c2",
  "deviceId": "DEV-00471",
  "metric": "temperatureC",
  "value": 92.4,
  "threshold": 85.0,
  "severity": "high",
  "detectedAt": "2026-06-06T14:22:05.180Z",
  "correlationId": "DEV-00471:1043887"
}
```

## Functional Requirements

- FR-001: The integration shall consume telemetry readings from a partitioned high-throughput stream, preserving per-device order.
- FR-002: The integration shall validate each reading for required fields, numeric value, unit consistency, and staleness.
- FR-003: The integration shall enrich each accepted reading with the device's threshold configuration needed for evaluation.
- FR-004: The integration shall evaluate the enriched reading against its metric threshold and emit an alert (hot path) when breached.
- FR-005: The integration shall durably archive every accepted reading exactly once (cold path).
- FR-006: The integration shall quarantine malformed or stale readings with a reason, without stalling the stream.
- FR-007: The integration shall scale ingestion with the partition count to sustain peak throughput.

## Validation and Business Rules

- Reading validation: all required fields present; `value` is numeric; `unit` matches the metric's expected unit; `readingTime` within the accepted staleness window.
- Staleness: a reading whose `readingTime` is older than the configured window (e.g. 15 minutes) is quarantined as stale rather than archived/alerted. [ASSUMPTION: 15-minute staleness window.]
- Idempotency: the business key is `deviceId + sequence`; a duplicate reading is archived at most once and does not re-alert.
- Ordering: per-device ordering is preserved via partitioning; cross-device ordering is not required.
- Threshold evaluation: thresholds are per device + metric, looked up from configuration; a missing threshold means the reading is archived but not alerted. [ASSUMPTION: missing threshold → archive only, no alert.]

## Error Handling

- Expected validation failures: malformed or stale readings are written to the quarantine store with the reason and a correlation id; the stream continues.
- Hot-path failures: a transient alert-delivery failure is retried with backoff; an exhausted retry dead-letters the alert without blocking archival of the reading.
- Cold-path failures: a transient archive-write failure is retried with backoff; checkpointing ensures no accepted reading is lost or double-written on consumer restart.
- Backpressure: when downstream is slow, the stream's retention window absorbs the lag; consumers resume from the last checkpoint. [ASSUMPTION: stream retention is sized to absorb the longest expected downstream outage.]
- Error response contract: quarantine and dead-letter entries carry the original reading, the failing rule/step, and the correlation id.

## Non-Functional Requirements

- Performance / throughput: sustain ~5,000 readings/sec with short bursts above that; hot-path alert latency target under 5 seconds from arrival.
- Availability / SLA: ingestion available continuously; brief downstream outages must not lose readings within the retention window.
- Security / identity: device-to-stream authentication per device; all internal connections use managed identity with least-privilege; no inline secrets.
- Data classification / compliance: internal. Telemetry is operational, not personal. [ASSUMPTION: readings contain no PII; device-to-location mapping, if added, would change this.]
- Observability: a correlation id (`deviceId:sequence`) is propagated to alerts, archive, and quarantine; throughput, lag, quarantine rate, and alert rate are emitted as metrics.
- Retention / archival: stream retention sized to the largest expected outage; archived readings retained per the analytics policy. [ASSUMPTION: 7-day stream retention; archive retention governed separately.]

## Dependencies and External Constraints

- A partitioned high-throughput streaming intake with consumer checkpointing and a configurable retention window.
- Per-device + per-metric threshold configuration accessible at low latency for enrichment.
- A durable, append-friendly archive store sized for the reading volume.
- The alerting service endpoint and its authentication model.

## Assumptions and Open Questions

### Assumptions

- [ASSUMPTION: per-device ordering matters; cross-device ordering does not.]
- [ASSUMPTION: a 15-minute staleness window applies.]
- [ASSUMPTION: a missing threshold means archive only, no alert.]
- [ASSUMPTION: stream retention is sized to absorb the longest expected downstream outage.]
- [ASSUMPTION: readings contain no PII.]

### Open Questions

- OQ-001: What is the exact peak readings/sec and the device population, to size partitions and consumers?
- OQ-002: What are the alert-latency and delivery guarantees the alerting service requires (at-least-once, dedup window)?
- OQ-003: Are thresholds static configuration or do they change frequently enough to need a live refresh mechanism?
- OQ-004: What is the required archive format and retention for downstream analytics?
