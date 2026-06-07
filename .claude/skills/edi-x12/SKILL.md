---
name: edi-x12
description: B2B/EDI integration design for Logic Apps Standard — X12, EDIFACT, AS2 document types, trading-partner identity conventions, transport choice (AS2/SFTP/HTTPS), receive/send/acknowledgment workflow patterns, and BizTalk-EDI-to-Azure concept mapping. Pairs with `integration-account-artifacts` which owns the Integration Account deployment, Bicep partner/agreement resources, the `schemaReferences[]` PATCH rule, and the seven required Logic App app settings.
---

# EDI / X12 — Design Skill

> **Purpose**: Design-time rules for B2B/EDI integrations on Logic Apps Standard + Integration Account. Use when a flow exchanges X12, EDIFACT, or AS2 with a trading partner.
>
> **Scope split with `integration-account-artifacts`**: this skill covers *what to design* (document choice, partner conventions, workflow patterns); `integration-account-artifacts` covers *how to deploy* (Bicep resources, schema PATCH rule, app settings). When in doubt about deployment, defer to that skill.
>
> **Reference docs** (`reference/B2B/`): the official Microsoft B2B/Enterprise-Integration doc set is bundled here — `logic-apps-enterprise-integration-overview.md`, `-agreements.md`, `-partners.md`, `-schemas.md`, `-maps.md`, `-certificates.md`, `-metadata.md`, `-b2b-list-errors-solutions.md`, `logic-apps-scenario-edi-send-batch-messages.md`, `mainframe-modernization-overview.md`, plus a `B2B Operations/` folder. Consult these for authoritative agreement/partner/schema shapes, the EDI error catalog, and the batch-send pattern rather than guessing. B2B DR / business-continuity lives in the `logic-apps-resilience-observability` skill (`reference/Reliability/`).

---

## 1. When EDI ⇒ Integration Account is mandatory

| Capability | Integration Account required? |
|---|---|
| X12 decode/encode | **Yes** — partner agreement holds envelope settings |
| EDIFACT decode/encode | **Yes** — partner agreement holds envelope settings |
| AS2 decode/encode | **Yes** — certificates + agreement |
| HL7 v2.x (FHIR is separate) | Yes (for partner-specific routing/schemas) |
| Plain XML/JSON transformation | No — `Artifacts/` folder is sufficient |
| Flat-file decode/encode (non-EDI) | No — `Artifacts/` folder is sufficient |

If any flow in the project touches EDI, the **whole project's** artifacts must live in the Integration Account, not split with `Artifacts/`. See `integration-account-artifacts` §"Single source of truth" for the rule.

---

## 2. Common X12 Document Types

| Transaction Set | Name | Typical Direction | Industry |
|---|---|---|---|
| 850 | Purchase Order | Inbound (to seller) | Retail, manufacturing |
| 855 | Purchase Order Acknowledgement | Outbound (seller → buyer) | Retail, manufacturing |
| 856 | Advance Ship Notice (ASN) | Outbound (seller → buyer) | Retail, logistics |
| 810 | Invoice | Outbound (seller → buyer) | All |
| 820 | Payment Order / Remittance Advice | Inbound (from buyer/bank) | Finance |
| 834 | Benefit Enrollment & Maintenance | Both | Healthcare/HR |
| 835 | Healthcare Claim Payment | Inbound | Healthcare |
| 837 | Healthcare Claim | Outbound | Healthcare |
| 940 | Warehouse Shipping Order | Outbound (to 3PL) | Logistics |
| 945 | Warehouse Shipping Advice | Inbound (from 3PL) | Logistics |
| 997 | Functional Acknowledgement | Both — every received transaction | All |
| 999 | Implementation Acknowledgement | Both — HIPAA EDI 5010 | Healthcare |

X12 versions in common use: **4010** (legacy), **5010** (current — HIPAA-mandated for healthcare). Maintain separate schemas per version, per partner.

### Common EDIFACT Messages

| Message | Name | Typical Direction |
|---|---|---|
| ORDERS | Purchase Order | Inbound |
| ORDRSP | Order Response | Outbound |
| DESADV | Despatch Advice (ASN) | Outbound |
| INVOIC | Invoice | Outbound |
| CONTRL | Functional Acknowledgement | Both |

---

## 3. Trading Partner Identity Conventions

| Field | X12 | EDIFACT | Notes |
|---|---|---|---|
| Identifier qualifier | ISA qualifier (`ZZ`, `01`, `14`, `30`...) | UNB sender/recipient qualifier (`14`, `ZZZ`...) | Tells the parser how to interpret the ID |
| Identifier value | ISA `Interchange ID` (15 chars padded) | UNB sender/recipient ID | The partner's mailbox ID |
| Group ID | GS sender/receiver (DUNS, custom) | UNG application sender/recipient | Optional — used inside the interchange |

Encode every partner's qualifiers in their `Microsoft.Logic/integrationAccounts/partners` resource as `businessIdentities[]`. Same partner can have multiple identities (one per protocol).

---

## 4. Transport Choice

| Transport | Use When | Notes |
|---|---|---|
| **AS2** | Internet-facing B2B, signed/encrypted payloads, MDN required | Built-in `as2` connector + Integration Account certificates. Sync vs async MDN configurable per agreement |
| **SFTP** | Partner mandates file drop, no MDN | `sftp-ssh` connector. Pair with `X12Decode`/`EdifactDecode` after pickup |
| **HTTPS / REST** | Modern partners, JSON-wrapped EDI | `Request` trigger + `X12Decode`. Authentication usually OAuth or mTLS |
| **VAN (Value-Added Network)** | Legacy hub-and-spoke EDI (GXS, IBM Sterling, OpenText) | Connect via SFTP or AS2 to the VAN; VAN handles partner routing |
| **MLLP** | Healthcare HL7 over TCP | `mllp` reference workflow — see `templates/azure/reference-workflows/connections/mllp/` |

Do not invent custom HTTP envelopes when AS2 fits — AS2 is the only transport that gives the partner a cryptographic non-repudiation receipt (the signed MDN).

---

## 5. EDI Workflow Patterns

### Inbound EDI (receive)

```
Partner → AS2/SFTP/HTTPS → Logic App workflow
    → X12Decode / EdifactDecode action (resolves agreement from sender/receiver)
    → For-each interchange / transaction
        → XML transform (XSLT) → canonical / target shape
        → Route to backend (Service Bus / HTTP / SQL)
    → Generate 997 / CONTRL functional acknowledgement
    → Send acknowledgement back via same transport (AS2 sync MDN or async)
```

### Outbound EDI (send)

```
Backend event → Service Bus / HTTP trigger
    → Canonical → X12/EDIFACT XML transform (XSLT)
    → X12Encode / EdifactEncode action (resolves agreement)
    → AS2Encode (sign + encrypt, if AS2) → HTTP send to partner endpoint
    → Persist outbound payload + control numbers for audit
    → Wait for / record incoming 997 / CONTRL
```

### AS2 message exchange

```
Inbound:  Partner → AS2Decode (decrypt + verify signature) → X12/EdifactDecode → ...
Outbound: ... → X12/EdifactEncode → AS2Encode (sign + encrypt) → HTTP send → MDN handling
```

### Acknowledgement (997 / CONTRL / 999) rules

- Generate one acknowledgement **per received interchange**, not per transaction set.
- Acknowledgement is produced by re-running `X12Encode` / `EdifactEncode` on a generated ack payload.
- For partners that require it, also generate a 999 (implementation ack) — common in HIPAA EDI 5010.
- Store both the inbound and the ack with their ISA/UNB control numbers in Application Insights tracked properties for traceability.

---

## 6. BizTalk EDI ⇒ Azure Concept Mapping

| BizTalk | Azure Equivalent | Notes |
|---|---|---|
| Party | Integration Account Partner | One partner resource per trading partner |
| Party alias | `businessIdentities[]` on partner | ISA qualifier/value pairs |
| Agreement (EDI) | Integration Account Agreement | `agreementType: 'X12' \| 'Edifact' \| 'AS2'` |
| Send port ↔ agreement binding | Workflow action referencing agreement | No separate binding; agreement is referenced directly |
| Receive pipeline (EDI disassembler) | `X12Decode` / `EdifactDecode` action | Built-in action replaces pipeline |
| Send pipeline (EDI assembler) | `X12Encode` / `EdifactEncode` action | Built-in action replaces pipeline |
| Fallback settings | Agreement-level defaults | Set on the agreement resource |
| Acknowledgement (997 / CONTRL) | `X12Encode` / `EdifactEncode` action | Generate ack as separate action |
| BAM tracking | Tracked properties + Application Insights | Track ISA control numbers, ack status |
| ESB Toolkit itinerary for EDI | Multiple workflows + Service Bus topic for routing | No 1:1 — redesign routing in Azure |

---

## 7. Migration Steps (from MuleSoft, BizTalk, or legacy VAN)

1. **Export partner agreements** — extract partner profiles, ISA/GS or UNB/UNG identifiers, envelope settings, ack expectations.
2. **Create the Integration Account** (Standard tier required for X12/EDIFACT/AS2 — see `integration-account-artifacts` §5).
3. **Upload schemas first**, then **PATCH agreements** with the resulting `schemaReferences[]`. Schema-references-after-agreement is a Sev-1 deployment rule documented in `integration-account-artifacts` §11 — do not skip it.
4. **Set the seven Logic App app settings** that link the Logic App to the Integration Account (`integration-account-artifacts` §10).
5. **Build receive workflows** — one per partner+transport, decoding into a canonical shape, persisting raw EDI for audit.
6. **Build send workflows** — one per partner+transport, encoding from canonical, persisting outbound + ack.
7. **Wire AS2 certificates** in Key Vault, referenced by the Integration Account (`integration-account-artifacts` covers Key Vault wiring).
8. **Smoke-test with synthetic interchanges** — use a known-good 850 / ORDERS to validate decode, transform, route, and ack generation.

---

## 8. Key Considerations

- **Integration Account tier**: Standard is required for EDI/AS2 (Basic does not support agreements).
- **Schema versioning**: maintain multiple X12 versions (4010, 5010) per partner — both `schemaName` values appear in the agreement's `schemaReferences[]`.
- **Batching**: some partners require batched outbound interchanges — implement via Service Bus accumulation + scheduled flush workflow.
- **MDN handling**: sync MDN blocks the AS2 sender until the receipt is returned. Async MDN is asynchronous via a separate inbound endpoint — design the receive workflow for the async MDN if the partner uses it.
- **Compliance / audit retention**: retain raw inbound and outbound EDI payloads in a Storage Account with an immutability policy (HIPAA, SOX, customs).
- **Control number duplicate detection**: configurable per agreement; mandatory for inbound to avoid double-processing.

---

## Cross-references

- `.claude/skills/integration-account-artifacts/SKILL.md` — Bicep partner/agreement resources, schemaReferences PATCH rule, Logic App app settings
- `.claude/skills/connections-json-generation-rules/SKILL.md` — `as2`, `x12`, `edifact`, `sftp-ssh` connector wiring
- `templates/azure/reference-workflows/x12-agreement/` — reference workflow for X12 receive
- `templates/azure/reference-workflows/connections/mllp/` — HL7 v2 over MLLP variant
