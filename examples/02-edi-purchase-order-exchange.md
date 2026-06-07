# B2B EDI Purchase Order Exchange

## Overview

- Purpose: Exchange purchase orders and acknowledgements with external trading partners using the X12 EDI standard, translating between each partner's EDI envelope and the company's canonical order representation.
- Outcome: Trading partners can place orders and receive confirmations electronically, while internal systems work only with a single canonical order format regardless of which partner sent the order.
- In scope: Inbound EDI 850 (Purchase Order) receipt, validation, translation to canonical order, and routing to the order management system; automatic generation of the 997 Functional Acknowledgement; outbound EDI 855 (Purchase Order Acknowledgement) translation and delivery back to the partner.
- Out of scope: Order fulfillment, inventory, shipping (856 ASN), invoicing (810), partner onboarding tooling, and any document type other than 850/855/997.

## Business Context

### Problem Statement

Trading partners transmit purchase orders as X12 EDI documents, each with partner-specific envelope identifiers, separators, and qualifier conventions. Internal order systems cannot consume raw EDI and must not be coupled to per-partner EDI dialects. The business needs a boundary that receives EDI, acknowledges it on the partner's required timeline, normalizes it to one internal format, and returns a structured acknowledgement.

### Success Criteria

- Every syntactically valid inbound 850 produces a canonical order delivered to the order system and a 997 returned to the partner.
- A syntactically invalid interchange is rejected with a negative 997 and never reaches the order system.
- Each partner's outbound 855 is encoded with that partner's envelope settings.
- Duplicate interchanges (same partner + interchange control number) are processed at most once.

## Actors and Systems

| Name | Type | Role |
|---|---|---|
| Trading partner | external partner | Sends 850 documents and receives 997/855 documents |
| EDI exchange boundary | system | Receives, validates, translates, acknowledges, and routes EDI |
| Order management system | system | Consumes the canonical order and emits the canonical acknowledgement |
| B2B operations team | human | Monitors failures, manages dead-lettered interchanges, maintains partner agreements |

## Triggers and Flow Summary

| Flow | Trigger | Source | Destination | Frequency / Volume |
|---|---|---|---|---|
| Inbound order receipt | EDI interchange arrival | Trading partner | Order management system | Event-driven; ~500–3,000 interchanges/day, peaks at month-end |
| Functional acknowledgement | Successful or failed decode of an inbound interchange | EDI exchange boundary | Trading partner | One per received interchange, within the partner's SLA |
| Outbound order acknowledgement | Canonical acknowledgement produced by the order system | Order management system | Trading partner | One per accepted order |

## Input and Output Contracts

### Inbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| Partner EDI receive | AS2 or SFTP | X12 (flat EDI) | application/edi-x12; partner-specified encoding (commonly UTF-8 or ISO-8859-1) | Transport per partner; AS2 requires signed/encrypted payloads and an MDN return [ASSUMPTION: AS2 is the preferred transport; SFTP is the fallback for partners without AS2] |
| Canonical acknowledgement receive | HTTP or message queue | JSON | application/json; UTF-8 | The order system reports per-line accept/reject for 855 generation |

### Outbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| Functional acknowledgement send | Same channel as receive (AS2 or SFTP) | X12 997 | application/edi-x12 | Sent for every received interchange |
| Order acknowledgement send | Same channel as receive (AS2 or SFTP) | X12 855 | application/edi-x12 | Encoded with the partner's envelope settings |
| Canonical order publish | HTTP or message queue | JSON | application/json; UTF-8 | Delivered to the order management system |

## Payload Definitions

### Inbound Payloads

#### EDI 850 Purchase Order (canonical projection)

The 850 is decoded from X12 segments. The fields below are the canonical projection the downstream order system receives.

| Field | Type | Required | Source | Rules / Notes |
|---|---|---|---|---|
| partnerId | string | yes | ISA06 / GS02 sender identifiers | Resolved to an internal partner code via the partner agreement |
| interchangeControlNumber | string | yes | ISA13 | Component of the idempotency key |
| purchaseOrderNumber | string | yes | BEG03 | Partner's PO number |
| purchaseOrderDate | date | yes | BEG05 | ISO-8601 after translation |
| orderType | string | yes | BEG02 | Mapped from X12 purpose code (e.g. `00` → `new`) |
| buyer | object | yes | N1 loop (BY) | Name and identifier |
| shipTo | object | yes | N1 loop (ST) | Name and address |
| lines | array | yes | PO1 loop | One entry per line item |
| lines[].lineNumber | string | yes | PO101 | |
| lines[].productCode | string | yes | PO107 (qualifier `VP`/`BP`/`UP`) | Buyer or vendor part number |
| lines[].quantity | number | yes | PO102 | Must be > 0 |
| lines[].unitOfMeasure | string | yes | PO103 | |
| lines[].unitPrice | number | yes | PO104 | |
| totalLineItems | integer | yes | CTT01 | Validated against the count of PO1 loops |

Example (canonical projection delivered downstream):

```json
{
  "partnerId": "ACME-RETAIL",
  "interchangeControlNumber": "000012345",
  "purchaseOrderNumber": "PO-88231",
  "purchaseOrderDate": "2026-06-01",
  "orderType": "new",
  "buyer": { "name": "ACME Retail", "id": "1234567890123" },
  "shipTo": { "name": "ACME DC West", "address": "100 Dock Rd, Reno NV 89501" },
  "lines": [
    { "lineNumber": "1", "productCode": "WIDGET-BLUE", "quantity": 240, "unitOfMeasure": "EA", "unitPrice": 3.25 },
    { "lineNumber": "2", "productCode": "WIDGET-RED", "quantity": 120, "unitOfMeasure": "EA", "unitPrice": 3.25 }
  ],
  "totalLineItems": 2
}
```

### Outbound Payloads

#### EDI 855 Purchase Order Acknowledgement (canonical source)

| Field | Type | Required | Destination | Rules / Notes |
|---|---|---|---|---|
| partnerId | string | yes | ISA/GS receiver identifiers | Drives envelope encoding |
| purchaseOrderNumber | string | yes | BAK03 | Echoes the original PO number |
| acknowledgementType | string | yes | BAK01/BAK02 | `accepted` / `accepted-with-changes` / `rejected` |
| lines | array | yes | PO1/ACK loop | Per-line acknowledgement status |
| lines[].lineNumber | string | yes | PO101 | |
| lines[].status | string | yes | ACK01 | `accept` / `backorder` / `reject` |
| lines[].quantity | number | yes | ACK02 | Acknowledged quantity |

Example (canonical acknowledgement received from the order system):

```json
{
  "partnerId": "ACME-RETAIL",
  "purchaseOrderNumber": "PO-88231",
  "acknowledgementType": "accepted-with-changes",
  "lines": [
    { "lineNumber": "1", "status": "accept", "quantity": 240 },
    { "lineNumber": "2", "status": "backorder", "quantity": 0 }
  ]
}
```

## Functional Requirements

- FR-001: The integration shall receive X12 interchanges from trading partners over the partner's configured transport.
- FR-002: The integration shall validate each interchange against the partner agreement's envelope settings (separators, control numbers, sender/receiver qualifiers) and the 850 schema.
- FR-003: The integration shall return a 997 Functional Acknowledgement for every received interchange, positive on successful decode and negative when validation fails.
- FR-004: The integration shall translate a valid 850 into the canonical order format and deliver it to the order management system.
- FR-005: The integration shall not deliver an interchange that fails envelope or schema validation to the order management system.
- FR-006: The integration shall consume a canonical acknowledgement and produce an 855 encoded with the originating partner's envelope settings, delivered back to that partner.
- FR-007: The integration shall reject duplicate interchanges identified by the same partner identifier and interchange control number.

## Validation and Business Rules

- Envelope validation: ISA/GS/ST control structure and trailer counts (SE, GE, IEA) must balance.
- Schema validation: the 850 transaction set must conform to the agreed X12 version per partner (e.g. 4010 or 5010).
- Cross-field validation: `totalLineItems` (CTT01) must equal the number of PO1 loops; each line `quantity` must be greater than zero.
- Idempotency: the business key is `partnerId + interchangeControlNumber`. A repeat of an already-processed interchange must be acknowledged but not re-delivered downstream.
- Partner resolution: every interchange must resolve to a known partner agreement; unknown sender identifiers are rejected.

## Error Handling

- Expected validation failures: malformed envelope or schema-invalid transaction → negative 997 returned to the partner; the interchange is dead-lettered for operator review and never delivered downstream.
- Unknown partner: interchange dead-lettered with an `unknown-partner` reason; no acknowledgement attempted because the return channel is unresolved. [ASSUMPTION: unknown-partner interchanges cannot be acknowledged and require manual partner setup.]
- Expected integration failures: transient delivery failures to the order management system or to the partner channel are retried with backoff; exhausted retries dead-letter the message with full context.
- Error response contract: dead-letter entries carry the original payload, partner id, control numbers, the failing rule, and a correlation id.

## Non-Functional Requirements

- Performance / throughput: sustain ~3,000 interchanges/day with month-end peaks of ~10,000; a single interchange may contain multiple transaction sets.
- Availability / SLA: 997 returned within each partner's contracted window (commonly 1 hour). [ASSUMPTION: the strictest partner SLA is 1 hour for the 997.]
- Security / identity: AS2 payloads must be signed and encrypted; SFTP uses key-based authentication. No partner credentials, AS2 certificates, or SFTP keys may be stored inline — they must be referenced from a secret store.
- Data classification / compliance: confidential. Purchase orders contain commercial terms and buyer identifiers.
- Observability: a correlation id linking the inbound interchange, the 997, the canonical order, and the 855 must be propagated and logged at each hop.
- Retention / archival: raw inbound and outbound EDI payloads retained for 7 years for audit and dispute resolution. [ASSUMPTION: 7-year retention is the governing commercial/audit requirement.]

## Dependencies and External Constraints

- Per-partner agreements holding envelope settings, qualifiers, control number ranges, and acknowledgement expectations.
- X12 schemas for the 850, 855, and 997 transaction sets at each partner's contracted version.
- AS2 certificates and/or SFTP keys per partner, managed in a secret store.
- The order management system's canonical order and acknowledgement interfaces.

## Assumptions and Open Questions

### Assumptions

- [ASSUMPTION: AS2 is the preferred transport; SFTP is the fallback for partners without AS2.]
- [ASSUMPTION: the strictest partner SLA is 1 hour for the 997.]
- [ASSUMPTION: 7-year retention is the governing commercial/audit requirement.]
- [ASSUMPTION: unknown-partner interchanges cannot be acknowledged and require manual partner setup.]
- [ASSUMPTION: only X12 is in scope for the initial release; EDIFACT partners would be a later addition.]

### Open Questions

- OQ-001: Which X12 versions (4010, 5010, both) must be supported, and does any partner require multiple versions concurrently?
- OQ-002: Is the 855 always generated, or only for orders with changes/rejections?
- OQ-003: Should an MDN failure on an AS2 send trigger automatic resend, and after how many attempts is it escalated?
- OQ-004: What is the exact product-code qualifier precedence (VP vs BP vs UP) when a line carries more than one?
