# Integration Catalogue: <Solution Name>

<!-- produced by biztalk-inventory; do not hand-edit after initial generation -->

- **Source inventory:** specs/biztalk/biztalk-inventory.md
- **Generated:** <ISO-8601 date>

## Catalogue

| # | Integration Name | Source | Destination | Protocol In | Protocol Out | Orchestrations | Transforms | Pipelines | Receive Ports | Send Ports | EIP Pattern | Complexity |
|---|-----------------|--------|-------------|-------------|-------------|----------------|------------|-----------|---------------|------------|-------------|------------|
| 1 | <Name> | <source> | <destination> | <protocol> | <protocol> | <list or —> | <list or —> | <list or —> | <list> | <list> | <pattern> | <complexity> |

## Integration Details

> **Diagram colour key:**
> 🟢 Green box = external systems / sources / destinations |
> 🔵 Blue box = orchestrations |
> 🟠 Orange box = transforms / maps |
> 🟣 Purple box = databases / external dependencies |
> ⚪ Gray box = pipelines |
> 🟡 Yellow box = routing / decisions |
> 🔴 Red box = error / suspend paths

### INT-NNN: <IntegrationName>

| Attribute | Value |
|-----------|-------|
| **Source** | <source system and protocol> |
| **Destination** | <destination system and protocol> |
| **Inbound protocol** | <protocol> |
| **Outbound protocol** | <protocol> |
| **Orchestration** | <name and brief description, or "None — pure messaging"> |
| **Transforms** | <list with notes on functoid types> |
| **Pipelines** | <list or "Default"> |
| **Receive ports** | <list with type> |
| **Send ports** | <list with type> |
| **EIP pattern** | <pattern name> |
| **Schemas** | <list> |
| **Overall complexity** | <complexity rating> |
| **Open issues** | <issues or "None"> |

#### Flow Diagram

<!-- 
  DIAGRAM LAYOUT RULES:
  - Simple flows (≤ 2 orch steps, no branching): use flowchart LR, linear chain
  - Complex flows (≥ 3 orch steps or branching): use flowchart TD with subgraph Orch_Steps[" "]
  - Passthrough (no orchestration): use flowchart LR with ReceivePort → MessageBox → SendPort
  - Sub-orchestrations: add a second subgraph Sub_Steps[" "]
  
  NODE LABELS: "Artifact Type: ArtifactName" (no file extensions)
  COLOURS: Green=#d4edda (external), Blue=#cce5ff (orch), Light-blue=#dce4f0 (ports),
           Orange=#ffe8cc (maps), Purple=#e8daef (helpers/DB), Gray=#e2e2e2 (pipelines),
           Yellow=#fff3cd (routing), Red=#f8d7da (error/suspend)
  
  ANTI-PATTERNS:
  - Do NOT route multiple arrows back to a single central orchestration node
  - Do NOT use loop-back arrows; decompose into sequential numbered steps
-->

```mermaid
flowchart LR
    %% Replace with actual diagram per integration
```

---

## Pattern Summary

| EIP Pattern | Count | Integrations |
|-------------|-------|-------------|
| <pattern> | N | INT-NNN, INT-NNN |

## Complexity Summary

| Complexity | Integration Count | Integrations |
|------------|------------------|-------------|
| <level> | N | INT-NNN, INT-NNN |

## Protocol Matrix

| Protocol | Receive | Send |
|----------|---------|------|
| <protocol> | INT-NNN | INT-NNN |
