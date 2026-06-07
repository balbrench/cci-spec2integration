---
name: integration-account-artifacts
description: Deployment paths for schemas (.xsd), maps (.btm → .xslt), Data Mapper `.lml`, Liquid templates, flat-file schemas, EDI agreements, and certificates to Integration Account or Logic App artifacts folders. Covers artifact conversion, upload destinations, and referencing from workflow actions.
---

# Integration Account & Artifacts Deployment

> **Purpose**: How to convert, deploy, and reference schemas, maps, flat-file schemas, EDI trading partner artifacts, and certificates in Logic Apps Standard.

---

## 1. Artifact Deployment Destinations

Logic Apps Standard has **two** places to store artifacts:

| Destination | Path in project | Use when | Supports |
|---|---|---|---|
| **Logic App Artifacts folder** | `Artifacts/Schemas/`, `Artifacts/Maps/`, `Artifacts/DataMapper/`, `Artifacts/Liquid/` | Single Logic App, no B2B/EDI, no multi-app sharing | XSD schemas, XSLT maps, Data Mapper `.lml`, Liquid templates, flat-file schemas |
| **Integration Account** | Azure resource (Standard tier) | B2B/EDI scenarios, shared schemas/maps across apps, partner/agreement management | XSD schemas, XSLT maps, flat-file schemas, partners, agreements, certificates, assemblies |

### Decision Matrix

| Scenario | Destination | Reason |
|---|---|---|
| XML validation / XSLT transform (non-EDI) | `Artifacts/` folder | No Integration Account overhead |
| Greenfield Data Mapper / Liquid transform | `Artifacts/` folder | Keep declarative transform assets local to the Logic App |
| Flat-file decode/encode (non-EDI) | `Artifacts/` folder | Local to the Logic App |
| X12 / EDIFACT decode/encode | Integration Account | Requires partner agreements |
| AS2 decode/encode | Integration Account | Requires partner certificates |
| HL7 / SWIFT schemas | Integration Account or `Artifacts/` | Integration Account if sharing across apps |
| Maps shared by multiple Logic Apps | Integration Account | Central artifact store |
| Schemas shared by multiple Logic Apps | Integration Account | Central artifact store |

---

## 2. Schema Deployment (.xsd)

### 2.1 BizTalk XSD → Logic Apps XSD Conversion

BizTalk XSD schemas often contain BizTalk-specific annotations that must be stripped before deployment:

**Annotations to remove:**

```xml
<!-- REMOVE these BizTalk-specific elements -->
<xs:annotation>
  <xs:appinfo>
    <b:schemaInfo ... />           <!-- BizTalk schema metadata -->
    <b:recordInfo ... />           <!-- BizTalk record info -->
    <b:fieldInfo ... />            <!-- BizTalk field info -->
    <san:promoted ... />           <!-- Property promotions -->
  </xs:appinfo>
</xs:annotation>
```

**Namespaces to remove:**

```
xmlns:b="http://schemas.microsoft.com/BizTalk/2003"
xmlns:san="http://schemas.microsoft.com/BizTalk/2003/SchemaAnnotations"
xmlns:ns0="http://schemas.microsoft.com/BizTalk/2003/..."
```

**Conversion rule**: Strip all `<xs:appinfo>` children prefixed with `b:` or `san:`. Keep `<xs:documentation>` elements. If `<xs:annotation>` becomes empty after stripping, remove the entire `<xs:annotation>` element. Keep all type definitions, element declarations, and import/include references intact.

> **EXCEPTION — flat-file XSDs**: when the source XSD has `b:fieldInfo` / `b:recordInfo` / `b:annotation` elements that describe a positional or delimited record (i.e. the `nativeSchemaRef` is bound to a `format: flat-file` message), do **NOT** strip the `b:` namespace or any `b:`-prefixed `<xs:appinfo>` content. The Logic Apps Standard `FlatFileDecoding` / `FlatFileEncoding` built-in actions consume the BizTalk flat-file annotations directly — stripping them turns a working flat-file schema into an XML-only schema and silently breaks the decoder. Same exception applies to EDI XSDs with `p:` / `edi:` annotations. The stripping rule above only applies to pure-XML XSDs whose `format` is `xml`.

### 2.2 Deployment to Artifacts Folder

Place converted XSD files in:

```
Artifacts/
  Schemas/
    PurchaseOrder.xsd
    Invoice.xsd
    CommonTypes.xsd
```

Reference from workflow actions using the artifact name:

```json
{
  "XmlValidation": {
    "type": "XmlValidation",
    "inputs": {
      "content": "@body('ReadContent')",
      "schema": {
        "name": "PurchaseOrder.xsd",
        "source": "LogicApp"
      }
    }
  }
}
```

### 2.3 Deployment to Integration Account

Upload via Azure CLI, Bicep, or portal. Reference from workflow actions:

```json
{
  "XmlValidation": {
    "type": "XmlValidation",
    "inputs": {
      "content": "@body('ReadContent')",
      "schema": {
        "name": "PurchaseOrder",
        "source": "IntegrationAccount"
      }
    }
  }
}
```

### 2.4 Bicep for Integration Account Schemas

```bicep
resource schema 'Microsoft.Logic/integrationAccounts/schemas@2019-05-01' = {
  parent: integrationAccount
  name: 'PurchaseOrder'
  properties: {
    schemaType: 'Xml'
    content: loadTextContent('../Artifacts/Schemas/PurchaseOrder.xsd')
    contentType: 'application/xml'
  }
}
```

---

## 3. Map Deployment (.btm → .xslt)

### 3.1 BizTalk BTM → XSLT Conversion

BizTalk `.btm` files are **not** directly usable in Logic Apps. They must be converted to XSLT:

**Conversion approaches** (ordered by preference):

1. **BizTalk Map compiler output**: If you have access to a BizTalk development environment, compile the `.btm` to produce the underlying `.xslt`. Every BTM compiles to an XSLT 1.0 stylesheet.
2. **Manual XSLT rewrite**: For simple maps (direct field copies, concatenation, conditional mapping), rewrite as clean XSLT 1.0 or 2.0.
3. **Data Mapper (preview)**: For JSON-to-JSON or simple XML transforms, use the Logic Apps Data Mapper in VS Code to create a `.lml` (Logic Mapper Language) file.

**Handling BizTalk-specific XSLT features:**

| BTM/XSLT Feature | XSLT Conversion | Notes |
|---|---|---|
| Direct link (copy) | `<xsl:value-of select="source/path"/>` | Straightforward |
| String functoid | XSLT `concat()`, `substring()`, etc. | Use XSLT string functions |
| Mathematical functoid | XSLT arithmetic expressions | `number(a) + number(b)` |
| Logical functoid | `<xsl:if>` / `<xsl:choose>` | Conditional logic |
| Scripting functoid (C#) | `<msxsl:script>` block in XSLT or .NET local function | Embed C# directly in XSLT, or extract to local function |
| Scripting functoid (XSLT) | Inline XSLT template | Already XSLT — copy directly |
| Database functoid | Remove from XSLT; add SQL action before `Xslt` action in workflow | Cannot call DB from XSLT in Logic Apps |
| Cumulative functoid | XSLT `sum()` / `count()` / custom template | Use XSLT aggregation functions |
| Looping functoid | `<xsl:for-each>` | Iterate over source nodes |
| Custom functoid (DLL) | `<msxsl:script>` or .NET local function | Extract logic from DLL into XSLT script block |

### 3.2 Deployment to Artifacts Folder

```
Artifacts/
  Maps/
    TransformPurchaseOrder.xslt
    TransformInvoice.xslt
  DataMapper/
    TransformOrderCanonical.lml
  Liquid/
    TransformInvoiceJson.liquid
```

Reference from workflow actions:

```json
{
  "TransformPurchaseOrder": {
    "type": "Xslt",
    "inputs": {
      "content": "@body('ParseXml')",
      "map": {
        "name": "TransformPurchaseOrder.xslt",
        "source": "LogicApp"
      }
    }
  }
}
```

### 3.3 Deployment to Integration Account

```json
{
  "TransformPurchaseOrder": {
    "type": "Xslt",
    "inputs": {
      "content": "@body('ParseXml')",
      "map": {
        "name": "TransformPurchaseOrder",
        "source": "IntegrationAccount"
      }
    }
  }
}
```

### 3.4 Bicep for Integration Account Maps

```bicep
resource map 'Microsoft.Logic/integrationAccounts/maps@2019-05-01' = {
  parent: integrationAccount
  name: 'TransformPurchaseOrder'
  properties: {
    mapType: 'Xslt'
    content: loadTextContent('../Artifacts/Maps/TransformPurchaseOrder.xslt')
    contentType: 'application/xml'
  }
}
```

---

## 4. Flat-File Schema Deployment

### 4.1 BizTalk Flat-File Schema → Logic Apps Flat-File Schema

BizTalk flat-file schemas are XSD files with additional flat-file annotations (delimiters, positional info). Logic Apps Standard **supports** flat-file schemas with BizTalk-compatible annotations in the `FlatFileDecoding` / `FlatFileEncoding` actions.

**Key difference**: Unlike regular XSD schemas, flat-file schemas **keep** the BizTalk flat-file annotations because the Logic Apps Flat File Operations connector understands them.

**Annotations to KEEP:**

```xml
<xs:appinfo>
  <b:schemaInfo 
    parser_optimization="speed"
    default_pad_char=" "
    pad_char_type="char"
    count_positions_by_byte="false"
    standard="Flat File" />        <!-- KEEP: flat-file schema marker -->
  <b:recordInfo 
    structure="delimited"
    child_delimiter=","
    child_order="infix" />          <!-- KEEP: record delimiter info -->
  <b:fieldInfo 
    justification="left"
    pos_offset="0"
    pos_length="10" />              <!-- KEEP: positional field info -->
</xs:appinfo>
```

**Annotations to REMOVE** (even from flat-file schemas):

- `<san:promoted>` property promotion elements
- Any `xmlns:san` namespace references
- `<b:recordInfo>` elements that reference BizTalk-only features (e.g., `tag_name` in some pipeline contexts)

### 4.2 Deployment

Place flat-file schemas in the same `Artifacts/Schemas/` folder:

```
Artifacts/
  Schemas/
    FlatFileOrder.xsd        ← flat-file schema (with b: annotations)
    PurchaseOrder.xsd        ← regular XML schema (b: annotations stripped)
```

### 4.3 Workflow Action Reference

```json
{
  "DecodeFlatFile": {
    "type": "FlatFileDecoding",
    "inputs": {
      "content": "@body('ReadFileContent')",
      "schema": {
        "name": "FlatFileOrder.xsd",
        "source": "LogicApp"
      }
    },
    "runAfter": { "ReadFileContent": ["Succeeded"] }
  }
}
```

```json
{
  "EncodeFlatFile": {
    "type": "FlatFileEncoding",
    "inputs": {
      "content": "@body('ComposeOutput')",
      "schema": {
        "name": "FlatFileOrder.xsd",
        "source": "LogicApp"
      }
    },
    "runAfter": { "ComposeOutput": ["Succeeded"] }
  }
}
```

---

## 5. EDI Trading Partner Setup

### 5.1 Integration Account Resources

EDI scenarios (X12, EDIFACT, AS2) require an Integration Account with:

| Resource | Purpose | Bicep Resource Type |
|---|---|---|
| **Partner** | Trading partner identity | `Microsoft.Logic/integrationAccounts/partners` |
| **Agreement** | Protocol settings, schemas, acknowledgments | `Microsoft.Logic/integrationAccounts/agreements` |
| **Certificate** | Signing/encryption (AS2) | `Microsoft.Logic/integrationAccounts/certificates` |
| **Schema** | X12/EDIFACT message schemas | `Microsoft.Logic/integrationAccounts/schemas` |

### 5.2 Partner Definition

```bicep
resource partner 'Microsoft.Logic/integrationAccounts/partners@2019-05-01' = {
  parent: integrationAccount
  name: 'Contoso'
  properties: {
    partnerType: 'B2B'
    content: {
      b2b: {
        businessIdentities: [
          { qualifier: 'ZZ', value: 'CONTOSO' }       // X12 ISA qualifier
        ]
      }
    }
  }
}
```

### 5.3 Agreement Definition

```bicep
resource agreement 'Microsoft.Logic/integrationAccounts/agreements@2019-05-01' = {
  parent: integrationAccount
  name: 'Contoso-X12-PO'
  properties: {
    agreementType: 'X12'          // or 'Edifact', 'AS2'
    hostPartner: 'HostOrg'
    guestPartner: 'Contoso'
    hostIdentity: { qualifier: 'ZZ', value: 'HOSTORG' }
    guestIdentity: { qualifier: 'ZZ', value: 'CONTOSO' }
    content: {
      x12: {
        receiveAgreement: {
          protocolSettings: {
            validationSettings: { /* ... */ }
            framingSettings: { /* ... */ }
            envelopeSettings: { /* ... */ }
            acknowledgementSettings: { /* ... */ }
            messageFilter: { messageFilterType: 'Include' }
            schemaReferences: [
              { messageId: '850', schemaVersion: '00401', schemaName: 'X12_00401_850' }
            ]
          }
        }
        sendAgreement: {
          protocolSettings: { /* mirror of receive with send-specific overrides */ }
        }
      }
    }
  }
}
```

### 5.4 EDI End-to-End Workflow Pattern

**Inbound EDI (receive X12/EDIFACT):**

```
HTTP Request trigger
  → X12Decode / EdifactDecode action (Integration Account)
  → Parse JSON action (decode output is JSON)
  → [Optional] XmlCompose if downstream expects XML
  → Business logic actions
  → X12Encode / EdifactEncode for acknowledgment (997/CONTRL)
  → HTTP Response (acknowledgment)
```

**Outbound EDI (send X12/EDIFACT):**

```
Trigger (Service Bus / HTTP / etc.)
  → Business logic / Compose actions
  → X12Encode / EdifactEncode action
  → HTTP / AS2 send action to trading partner
```

**AS2 message exchange:**

```
HTTP Request trigger
  → AS2Decode action (decrypts, verifies signature)
  → X12Decode / EdifactDecode (if EDI payload)
  → Business logic
  → X12Encode / EdifactEncode (response)
  → AS2Encode action (encrypts, signs)
  → HTTP Response (MDN + encoded message)
```

### 5.5 BizTalk Party/Agreement Migration

| BizTalk Concept | Logic Apps Equivalent | Notes |
|---|---|---|
| Party | Integration Account Partner | One partner resource per trading partner |
| Party alias | `businessIdentities[]` on partner | ISA qualifier/value pairs |
| Agreement (send) | Agreement `sendAgreement` section | Protocol settings for outbound |
| Agreement (receive) | Agreement `receiveAgreement` section | Protocol settings for inbound |
| Send port ↔ agreement binding | Workflow action referencing agreement | No separate binding; agreement is referenced directly |
| Receive pipeline (EDI disassembler) | `X12Decode` / `EdifactDecode` action | Built-in action replaces pipeline |
| Send pipeline (EDI assembler) | `X12Encode` / `EdifactEncode` action | Built-in action replaces pipeline |
| Fallback settings | Agreement-level defaults | Set on the agreement resource |
| Acknowledgment (997/CONTRL) | `X12Encode` / `EdifactEncode` action | Generate ack as separate action |
| BAM for EDI | Tracked properties + Application Insights | Track ISA control numbers, acknowledgment status |

---

## 6. Certificate Deployment

Certificates for AS2 signing/encryption:

```bicep
resource certificate 'Microsoft.Logic/integrationAccounts/certificates@2019-05-01' = {
  parent: integrationAccount
  name: 'ContosoCert'
  properties: {
    publicCertificate: loadTextContent('../certs/contoso-public.cer')
    // Private key: reference from Key Vault
    key: {
      keyVault: { id: keyVault.id }
      keyName: 'contoso-private-key'
    }
  }
}
```

> **Rule**: Never store private keys in the project. Always reference them from Azure Key Vault.

---

## 7. Integration Account Bicep Module

```bicep
@description('Integration Account for B2B/EDI scenarios')
param name string
param location string = resourceGroup().location
param tags object
param sku string = 'Standard'    // Free, Basic, Standard

resource integrationAccount 'Microsoft.Logic/integrationAccounts@2019-05-01' = {
  name: name
  location: location
  tags: tags
  sku: { name: sku }
  properties: {}
}

// Link Integration Account to Logic App
// Set in Logic App's app settings:
// "WORKFLOWS_INTEGRATION_ACCOUNT_ID": integrationAccount.id
output id string = integrationAccount.id
output name string = integrationAccount.name
```

**Required Logic App app settings to link the Integration Account.** All seven settings below must be present together — partial configuration leaves runtime calls (`WorkflowOperationDiscoveryHostMode`, IA artifact lookup, EDI decode/encode) without the bearer they need:

| App setting | Value | Required for |
|---|---|---|
| `WORKFLOWS_INTEGRATION_ACCOUNT_ID` | Full resource ID, e.g. `/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Logic/integrationAccounts/{name}` | All IA artifact references |
| `WORKFLOW_INTEGRATION_ACCOUNT_CALLBACK_URL` | The deployed Integration Account callback URL (contains `&` — see §10) | IA artifact lookup, EDI agreement resolution |
| `WORKFLOWS_SUBSCRIPTION_ID` | `subscription().subscriptionId` | ARM-scoped artifact resolution |
| `WORKFLOWS_TENANT_ID` | `subscription().tenantId` | ARM auth |
| `WORKFLOWS_RESOURCE_GROUP_NAME` | `resourceGroup().name` | ARM-scoped artifact resolution |
| `WORKFLOWS_LOCATION_NAME` | `resourceGroup().location` | ARM-scoped artifact resolution |
| `WORKFLOWS_MANAGEMENT_BASE_URI` | `environment().resourceManager` | ARM auth |

These settings MUST live in Bicep (never set via `az webapp config appsettings set` — Bicep redeploys wipe omitted settings). The Integration Account provisioning task is also responsible for **retrieving the deployed callback URL** and writing it into `local.settings.json` (for local) and into the Bicep `.bicepparam` file (for cloud).

Short form (single key, key-vault-backed):

```json
{
  "WORKFLOWS_INTEGRATION_ACCOUNT_ID": "@Microsoft.KeyVault(SecretUri=...)"
}
```

Or in Bicep on the Logic App resource:

```bicep
resource logicApp 'Microsoft.Web/sites@2023-01-01' = {
  // ...
  properties: {
    siteConfig: {
      appSettings: [
        { name: 'WORKFLOWS_INTEGRATION_ACCOUNT_ID', value: integrationAccount.id }
      ]
    }
  }
}
```

---

## 7a. Agreement schemaReferences — CRITICAL post-upload PATCH rule

> **⚠️ Sev-1 runtime bug if missed.** When an EDIFACT or X12 agreement is deployed, the `schemaReferences[]` arrays inside `receiveAgreement.protocolSettings` and `sendAgreement.protocolSettings` MUST be populated with references to the message schemas the agreement processes. An agreement with `schemaReferences: []` will cause `EdifactDecode` or `X12Decode` actions to fail at runtime with `UnexpectedSegment` errors — and the failure is not visible at deployment time.

Deployment ordering MUST be:

1. **Provision** the Integration Account resource.
2. **Upload schemas** (XSD / flat-file XSD) into the Integration Account.
3. **Create or update agreements** with `schemaReferences[]` populated. If the agreements were created first with empty `schemaReferences[]`, **PATCH or re-PUT** them after the schemas exist.
4. Only then deploy the Logic App workflows that invoke `EdifactDecode` / `X12Decode`.

Each `schemaReferences[]` entry must reference an uploaded schema by name:

```json
[
  { "messageId": "850",  "schemaVersion": "00401", "schemaName": "X12_00401_850"  },
  { "messageId": "855",  "schemaVersion": "00401", "schemaName": "X12_00401_855"  },
  { "messageId": "ORDERS", "schemaVersion": "D96A",  "schemaName": "EDIFACT_D96A_ORDERS" }
]
```

The deployment / `/implement-azure` task that uploads schemas MUST have an explicit follow-on step that PATCHes the agreements with the populated `schemaReferences[]`. Do not leave this implicit.

---

## 7b. Integration Account vs Artifacts folder — mutual exclusion per flow

For a given flow, the deployable artifacts (schemas, maps, certificates, partner data) MUST live in **either** the Integration Account **or** the Logic App `Artifacts/` folder — never split between the two. Splitting causes the workflow to reference inconsistent sources and produces hard-to-diagnose `ArtifactNotFound` errors at runtime.

Rule:

- If the flow uses any IA-only capability (X12, EDIFACT, AS2, trading partner / agreement resolution, centrally shared artifact governance), use IA for **all** of its artifacts.
- Otherwise use the `Artifacts/Schemas/` + `Artifacts/Maps/` folders for **all** of its artifacts.
- The IR planner records the choice per flow in `flow.integrationAccount: { used: true|false }`. The `/implement-azure` pack reads this and emits artifacts consistently to a single destination.

---

## 8. Artifact Folder Structure Summary

```
Artifacts/
  Schemas/
    PurchaseOrder.xsd           ← XML schema (BizTalk annotations stripped)
    Invoice.xsd                 ← XML schema (BizTalk annotations stripped)
    FlatFileOrder.xsd           ← Flat-file schema (BizTalk flat-file annotations KEPT)
    X12_00401_850.xsd           ← EDI schema (uploaded to Integration Account too)
  Maps/
    TransformPurchaseOrder.xslt ← Converted from .btm
    TransformInvoice.xslt       ← Converted from .btm
```

> **Naming convention**: Use the original BizTalk schema/map name (PascalCase). Drop the BizTalk project namespace prefix if present.

---

_Adapted from the [Azure Logic Apps Migration Agent](https://github.com/Azure/logicapps-migration-agent) reference material and [Microsoft Learn: Integration Account](https://learn.microsoft.com/en-us/azure/logic-apps/logic-apps-enterprise-integration-create-integration-account)._
