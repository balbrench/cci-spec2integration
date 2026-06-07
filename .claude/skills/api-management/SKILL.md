---
name: api-management
description: Design, configure, and deploy Azure API Management. Covers API import/definition, policy authoring (scope inheritance, common patterns, expression rules), backend configuration (named backends, pools, circuit breakers), and deployment (SKU/networking decisions, APIOps). Reference material for `azure-bicep-author` when an IR exposes an HTTP-triggered flow behind APIM, and for designers reasoning about gateway placement. Adapted from the AVN-Agents AIS framework.
---

# Azure API Management — Builder Skill

> **Purpose**: Authoritative rules for placing, authoring, and deploying APIM artefacts in an AIS solution. Use when the integration design requires a public/internal API gateway in front of Logic Apps, Function Apps, or App Services.

This skill is **reference-only** today — no agent in this repo emits APIM resources yet. When `azure-bicep-author` is extended to cover APIM, it MUST consume this skill.

---

## Modes

| Mode | Trigger | Output |
|------|---------|--------|
| **Create API** | Importing/defining a new API | API definition, product assignment, subscription config, OpenAPI spec |
| **Apply Policies** | Adding security, transformation, caching, or routing policies | Policy XML at correct scope, policy fragments |
| **Configure Backend** | Setting up backend services with load balancing or circuit breakers | Backend entity definitions, health probes, pool configuration |
| **Deploy** | Provisioning APIM infrastructure or APIOps pipeline | Bicep IaC, APIOps artefact tree, environment parameter files |

---

## Mode 1 — Create API

### Procedure

1. Determine API type (REST, SOAP, GraphQL, gRPC, WebSocket).
2. Choose import method:
   - **OpenAPI spec** — import via portal, CLI, or Bicep.
   - **Azure resource** — direct import from Logic App, Function App, App Service, Container App.
   - **Manual definition** — define operations individually.
3. Apply the API Settings Checklist.
4. Assign to a Product (or create a new Product).
5. Set up subscriptions and access control.

### API Settings Checklist

| Setting | Required | Guidance |
|---------|----------|----------|
| Display name | Yes | Human-readable, used in developer portal |
| Name (URL slug) | Yes | Lowercase-hyphenated, used in gateway URL path |
| API URL suffix | Yes | Path segment after gateway base URL (e.g. `orders`) |
| Backend URL | Yes | The actual backend service endpoint |
| Protocols | Yes | HTTPS only in production; HTTP allowed for dev/test behind VNet |
| API version scheme | Recommended | URL path (`/v1/`), query string, or header — choose one and be consistent |
| Subscription required | Recommended | Yes for all non-public APIs |
| Products | Recommended | Assign to at least one product |
| Tags | Optional | For API discovery and filtering |
| Gateway | Standard v2+ | Assign to workspace gateway if using workspaces |

### API Versioning Decision Table

| Scenario | Recommended Scheme | Rationale |
|----------|--------------------|-----------|
| Public-facing REST APIs | URL path (`/v1/orders`) | Most discoverable, cache-friendly |
| Internal service-to-service | Header (`Api-Version: 2024-01-01`) | Cleaner URLs, version hidden from routing |
| Backward-compatible updates | Revisions (not versions) | Non-breaking changes within same version |
| Breaking schema changes | New version + deprecation timeline | Protect existing consumers |

---

## Mode 2 — Apply Policies

### Procedure

1. Identify the policy scope: Global → Workspace → Product → API → Operation.
2. Determine policy placement within the pipeline: Inbound, Backend, Outbound, or On-Error.
3. Author policy XML using snippets in the Common Policy Patterns table below.
4. Use `<base />` to control inheritance from parent scopes.
5. Test using APIM Trace (enable tracing on subscription for detailed policy execution).
6. For reusable logic, create a Policy Fragment.

### Policy Scope Inheritance

```
Global policy
  └── <base /> ← Workspace policy
        └── <base /> ← Product policy
              └── <base /> ← API policy
                    └── <base /> ← Operation policy
```

Place `<base />` to control where parent policies execute relative to current scope. Omitting `<base />` **replaces** parent policies entirely at that scope.

### Common Policy Patterns

| Pattern | Policies Used |
|---------|---------------|
| Microsoft Entra (Azure AD) token validation + RBAC | `validate-azure-ad-token` or `validate-jwt` |
| Rate limiting + quota | `rate-limit-by-key` + `quota-by-key` |
| Response caching | `cache-lookup` + `cache-store` |
| Request/response transformation | `set-body` + `set-header` + `rewrite-uri` |
| Backend auth with Managed Identity | `authentication-managed-identity` |
| Error handling | `on-error` + `return-response` + `set-status` |
| CORS | `cors` in inbound |
| Mock responses | `mock-response` |

### Policy Authoring Rules

1. **Never hard-code secrets** in policy XML — use Named Values referencing Key Vault.
2. **Always include `<base />`** unless intentionally overriding parent policies.
3. **Use policy expressions** (`@(context...)`) for dynamic logic, not string concatenation.
4. **Wrap external calls** (`send-request`) in a `retry` policy with exponential backoff.
5. **Set `exists-action`** on `set-header` to avoid duplicating headers (`skip`, `override`, `append`).
6. **Log selectively** — use `emit-metric` for custom metrics, `trace` for debugging (disable in production).

---

## Mode 3 — Configure Backend

### Procedure

1. Define a Named Backend entity with URL, credentials, and protocol.
2. For multi-instance backends, configure a Backend Pool with load balancing.
3. Configure circuit breaker rules to protect backends from overload.
4. Set up health probes if available.
5. Reference the backend in API policy using `set-backend-service`.

### Backend Configuration Decision Table

| Scenario | Configuration | Rationale |
|----------|---------------|-----------|
| Single backend instance | Named Backend entity | Simple, direct routing |
| Multiple backend instances | Backend Pool (round-robin or weighted) | Horizontal scaling |
| Active/passive failover | Backend Pool (priority-based) | DR pattern |
| Protect from overload | Circuit breaker on backend | Resilience |
| Backend behind VNet | Private endpoint + internal VNet mode | Network isolation |
| Backend with managed identity | `authentication-managed-identity` resource URI | Zero-credential auth |
| Backend with client cert | Certificate reference from Key Vault | mTLS |

---

## Mode 4 — Deploy

### Procedure

1. Select SKU (Consumption / Basic v2 / Standard v2 / Premium / Developer) based on networking, multi-region, and SLA requirements.
2. Select networking topology (public, VNet-injected, private endpoint).
3. Author Bicep template for the APIM service, products, APIs, named values, backends.
4. For API configuration deployment, set up an APIOps pipeline:
   a. Extract current config using APIOps extractor.
   b. Store artefacts in Git.
   c. PR-based review workflow.
   d. Deploy to target environment via pipeline.

### Deployment Method Decision Table

| Scenario | Method | Tool |
|----------|--------|------|
| New APIM instance | IaC (Bicep) | Azure CLI, GitHub Actions |
| API + policy changes | APIOps pipeline | Azure APIOps Toolkit |
| Emergency policy fix | Azure portal or CLI | `az apim api update` |
| Multi-environment promotion | APIOps with environment-specific config | Parameter files per environment |
| Backup before change | APIM backup API | `az apim backup` |

---

## File Structure — APIOps Artefacts

```
apim-artifacts/
├── apis/
│   └── <api-name>/
│       ├── apiInformation.json
│       ├── specification.yaml    (OpenAPI spec)
│       ├── policy.xml            (API-level policy)
│       └── operations/
│           └── <operation>/
│               └── policy.xml    (Operation-level policy)
├── products/
│   └── <product-name>/
│       ├── productInformation.json
│       └── policy.xml
├── backends/
│   └── <backend-name>.json
├── named-values/
│   └── <named-value>.json
├── policy-fragments/
│   └── <fragment-name>.xml
├── subscriptions/
│   └── <subscription-name>.json
├── tags/
│   └── <tag-name>.json
└── policy.xml                    (Global policy)
```

---

## Common CLI Commands

```bash
# Import API from OpenAPI spec
az apim api import --resource-group <rg> --service-name <apim> \
  --api-id <api-id> --path <url-suffix> \
  --specification-format OpenApi --specification-path ./spec.yaml

# Export API definition
az apim api export --resource-group <rg> --service-name <apim> \
  --api-id <api-id> --export-format openapi-link

# Update API policy
az apim api policy create --resource-group <rg> --service-name <apim> \
  --api-id <api-id> --xml-file ./policy.xml
```

---

## Cross-references

- `.claude/skills/logicapp-cloud-deployment/SKILL.md` — for APIM → Logic App Standard backend wiring
- `.claude/skills/service-bus/SKILL.md` — for APIM-fronted async patterns
- `.claude/skills/eip-to-azure-mapping/SKILL.md` — IR node → APIM placement decisions
