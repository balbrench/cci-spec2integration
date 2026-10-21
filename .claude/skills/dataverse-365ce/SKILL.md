---
name: dataverse-365ce
description: Authoritative rules for reading from and writing to Microsoft Dataverse / Dynamics 365 CE from Azure integrations — the ADF Copy activity and Mapping Data Flow (CommonDataServiceForApps), the Logic Apps Dataverse managed connector, and the Dataverse Web API. Covers per-host authentication (ADF service-principal key or user-assigned MI with no tenantId; Logic Apps service principal with tenant and no MI), per-activity write semantics (Copy is upsert-only; Data Flow inserts by default and needs alterRow for update/upsert/delete), alternate keys, per-host lookup binding (@EntityReference and lookup@alternateKey in ADF, Type fields in Logic Apps, @odata.bind in the Web API), null-overwrite behaviour, service protection limits, unsupported column types, and the compile-time metadata check. Consumed by azure-dataverse-binder, azure-data-factory-compiler, and azure-connections-binder. Guessing an entity logical name, attribute name, or write behaviour is forbidden — Dataverse validates at runtime and fails with misleading errors.
---

# dataverse-365ce skill

Writing to Dataverse / Dynamics 365 CE looks like any other sink until it isn't. Authentication, write semantics, and lookup syntax all **differ by host** (ADF Copy activity, ADF Mapping Data Flow, Logic Apps connector, Web API), and each mismatch produces a **runtime failure with a misleading error message** — not a compile error. This skill encodes the rules that turn those silent traps into deterministic, correct bindings.

**Guessing is forbidden.** An entity logical name (`contact`, `contoso_event`), an attribute logical name (`contoso_customerid`), or a write behaviour that you have not confirmed against the target environment's metadata is a defect. Dataverse accepts the deploy and fails the first write with an error that points nowhere near the real cause.

Rules marked *(observed)* come from field experience or community reports rather than Microsoft documentation; treat them as likely but verify in a test environment. Everything else is per the Microsoft Learn pages listed under **References**.

## When to use

Load this skill whenever an integration reads from or writes to Dataverse / Dynamics 365 CE:
- an ADF linked service of type `CommonDataServiceForApps` (equivalently `Dynamics` or `DynamicsCrm`), its datasets, or a Copy / Mapping Data Flow / Lookup activity that uses it;
- a Logic Apps (Consumption or Standard) **Microsoft Dataverse** connector action or trigger (managed API `commondataserviceforapps`);
- a Logic Apps HTTP action that calls the Dataverse Web API (`https://<org>.crm[x].dynamics.com/api/data/v9.2/...`);
- an IR `dependencies[]` entry with `kind: rest` and `product: dataverse` (Dataverse is an OData Web API, so the transport is `rest`; `product` carries the Dataverse semantics — see the `ir-authoring` skill).

## 1. Authentication — it differs by host

### ADF linked service

| Property | Rule |
|---|---|
| `type` | `CommonDataServiceForApps` (`Dynamics` / `DynamicsCrm` are equivalent; pick one and keep it consistent across the factory). |
| `deploymentType` | `Online`. |
| `serviceUri` | The **exact** org URL of the target environment, `https://<org>.crm[x].dynamics.com` — parameterised per environment, never a dev URL baked in. |
| `authenticationType` | `AADServicePrincipal` or `ManagedIdentity`. **Never `Office365`** — it is username/password auth and fails outright under conditional access or MFA. |
| `servicePrincipalCredentialType` | `ServicePrincipalKey`. Avoid `ServicePrincipalCert`: Microsoft documents a known transient failure retrieving the certificate from Key Vault. |
| `servicePrincipalCredential` | An `AzureKeyVaultSecret` reference — never an inline string (Article V). |
| `tenantId` | **Does not exist** on this linked service. The tenant is resolved from the org. Do not add one; it is not part of the schema and only misleads readers into thinking it is wired. |

**Managed identity is user-assigned only.** `authenticationType: ManagedIdentity` takes a `credential` reference to an ADF credential that wraps a **user-assigned** managed identity assigned to the factory. The factory's system-assigned identity is **not** supported by this connector — do not emit it.

```json
{
  "name": "CrmDataverse",
  "properties": {
    "type": "CommonDataServiceForApps",
    "typeProperties": {
      "deploymentType": "Online",
      "serviceUri": "@{linkedService().serviceUri}",
      "authenticationType": "ManagedIdentity",
      "credential": { "referenceName": "crm-uami", "type": "CredentialReference" }
    },
    "parameters": { "serviceUri": { "type": "String" } }
  }
}
```

For service-principal auth, replace the last two `typeProperties` with `"authenticationType": "AADServicePrincipal"`, `"servicePrincipalId": "<app id>"`, `"servicePrincipalCredentialType": "ServicePrincipalKey"`, and a `"servicePrincipalCredential"` of type `AzureKeyVaultSecret`.

### Logic Apps Dataverse connector

- It is a **managed API connector** (`/providers/Microsoft.Web/locations/<region>/managedApis/commondataserviceforapps`), so it goes in `managedApiConnections` — there is **no built-in (service-provider) Dataverse connector** in Logic Apps Standard.
- Supported auth: **Service Principal** (Client ID, Client Secret, **Tenant — required here**), **Client Certificate** (Tenant, Client ID, PFX), and **OAuth** (a signed-in user). Use Service Principal for unattended workflows; the secret comes from Key Vault through an `@appsetting` reference. OAuth is a user connection — forbidden for production workflows.
- The connector has **no managed-identity option**. If the solution mandates managed identity, call the Dataverse Web API with the built-in HTTP action using managed-identity auth (audience = the org URL) and register that identity as the application user. The Web API rules in §4.3 and the `429` handling in §6 then apply. Record the choice as a `DD-NN` decision.
- Since October 2023 new workflows must use the **current** Dataverse connector operations; the legacy operations are unavailable for new work.

### Application user (both hosts)

The identity (service principal or managed identity) must be registered as an **application user in the specific target environment**, with a security role granting the privileges the integration uses (directly, or through a team that has the role).

**The wrong-org trap.** When the identity is not an application user in the org the URL points at — for example a sandbox in the same tenant — Dataverse rejects the call with *"The user is not a member of the organization"*. *(observed)* ADF can surface this as an unrelated-looking authentication error (reported as `0x80072560` / "Anonymous authentication scheme"), which sends you chasing auth configuration. When an auth error appears, first confirm the URL is the right environment and the identity is an application user **there**.

## 2. Write semantics — they depend on the activity

| Host | Create | Update / upsert / delete | Key |
|---|---|---|---|
| ADF **Copy activity** sink | No insert. `writeBehavior` must be `"Upsert"` — the only allowed value. | Upsert only. | Primary id column, or `alternateKeyName`. |
| ADF **Mapping Data Flow** sink | **Insert is the default** (`insertable: true`) — a plain create, no workaround needed. | `updateable` / `upsertable` / `deletable` each need an upstream `alterRow` (`updateIf` / `upsertIf` / `deleteIf`) that tags the rows. | Primary id column, or `alternateKeyName` (applies to update, upsert, and delete). |
| Logic Apps connector | **Add a new row** (`CreateRecord`). | **Update a row** (`UpdateOnlyRecord`), **Upsert a row** (`UpdateRecord` — creates the row if it doesn't exist), **Delete a row** (`DeleteRecord`). | Row ID (GUID). |

**Patterns:**

| Intent | Copy activity | Mapping Data Flow | Logic Apps |
|---|---|---|---|
| **Idempotent upsert** on a deterministic key (Article III) | `writeBehavior: Upsert` with the deterministic id, or `alternateKeyName` | `alterRow(upsertIf(true()))` + `upsertable: true`, keyed on the id or `alternateKeyName` | **Upsert a row** with the deterministic GUID |
| **Create-only** (always a new row, e.g. an immutable `contoso_event` row in an append-only history) | Generate a **fresh `NEWID()` GUID** for the primary id and Upsert — a new GUID never matches, so it always creates. *(observed: an upsert with no key column also creates, but this is undocumented; use the explicit GUID.)* | `insertable: true` only — no `alterRow` | **Add a new row** |

Choosing between deterministic-key upsert and create-only is a per-entity decision. State it in the IR mapping rationale and in `decisions.md` (a `DD-NN` entry), because it is non-obvious and load-bearing.

## 3. Alternate keys

A Dataverse **alternate key** on the target entity enforces uniqueness on its columns.

**Using one to upsert.** Set `alternateKeyName` on the sink and make sure the source carries **every** column of the key, and that the key exists in the target environment (it is environment metadata, not part of the IR). *(observed)* Do not also map an empty primary-id column when upserting on an alternate key — it can stop the alternate-key match.

**When one blocks the create pattern.** Under a create-only / append-only history model (multiple rows per natural key over time), an alternate key on those natural columns (e.g. `contoso_sourcekey` on `source + type`) **blocks the second create** for the same key, whichever write method you use.

Resolution options, in order of preference:
1. Remove the alternate key from the entity (a Dynamics admin action) when the data model genuinely allows multiple rows per natural key.
2. Include a disambiguating column (e.g. a sequence or timestamp) in the alternate key so each history row is unique.
3. Switch the entity to deterministic-key upsert if in fact only one row per key should ever exist.

Whichever is chosen, record it as a `DD-NN` decision — an alternate-key constraint is environment metadata the pipeline cannot see from the IR alone, so it stays a tracked open item until the admin confirms it.

**Elastic tables** carry a system `partitionid` column and a built-in alternate key `KeyForNoSqlEntityWithPKPartitionId` (primary key + `partitionid`). Map `partitionid` explicitly; if unmapped, ADF uses the primary key value.

## 4. Lookups — the syntax depends on the host

Common to every host:
- A lookup value is the **GUID of the target row**, and that GUID differs in every environment (dev ≠ QA ≠ prod). **Never hardcode it.** Resolve it at run time (by alternate key where the host supports it, otherwise a lookup or reference-data join on a stable natural key), or bind by alternate key directly.
- **Choices (option sets) are not lookups.** A choice column takes an integer option value, which stays stable across environments when the column ships in a solution. Map the integer, not the label.

### 4.1 ADF (Copy activity and Mapping Data Flow)

ADF does **not** use `@odata.bind`. It uses column-mapping conventions:

| Lookup type | How to set it |
|---|---|
| **Single-target lookup** | Map the target row's GUID to the lookup column. |
| **Multi-target lookup** (Customer, Owner, Regarding) | Map the GUID to the lookup column **and** map the target table's logical name to the virtual column **`{lookup}@EntityReference`** (e.g. `parentcustomerid@EntityReference` = `contact`). If every row targets the same table, add a constant source column with that name. **Owner** accepts only `systemuser` or `team`. |
| **By alternate key** (preferred — no GUID resolution step) | Map the source key column(s) to the virtual column **`{lookup}@{alternateKeyColumn}`**. **Mapping Data Flow inline sink only** — the Copy activity and dataset-mode data-flow sinks still need the GUID. |

Virtual `@` columns don't exist in Dataverse and don't appear when you import a schema — write them into the mapping explicitly.

### 4.2 Logic Apps connector

Each lookup field takes the **row ID (GUID)** plus a separate **Type** field holding the target **entity set name** (e.g. Owner + Owner Type = `systemusers` or `teams`; Customer + Customer Type = `accounts` or `contacts`). Dynamic content won't satisfy the Type field — set it explicitly.

### 4.3 Dataverse Web API (HTTP action)

Bind with `"<navigationProperty>@odata.bind": "/<entitySetName>(<guid>)"`, or by alternate key with `"/<entitySetName>(<keyColumn>='<value>')"`.
- The navigation property name is the lookup's **schema name** and is case-sensitive (custom lookups are often PascalCase, e.g. `contoso_SourceId`); the entity set name is the plural (`contoso_sources`).
- **Polymorphic lookups** bind through the target-typed navigation property, e.g. `"parentcustomerid_contact@odata.bind": "/contacts(<guid>)"`. A plain `<lookup>id` scalar is not the same as the navigation property — confirm which the entity exposes before mapping.

## 5. Nulls and partial updates

- **Copy activity:** `ignoreNullValues` defaults to **`false`**, so on an upsert a **null source value overwrites the existing Dataverse value**. For a partial update — the integration owns only some columns — set `ignoreNullValues: true` (key fields are never ignored), or project only the columns the integration owns.
- **Mapping Data Flow:** a mapped column whose value is null is written as null. Map only the columns the integration owns.
- Empty CSV cells arrive as `null`, not `""` (see the null-safe empty-string rule in `azure-data-factory-compiler`), so a source-fallback mistake becomes a field-clearing write here.

## 6. Throughput and service protection limits

Dataverse applies **service protection limits per user, per web server**, over a 5-minute sliding window. Application users get **no exemption**, and every flow that writes through the same identity **shares one budget**.

| Limit (default, per web server) | Value | Error (Web API hex) |
|---|---|---|
| Requests | 6,000 per 5 minutes | `0x80072322` |
| Combined execution time | 20 minutes per 5 minutes | `0x80072321` |
| Concurrent requests | 52 (can be higher) | `0x80072326` |

- **ADF:** the defaults are `writeBatchSize` 10 × `parallelCopies` 10 = 100 records in flight. Keep `writeBatchSize` at **10 or less**; exceeding the concurrent limit fails with "Server Busy" before the first request runs. On throttling, lower `parallelCopies` or `maxConcurrentConnections` rather than raising the batch size. Give the activity a retry policy with an interval of at least 60 seconds.
- **Web API (HTTP action):** throttling returns `429` with a `Retry-After` header — honour it instead of a fixed backoff.
- **Logic Apps connector:** 6,000 calls per connection per 300 seconds, on top of the service protection limits.
- When several flows write through one identity, call out the shared budget in the plan.

**Bypass flags.** The Copy sink's `bypassBusinessLogicExecution` (`CustomSync`, `CustomAsync`, both, or specific plug-in step GUIDs) and `bypassPowerAutomateFlows` speed up bulk loads by skipping custom plug-ins, workflows, and flows. Use them only when skipping that business logic is an explicit, recorded `DD-NN` decision. They need the `prvBypassCustomBusinessLogic` privilege, which by default only system administrators hold.

## 7. Column types ADF cannot handle

- **Not supported** by the ADF connector: `MultiSelectPicklist`, `PartyList`, `CalendarRules`. Hard-fail at compile time; route those columns through the Web API or the Logic Apps connector instead.
- `Picklist`, `State`, and `Status` map to `Int32` option values, not labels.
- `Customer`, `Lookup`, and `Owner` map to GUIDs — see §4.

## 8. Reading from Dataverse

- ADF infers a Dataverse source schema by **sampling the top rows**, so a column that is empty in those rows is **silently dropped**. Always declare an explicit column mapping or projection.
- In a Mapping Data Flow, a FetchXML **query** source returns every column as a string — cast explicitly downstream.
- The primary id column is always returned, even if the FetchXML doesn't select it.
- **Logic Apps trigger** (*When a row is added, modified or deleted*): copying a Dataverse org copies its webhook `callbackregistrations`, so a copied org can fire your workflow too; and in Standard, an instance reallocation or restart can create a **duplicate** `callbackregistrations` row and a duplicate run. Make the flow idempotent on a business key (Article III) and remove duplicate registrations when found.

## 9. SQL ↔ translator column-order alignment

When a canonical SQL projection feeds a Dataverse sink through a positional translator (a Mapping Data Flow derived-column set, or a stored-procedure result set consumed positionally), the **column order of the SQL SELECT must match the order the translator/sink expects**. A silent column-order mismatch sends the right values to the wrong attributes and passes every type check. Pin the column order explicitly on both sides and verify it as part of the golden transform test.

## 10. Compile-time check (hard-fail)

Mirror the built-in-connector registry discipline (`logic-apps-builtin-connectors`): **hard-fail at compile, not at deploy**, on any of:
- an entity or attribute logical name not confirmed against the target environment's metadata (or an agreed entity-attribute manifest for the integration);
- an ADF linked service with `Office365` auth, a `tenantId` property, or a system-assigned managed identity;
- a Logic Apps Dataverse connection using OAuth (user) auth for a production workflow;
- a Copy activity sink whose `writeBehavior` is anything other than `"Upsert"`;
- a Mapping Data Flow sink with `updateable`, `upsertable`, or `deletable` set but no upstream `alterRow` tagging rows for it;
- a multi-target lookup without its `@EntityReference` column (ADF), Type field (Logic Apps), or typed navigation property (Web API);
- a `{lookup}@{alternateKeyColumn}` mapping outside a Mapping Data Flow inline sink;
- a mapping onto a `MultiSelectPicklist`, `PartyList`, or `CalendarRules` column through ADF;
- a hardcoded lookup GUID.

If the metadata cannot be confirmed, stop and surface what needs confirming — never guess.

## 11. PII, classification, secrets

Contact and customer data is typically **PII** and `classification: confidential` or `restricted`. The bound channel/message must declare it (Article V). All auth goes through a managed identity or a Key Vault secret reference; **no inline secrets** in any emitted linked service, dataset, or connection file.

## 12. IR → Dataverse mapping summary

| IR construct | Dataverse realisation |
|---|---|
| `dependencies[]` with `kind: rest` + `product: dataverse` | ADF: `CommonDataServiceForApps` linked service (SP key or user-assigned MI, no `tenantId`) + one dataset per target entity. Logic Apps: `commondataserviceforapps` managed API connection (service principal with tenant). |
| idempotency key (Article III) | Deterministic-key upsert on the primary id or an alternate key (§2). |
| create-only / immutable event message | Data Flow insert, Logic Apps **Add a new row**, or Copy with a fresh `NEWID()` + Upsert (§2). |
| mapping rule onto a lookup attribute | Per host (§4); prefer binding by alternate key where supported. |
| partial-update mapping (integration owns a subset of columns) | `ignoreNullValues: true` on Copy, or project only owned columns (§5). |
| `pii: true` fields on a confidential/restricted channel | Classification is mandatory; no redaction needed on a non-public channel. |

**Ownership.** `azure-data-factory-compiler` emits the `CommonDataServiceForApps` linked service, dataset, and sink with the write method from §2. `azure-connections-binder` emits the Logic Apps `commondataserviceforapps` managed API connection in `connections.json` (§1). `azure-dataverse-binder` then refines the emitted ADF linked service, datasets, and sinks, and the Logic Apps Dataverse actions in `workflow.json` — write behaviour, alternate keys, lookup binding, null handling, throttling settings, column order, and the application-user snippet. It does not edit `connections.json`.

## References

- [ADF: Copy and transform data in Dynamics 365 (Microsoft Dataverse)](https://learn.microsoft.com/en-us/azure/data-factory/connector-dynamics-crm-office-365) — linked service, sink properties, lookup conventions, data flow sink, type mapping.
- [Dataverse service protection API limits](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/api-limits)
- [Microsoft Dataverse connector reference](https://learn.microsoft.com/en-us/connectors/commondataserviceforapps/) — auth types, operations, throttling.
- [Connect Logic Apps workflows to Microsoft Dataverse](https://learn.microsoft.com/en-us/azure/connectors/connect-common-data-service) — lookup Type fields, trigger troubleshooting, legacy-connector deprecation.
