---
name: detect-logical-groups
description: Rules for grouping BizTalk artifacts into logical integration boundaries before IR generation. Determines how many integrations a single BizTalk solution becomes by walking orchestration call chains, receive-port→orchestration links, and shared schema dependencies. Used by `biztalk-inventory` to produce `integration-catalogue.md` group rows. Adapted from the Azure Logic Apps Migration Agent reference.
---

# Detect Logical Groups

> **Purpose**: Decide how many integrations the BizTalk solution becomes. Get this wrong and you either (a) duplicate a shared orchestration into N integrations or (b) collapse genuinely-separate flows into one tangled IR.

A BizTalk Application can contain many orchestrations, ports, and pipelines that are **wired together at runtime** through the MessageBox. The grouping decision must follow that runtime wiring — NOT the visual file/folder layout in Visual Studio.

---

## 1. Grouping precedence (highest priority first)

Apply these rules in order. The first rule that fires wins.

### Rule 1 — Shared orchestration is the unifying element (HIGHEST PRIORITY)

> **If multiple Receive Locations feed (directly or transitively) into the SAME Orchestration, they MUST be in the SAME group.**

The orchestration is the business process. Every input that reaches it is part of the same integration boundary, regardless of source protocol or receive pipeline.

Example:
- `RcvFile` → `RcvPipelineXml` → `OrderRouterOrch`
- `RcvHttp` → `RcvPipelinePassthru` → `OrderRouterOrch`
- → **Single group** `INT-001 OrderRouter` containing both receive locations.

### Rule 2 — Orchestration call chain

> **Orchestrations linked by `Call Orchestration` or `Start Orchestration` shapes (directly or transitively) MUST be in the SAME group.**

Build the call graph: for each orchestration, scan its `.odx` for `CallOrchestration` and `StartOrchestration` shapes; record every callee. Compute connected components — every connected component is one group.

A "master orchestration" called by N receive ports collapses into one group containing all N callers and all transitive callees.

### Rule 3 — Direct port routing

> **A Receive Port routed (via filter or direct binding) to a Send Port with no orchestration in between is its own group.**

This is the "messaging-only" pattern — pure pub/sub through the MessageBox. Each such pair is a distinct group unless Rule 1 or Rule 2 has already placed it elsewhere.

### Rule 4 — Shared schema is NOT enough

A schema referenced by two unrelated orchestrations does NOT merge their groups. Schemas are first-class artifacts but they do not carry runtime data flow. Treat shared schemas as a `references[]` link in each group's catalogue row, not a grouping signal.

### Rule 5 — Pipeline component sharing is NOT enough

A custom pipeline component used by two unrelated receive pipelines does NOT merge their groups. Same reason — it is a code dependency, not a data flow.

---

## 2. Procedure

For each BizTalk Application:

1. **Inventory** all orchestrations, receive ports, send ports, receive locations, pipelines, schemas.
2. **Build the orchestration call graph** by parsing every `.odx` for `CallOrchestration` / `StartOrchestration` shapes (recursive).
3. **Build the receive-to-orchestration map** by scanning binding files (`BindingInfo.xml`) for `ReceivePort` → `Orchestration` direct bindings, and orchestration `PortDeclaration` elements with `Direction=Receive`.
4. **Build the orchestration-to-send map** the same way for `Direction=Send` ports.
5. **Compute connected components** over the union graph: nodes are receive locations, orchestrations, send ports; edges are the runtime data-flow links above.
6. **Each connected component = one group**. Assign a stable `INT-NNN` identifier per group.
7. **Pure direct-route pairs** (Rule 3) that are not in any orchestration component become their own single-edge groups.

---

## 3. Group naming

Every group needs a stable, human-readable name plus a numeric identifier.

| Field | Source | Example |
|---|---|---|
| `id` | `INT-NNN` (zero-padded, sequential per solution) | `INT-001` |
| `name` | The dominant orchestration's friendly name, OR if no orchestration, the dominant receive-port purpose | `OrderRouter`, `InvoiceFileToFtp` |
| `slug` | kebab-case of `name` | `order-router` |

If a group is later split or merged on user feedback, **renumber from the changed group onward** — do NOT reuse retired IDs in the same run.

---

## 4. Recording groups in the inventory

Every group MUST appear as a row in `specs/biztalk/integration-catalogue.md` with:

- `INT-NNN`, name, slug
- Source(s) — every receive location in the group, with adapter/protocol
- Destination(s) — every send port in the group, with adapter/protocol
- Orchestrations — every orchestration in the call-chain component (master + callees)
- Maps, pipelines, schemas — referenced artifacts (NOT grouping criteria, but listed for visibility)
- EIP patterns — derived from the data flow shape (Content-Based Router, Aggregator, etc.)
- Complexity score — sum of artifact complexities

The detailed `specs/biztalk/biztalk-inventory.md` file lists artifacts per group.

---

## 5. Anti-patterns

DO NOT:

- Group by Visual Studio project. A single `.btproj` may contain multiple integrations; multiple `.btproj` files may collaborate on one integration.
- Group by namespace. BizTalk namespaces are organisational, not functional.
- Group by "what the user said in the PRD". The PRD describes business intent; the BizTalk artifacts are the source of truth for runtime topology.
- Split a master orchestration into per-caller copies. The master orchestration appears in **one** group, with all its callers as members.
- Merge unrelated flows because they share a `CommonHelpers.dll`. Code dependencies are not data flows.

---

## 6. Verification gate

Before exiting, confirm:

- [ ] Every receive location belongs to exactly one group.
- [ ] Every send port belongs to exactly one group.
- [ ] Every orchestration belongs to exactly one group.
- [ ] No orchestration appears in two groups (would indicate Rule 2 was misapplied).
- [ ] Every group has at least one receive location OR one send port (a group of pure orchestrations with no I/O is invalid — record as Open Issue and stop).
- [ ] `INT-NNN` identifiers are zero-padded, sequential, and unique within the solution.

If any check fails, do NOT proceed to IR generation. Record the issue in the inventory's Open Issues section and stop.
