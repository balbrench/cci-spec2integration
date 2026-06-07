---
name: ais-platform
description: End-to-end Azure Integration Services platform design — tier selection (Starter/Standard/Enterprise), shared foundation (Log Analytics, App Insights, Key Vault), networking (VNet, NSGs, Private DNS zones), provisioning order, naming conventions, tagging strategy, dependency matrix, and cost bands. Orchestrates the per-service skills (`api-management`, `service-bus`, `event-grid`, `azure-functions`, `logicapp-cloud-deployment`). Reference material for the `target-architecture` agent and for `azure-bicep-author` when emitting platform-level infra. Adapted from the AVN-Agents AIS framework.
---

# Azure Integration Services Platform — Builder Skill

> **Purpose**: How to design and provision the **shared platform** that hosts one or more AIS workloads — the foundation, networking, identities, and naming/tagging conventions on top of which per-integration Logic Apps / Functions / APIM / Service Bus / Event Grid resources are deployed.

Per-service detail lives in the service skills:

| Service | Skill |
|---------|-------|
| API Management | `.claude/skills/api-management/SKILL.md` |
| Logic Apps Standard | `.claude/skills/logicapp-cloud-deployment/SKILL.md` + `.claude/skills/logicapp-standard-layout/SKILL.md` |
| Azure Functions (stand-alone) | `.claude/skills/azure-functions/SKILL.md` |
| Service Bus | `.claude/skills/service-bus/SKILL.md` |
| Event Grid | `.claude/skills/event-grid/SKILL.md` |
| Event Hubs | `.claude/skills/event-hubs/SKILL.md` |
| Azure Data Factory | `.claude/skills/data-factory/SKILL.md` |
| Integration Account / EDI | `.claude/skills/integration-account-artifacts/SKILL.md` + `.claude/skills/edi-x12/SKILL.md` |

---

## Modes

| Mode | Trigger | Output |
|------|---------|--------|
| **Design Platform** | Planning a new integration platform or major expansion | Architecture diagram, service selection, environment strategy, naming conventions |
| **Provision Full Stack** | Deploying the complete AIS platform infrastructure | Bicep modules: foundation, networking, messaging, compute, gateway, security |
| **Validate End-to-End** | Verifying platform connectivity and readiness | Validation scripts, health checks, connectivity smoke tests |

---

## Mode 1 — Design Platform

### Service Selection Matrix

| Integration Need | Primary Service | Supporting Services |
|------------------|-----------------|---------------------|
| External API gateway | API Management | Key Vault (certs), App Insights |
| Workflow orchestration | Logic Apps Standard | Service Bus, Key Vault, Storage |
| Custom code / transformations | Azure Functions | Service Bus, Storage, Cosmos DB |
| Async messaging (point-to-point) | Service Bus | Functions / Logic Apps (consumers) |
| Async messaging (pub-sub) | Service Bus (topics) | Functions / Logic Apps (subscribers) |
| Event-driven reactions | Event Grid | Functions / Logic Apps (handlers) |
| Batch processing (small/medium) | Azure Functions (Durable) | Service Bus, Storage |
| Bulk data movement / ETL / lake hydration | Azure Data Factory | Storage, Synapse, Key Vault |
| File-based integration | Azure Functions + Blob Storage | Event Grid (trigger), Logic Apps |
| Real-time streaming ingestion | Event Hubs | Functions (processor), Stream Analytics, ADF (via Capture) |
| B2B / EDI | Logic Apps + Integration Account | APIM, Key Vault |

### Platform Tiers

| Tier | Services Included | Use For |
|------|-------------------|---------|
| **Starter** | APIM (Consumption) + Functions (Consumption) + Service Bus (Standard) | PoC, small workloads |
| **Standard** | APIM (Standard v2) + Logic Apps (WS1) + Functions (Flex Consumption) + Service Bus (Standard) + Event Grid | Production, moderate scale |
| **Enterprise** | APIM (Premium) + Logic Apps (WS2+) + Functions (Premium EP2+) + Service Bus (Premium) + Event Grid + VNet | High-scale, regulated, multi-region |

### Environment Strategy

| Environment | Purpose | Service Tiers |
|-------------|---------|---------------|
| **dev** | Developer testing | Lowest SKUs, Consumption |
| **test** | Integration testing | Mid-tier, production-like |
| **staging** | Pre-production validation | Production-identical |
| **prod** | Production workloads | Full tier (see Platform Tiers) |

### Dependency Matrix

| Service | Depends On | Must Provision First |
|---------|------------|----------------------|
| All services | Resource Group, Log Analytics, App Insights | Yes — foundation |
| All services (private) | VNet, Subnets, NSGs, Private DNS Zones | Yes — networking |
| APIM | Key Vault (certs), VNet (Premium), App Insights | Key Vault, VNet |
| Logic Apps (Standard) | Storage Account, App Insights, VNet (optional) | Storage, App Insights |
| Azure Functions | Storage Account, App Insights, VNet (optional) | Storage, App Insights |
| Service Bus | VNet (Premium), Key Vault (optional) | VNet |
| Event Grid | Storage Account (dead-letter), VNet (optional) | Storage |
| APIM → Functions | Functions deployed | Functions first |
| APIM → Logic Apps | Logic Apps deployed | Logic Apps first |
| Functions → Service Bus | Service Bus namespace + entities | Service Bus first |
| Logic Apps → Service Bus | Service Bus namespace + entities | Service Bus first |
| Event Grid → Functions | Functions deployed | Functions first |

### Provisioning Order

```
Phase 1: Foundation
  ├── Resource Groups (per environment)
  ├── Log Analytics Workspace
  ├── Application Insights
  └── Key Vault

Phase 2: Networking (Enterprise tier)
  ├── Virtual Network + Subnets
  ├── Network Security Groups
  ├── Private DNS Zones
  └── Application Gateway (if needed)

Phase 3: Messaging
  ├── Service Bus Namespace + Entities
  └── Event Grid Topics

Phase 4: Compute
  ├── Storage Accounts (for Functions + Logic Apps)
  ├── Azure Functions App(s)
  └── Logic Apps Standard App(s)

Phase 5: Gateway
  ├── API Management
  ├── APIM → Backend configurations
  └── APIM → API definitions + policies

Phase 6: Security & RBAC
  ├── Managed Identity role assignments
  ├── Key Vault access policies / RBAC
  └── Network access rules
```

---

## Mode 2 — Provision Full Stack

### Bicep Module Structure

```
infra/
├── main.bicep                     # Orchestration — calls all modules
├── parameters.dev.bicepparam
├── parameters.test.bicepparam
├── parameters.prod.bicepparam
├── modules/
│   ├── foundation/
│   │   ├── log-analytics.bicep
│   │   ├── app-insights.bicep
│   │   └── key-vault.bicep
│   ├── networking/
│   │   ├── vnet.bicep
│   │   ├── nsg.bicep
│   │   ├── private-dns-zones.bicep
│   │   └── app-gateway.bicep       # Optional
│   ├── messaging/
│   │   ├── service-bus.bicep
│   │   └── event-grid.bicep
│   ├── compute/
│   │   ├── storage-accounts.bicep
│   │   ├── function-app.bicep
│   │   └── logic-app.bicep
│   ├── gateway/
│   │   ├── apim.bicep
│   │   ├── apim-apis.bicep
│   │   └── apim-policies.bicep
│   └── security/
│       ├── role-assignments.bicep
│       └── private-endpoints.bicep
```

Today the `azure-bicep-author` agent emits a per-integration `infra/` aligned with a single Logic App + Service Bus + Storage + Identity + Monitoring. A platform-scoped equivalent of the above structure is the target for the `ais-platform` agent (not yet present). Until that agent exists, this structure is reference for hand-authored platform repos.

### Naming Conventions

| Resource | Pattern | Example |
|----------|---------|---------|
| Resource Group | `rg-{workload}-{env}-{region}` | `rg-integration-prod-uksouth` |
| APIM | `apim-{workload}-{env}` | `apim-integration-prod` |
| Logic App | `logic-{domain}-{env}` | `logic-orders-prod` |
| Function App | `func-{domain}-{env}` | `func-orders-prod` |
| Service Bus | `sb-{domain}-{env}` | `sb-orders-prod` |
| Event Grid (topic) | `egt-{domain}-{env}` | `egt-orders-prod` |
| Key Vault | `kv-{workload}-{env}` | `kv-integration-prod` |
| Storage Account | `st{workload}{env}{random}` | `stintegrationprod001` |
| App Insights | `ai-{workload}-{env}` | `ai-integration-prod` |
| Log Analytics | `log-{workload}-{env}` | `log-integration-prod` |
| VNet | `vnet-{workload}-{env}-{region}` | `vnet-integration-prod-uksouth` |
| Subnet | `snet-{purpose}` | `snet-apim`, `snet-functions`, `snet-pe` |
| NSG | `nsg-{subnet}` | `nsg-apim`, `nsg-functions` |
| Private DNS Zone | (Azure standard names) | `privatelink.servicebus.windows.net` |
| Managed Identity | `id-{workload}-{env}` | `id-integration-prod` |

> **Length + global-uniqueness caveat (MUST follow when emitting Bicep names).** The patterns above assume a *short* workload. When a name has a hard length cap or must be globally unique, a long `workload` will break a naive `take('prefix-${workload}-${env}-${uniqueString(...)}', N)` — the `take(N)` chops the `uniqueString` suffix off the end, leaving either an **invalid trailing dash** or a **non-unique** name (observed: `kv-flatfilesalesetl-dev-` → `VaultNameNotValid`; storage names collapsing to ~1 char of entropy → global-collision risk). Rules:
> - **Put the `uniqueString`/random suffix LAST** and make sure the *literal* part is short enough that `take(N)` can never truncate the suffix. The 13-char `uniqueString` must survive intact.
> - **Never let a name end in `-`** (Key Vault, Storage, SQL, etc. reject it).
> - **Key Vault** (≤24, globally unique): `take('kv-${env}-${uniqueString(resourceGroup().id, workload)}', 24)` → `kv-dev-<13>` = 20 chars. Do NOT embed the full `workload` literal — fold it into the `uniqueString` seed instead.
> - **Storage account** (≤24, no dashes, lowercase, globally unique): reserve the full 13-char suffix, e.g. `toLower('st${take(replace(workload,'-',''),8)}<disc>${uniqueString(resourceGroup().id)}')` where `<disc>` is a 1-char role discriminator (`r`/`d`). Never `take('st${workload}...${suffix}', 24)` — a 16-char workload eats the suffix.
> - Names without a length cap that embed `${location}` (Logic App, ADF, Service Bus, Log Analytics) are fine as-is.

### Tagging Strategy

| Tag | Purpose |
|-----|---------|
| `environment` | Deployment environment (`prod`, `dev`, `test`) |
| `workload` | Application/workload name |
| `domain` | Business domain (orders, payments, ...) |
| `costCenter` | Billing attribution |
| `owner` | Team or individual owner |
| `createdBy` | IaC tool (`bicep`, `terraform`) |
| `createdDate` | Deployment date |

---

## Mode 3 — Validate End-to-End

### Validation Checklist

| Category | Check | Method |
|----------|-------|--------|
| **Infrastructure** | All resources deployed | `az resource list --resource-group <rg>` |
| **Infrastructure** | Correct SKUs | `az resource show` for each resource |
| **Networking** | VNet integration active | `az functionapp vnet-integration list` |
| **Networking** | Private endpoints connected | `az network private-endpoint show` |
| **Networking** | DNS resolution correct | `nslookup <resource>.privatelink.*` |
| **RBAC** | Managed identities assigned | `az role assignment list` |
| **RBAC** | Function → Service Bus access | Send/receive test message |
| **RBAC** | Logic App → Service Bus access | Trigger workflow test |
| **RBAC** | APIM → Function/Logic App access | Call backend via APIM |
| **Monitoring** | App Insights receiving telemetry | Check live metrics stream |
| **Monitoring** | Log Analytics ingesting | KQL: `Heartbeat | take 10` |
| **Monitoring** | Alerts configured | `az monitor metrics alert list` |
| **E2E** | APIM → Function → Service Bus | HTTP call through full chain |
| **E2E** | Event Grid → Function | Publish event, verify handler fires |
| **E2E** | Service Bus → Logic App | Send message, verify workflow runs |

---

## Cost Estimation Guide

Monthly estimates (UK South, indicative — verify against current Azure pricing):

| Tier | APIM | Logic Apps | Functions | Service Bus | Event Grid | Shared Infra | Total (approx.) |
|------|------|-----------|-----------|-------------|------------|--------------|----------------|
| **Starter** | ~£0 (Consumption) | N/A | ~£0 (Consumption) | ~£10 (Standard) | ~£0 (free tier) | ~£70 (Log Analytics) | **~£80/month** |
| **Standard** | ~£200 (Standard v2) | ~£125 (WS1) | ~£0–50 (Flex) | ~£10 (Standard) | ~£5 | ~£100 | **~£440–490/month** |
| **Enterprise** | ~£2,200 (Premium 1u) | ~£250 (WS2) | ~£400 (EP2) | ~£500 (Premium 1MU) | ~£5 | ~£200 | **~£3,555/month** |

*Estimates exclude data transfer, storage, and execution-based charges.*

---

## Cross-references

- All per-service skills listed in the table at the top
- `.claude/skills/eip-to-azure-mapping/SKILL.md` — pattern-to-service mapping
- `.claude/agents/azure-bicep-author.md` — current per-integration Bicep emitter
