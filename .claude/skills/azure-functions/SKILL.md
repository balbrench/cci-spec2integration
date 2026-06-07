---
name: azure-functions
description: Stand-alone Azure Function App design — language/programming-model selection, trigger choice (HTTP, timer, queue, Event Grid, Event Hub, Cosmos DB, Service Bus), bindings, Durable Functions patterns (chaining, fan-out/fan-in, async HTTP, monitor, human interaction, aggregator), hosting plan (Consumption / Flex Consumption / Premium / Dedicated / Container Apps), and deployment. Scope split with `dotnet-local-functions` — that skill covers in-process Logic Apps custom code only; this skill covers separately-hosted Function Apps. Adapted from the AVN-Agents AIS framework.
---

# Azure Functions (Stand-alone) — Builder Skill

> **Purpose**: Design and deploy stand-alone Azure Function Apps that run **separately** from the Logic App Standard host. Use when:
> - the workload exceeds what Logic Apps custom code can host (heavy compute, > 10 min runtime, independent scaling required),
> - the function is shared across multiple Logic Apps or other consumers, or
> - the function is the primary integration component (not a helper called from a workflow).

**Scope boundary** — for `InvokeFunction` actions invoked from a Logic App Standard workflow against in-process DLLs, use `.claude/skills/dotnet-local-functions/SKILL.md`. That skill explicitly forbids using Azure Functions when a local function suffices.

---

## Modes

| Mode | Trigger | Output |
|------|---------|--------|
| **Create Function** | Building a new function project / function | Function project, trigger config, binding definitions |
| **Configure Bindings** | Setting up input/output bindings for data flow | Binding attributes/decorators, connection configuration |
| **Implement Business Logic** | Writing function code, DI, middleware, Durable Functions | `Program.cs`, function code, orchestration patterns |
| **Deploy** | Provisioning Function App infrastructure or deploying code | Bicep IaC, CI/CD pipeline, deployment slots |

---

## Mode 1 — Create Function

### Language Decision Table

| Language | Model | Runtime | Best For |
|----------|-------|---------|----------|
| C# (isolated) | .NET isolated worker | .NET 8/9 | Enterprise, complex logic, strong typing — **default** |
| C# (in-process) | .NET in-process | .NET 6 (LTS, EOL) | Avoid — migrate to isolated |
| JavaScript/TypeScript | Node.js v4 model | Node 18/20 | Web integration, lightweight transforms |
| Python | Python v2 model | Python 3.9–3.11 | Data processing, ML integration |
| Java | Java 11/17/21 | JVM | Enterprise Java ecosystems |
| PowerShell | PowerShell 7.4 | .NET | Automation, Azure management |

### Trigger Decision Table

| Scenario | Trigger | Key Settings |
|----------|---------|--------------|
| REST API endpoint | HTTP trigger | Route, methods, auth level |
| Scheduled job | Timer trigger | CRON expression, timezone |
| Queue message processing | Service Bus trigger | Queue/topic name, connection, max concurrent calls |
| Blob file processing | Blob trigger | Container, path pattern, polling/event-based |
| Event-driven reaction | Event Grid trigger | Event type filter, subject filter |
| Real-time streaming | Event Hub trigger | Consumer group, batch size, partition |
| Database change feed | Cosmos DB trigger | Database, container, lease container |
| Message routing | Service Bus topic trigger | Topic, subscription, filter |
| Orchestration step | Activity trigger (Durable) | Called by orchestrator only |

### Function Auth Levels

| Level | Key Required | Use Case |
|-------|--------------|----------|
| `anonymous` | No | Public APIs behind APIM, health checks |
| `function` | Function-specific key | Per-function access control |
| `admin` | Host master key | Administrative endpoints only |

**Best practice**: use `anonymous` and handle authentication at the APIM layer or via Microsoft Entra Easy Auth.

---

## Mode 2 — Configure Bindings

### Common Binding Patterns

| Pattern | Trigger | Input | Output |
|---------|---------|-------|--------|
| API + database | HTTP | Cosmos DB | HTTP response |
| Queue processor | Service Bus | Blob Storage | Service Bus (another queue) |
| Event router | Event Grid | — | Service Bus / Event Hub |
| File processor | Blob | Blob (source) | Blob (destination) + Queue |
| Change feed reactor | Cosmos DB | — | Service Bus / HTTP |
| Scheduled report | Timer | SQL | Blob + Email (SendGrid) |

### Connection Configuration Rules

1. **Use identity-based connections** (Managed Identity) over connection strings — default for all new work.
2. **Connection setting format**: `<ConnectionName>__serviceUri` for identity-based.
3. **Never store secrets in code** — use app settings referencing Key Vault.
4. **Use `@Microsoft.KeyVault(...)`** references for connection strings that require them.

---

## Mode 3 — Implement Business Logic

### Durable Functions Pattern Decision Table

| Pattern | Use Case | Complexity |
|---------|----------|------------|
| **Function Chaining** | Sequential processing pipeline | Low |
| **Fan-out / Fan-in** | Parallel processing + aggregation | Medium |
| **Async HTTP API** | Long-running operation with polling | Low |
| **Monitor** | Periodic polling until condition met | Medium |
| **Human Interaction** | Approval workflow with timeout | Medium |
| **Aggregator (Entity)** | Stateful singleton (counter, accumulator) | High |
| **Sub-Orchestration** | Reusable orchestration sub-workflow | Medium |
| **Eternal Orchestration** | Continuous processing loop | Medium |

### Error Handling Strategy

| Scope | Approach | Implementation |
|-------|----------|----------------|
| Transient failures | Retry policies on bindings/triggers | `FixedDelayRetry`, `ExponentialBackoffRetry` attributes |
| Poison messages | Dead-letter queue processing | Max delivery count on Service Bus, separate function for DLQ |
| Unhandled exceptions | Global error handler | Middleware (isolated), exception filter |
| Orchestration failures | Retry + compensation | Durable Functions `CallActivityWithRetryAsync` + compensation activity |

---

## Mode 4 — Deploy

### Hosting Plan Decision Table

| Plan | Cold start | Scale | Networking | Use when |
|------|------------|-------|------------|----------|
| Consumption | Yes | Auto, fast | Public only | PoC, low traffic, cost-sensitive |
| Flex Consumption | Reduced | Auto, fast, configurable concurrency | VNet integration supported | Default for most production workloads |
| Premium (EP1+) | None | Auto, always-warm | VNet integration | Predictable latency, VNet egress |
| Dedicated (App Service) | None | Manual / autoscale | Full | Co-hosting with App Service plan |
| Container Apps | None | KEDA-driven | VNet | Containerised workloads, custom runtimes |

### Deployment Method Decision Table

| Scenario | Method | Tool |
|----------|--------|------|
| Code-based deployment | Zip deploy | `func azure functionapp publish` or GitHub Actions |
| Container-based | Docker image to ACR + deploy | `az functionapp config container set` |
| Zero-downtime | Deployment slots (swap) | `az functionapp deployment slot swap` |
| Multi-environment | CI/CD with env-specific app settings | GitHub Actions environments |
| Local testing | Functions Core Tools | `func host start` |

---

## Project Structure — C# Isolated (.NET 8)

```
function-app/
├── function-app.csproj
├── Program.cs                    # Host builder, DI, middleware
├── host.json                     # Runtime configuration
├── local.settings.json           # Local dev settings (gitignored)
├── Functions/
│   ├── OrderProcessor.cs         # Service Bus triggered function
│   ├── HealthCheck.cs            # HTTP triggered function
│   └── DailyReport.cs            # Timer triggered function
├── Orchestrations/
│   ├── OrderOrchestrator.cs      # Durable orchestrator
│   └── Activities/
│       ├── ValidateOrder.cs      # Activity function
│       └── ProcessPayment.cs     # Activity function
├── Models/
│   ├── Order.cs
│   └── OrderResult.cs
├── Services/
│   ├── IOrderService.cs
│   └── OrderService.cs
├── Middleware/
│   └── CorrelationIdMiddleware.cs
└── Dockerfile                    # For container deployment
```

Stand-alone Function Apps live as siblings to a Logic App Standard project, not inside it. In `azure.yaml` (azd), declare them as a separate service: `services.functions.project: ./functions`.

---

## Common CLI Commands

```bash
# Create new project
func init MyFunctionApp --worker-runtime dotnet-isolated --target-framework net8.0

# Add new function
func new --name OrderProcessor --template "ServiceBusQueueTrigger"

# Run locally
func host start

# Publish to Azure
func azure functionapp publish <app-name>

# Deploy with slot
func azure functionapp publish <app-name> --slot staging
az functionapp deployment slot swap --name <app-name> --resource-group <rg> --slot staging
```

---

## Cross-references

- `.claude/skills/dotnet-local-functions/SKILL.md` — in-process custom code for Logic Apps Standard (do not duplicate)
- `.claude/skills/service-bus/SKILL.md` — when the Function triggers off Service Bus
- `.claude/skills/event-grid/SKILL.md` — when the Function handles Event Grid events
- `.claude/skills/api-management/SKILL.md` — when the Function sits behind APIM
- `.claude/skills/logicapp-standard-layout/SKILL.md` — how stand-alone Functions sit alongside a Logic App project in the same integration folder
