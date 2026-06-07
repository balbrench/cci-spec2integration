# <Integration Name>

## Overview

- Purpose: <why this integration exists>
- Outcome: <what business outcome it enables>
- In scope: <systems, flows, or capabilities included>
- Out of scope: <explicit exclusions>

## Business Context

### Problem Statement

<what pain point or business need the integration addresses>

### Success Criteria

- <measurable outcome>
- <measurable outcome>

## Actors and Systems

| Name | Type | Role |
|---|---|---|
| <System or team> | system/human/external partner | <how it participates> |
| <System or team> | system/human/external partner | <how it participates> |

## Triggers and Flow Summary

| Flow | Trigger | Source | Destination | Frequency / Volume |
|---|---|---|---|---|
| <Flow name> | <event, schedule, API call, file arrival> | <source> | <destination> | <when/how often> |

## Input and Output Contracts

### Inbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| <Inbound name> | HTTP / Service Bus / SFTP / File / Event Grid | JSON / XML / flat-file / CSV / binary | <content type, charset, code page> | <notes> |

### Outbound Interfaces

| Interface | Transport | Wire Format | Content Type / Encoding | Notes |
|---|---|---|---|---|
| <Outbound name> | HTTP / Service Bus / SFTP / File / Event Grid | JSON / XML / flat-file / CSV / binary | <content type, charset, code page> | <notes> |

## Payload Definitions

### Inbound Payloads

#### <Payload Name>

| Field | Type | Required | Source | Rules / Notes |
|---|---|---|---|---|
| <fieldName> | <string/int/date/object/array> | yes/no | <where it comes from> | <validation, format, semantics> |
| <nested.fieldName> | <type> | yes/no | <where it comes from> | <validation, format, semantics> |

Example:

```json
{
  "example": "replace me"
}
```

### Outbound Payloads

#### <Payload Name>

| Field | Type | Required | Destination | Rules / Notes |
|---|---|---|---|---|
| <fieldName> | <string/int/date/object/array> | yes/no | <where it is sent> | <validation, format, semantics> |

Example:

```json
{
  "example": "replace me"
}
```

## Flat-File or Delimited Layouts

Complete this section only when an interface uses `flat-file`, `csv`, or another positional/delimited format.

### <Layout Name>

- Format style: fixed-width / delimited / mixed
- Character encoding: <utf-8 / windows-1252 / ascii / other>
- Line ending: <CRLF / LF>
- Header record: yes/no
- Trailer record: yes/no
- Delimiter: <comma / pipe / tab / other>
- Quote character: <if applicable>

| Record / Segment | Field | Start | Length | Delimiter Position | Type | Required | Rules / Notes |
|---|---|---|---|---|---|---|---|
| <Record type> | <fieldName> | <1-based start> | <length> | <if delimited> | <type> | yes/no | <validation> |

Sample:

```text
<sample flat-file or delimited payload>
```

## Functional Requirements

- FR-001: <required behavior>
- FR-002: <required behavior>
- FR-003: <required behavior>

## Validation and Business Rules

- <required field rule>
- <cross-field validation>
- <deduplication or idempotency rule>
- <transformation or enrichment rule>

## Error Handling

- Expected validation failures: <400 response, reject file, dead-letter, etc.>
- Expected integration failures: <retry, alert, dead-letter, compensation, etc.>
- Error response contract: <shape or location if known>

## Non-Functional Requirements

- Performance / throughput: <requests per second, batch size, peak volume>
- Availability / SLA: <target>
- Security / identity: <authn/authz expectations>
- Data classification / compliance: <public/internal/confidential/restricted>
- Observability: <logs, traces, correlation id>
- Retention / archival: <if applicable>

## Dependencies and External Constraints

- <external API, schema, partner dependency, schedule, certificate, etc.>
- <network, firewall, identity, or operational constraint>

## Assumptions and Open Questions

### Assumptions

- [ASSUMPTION: <assumption>]
- [ASSUMPTION: <assumption>]

### Open Questions

- OQ-001: <question>
- OQ-002: <question>
