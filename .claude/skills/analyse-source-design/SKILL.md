---
name: analyse-source-design
description: Rules for analysing BizTalk flow architecture. Covers source-reading depth, orchestration shape expansion, child orchestration recursion, MessageBox modeling, and architecture diagram validation gates.
---

# Analyse Source Design

> Purpose: Authoritative rules for analysing a reverse-engineered BizTalk flow before IR authoring. Follow exactly.

## 1. Source reading depth

- Read every relevant source artifact in the flow group: orchestrations, maps, schemas, pipelines, bindings, and helper references.
- Extract concrete configuration only from source artifacts. No guessed port names, adapters, map names, retry settings, or orchestration behavior.
- If an invoked child orchestration is present in the source set, read it too. Do not stop at the parent orchestration boundary.

## 2. Architecture preservation

The source design is the baseline. Do not simplify, merge, reorder, or redesign the BizTalk flow during analysis.

- One BizTalk orchestration remains one logical orchestration boundary during analysis.
- MessageBox publish and subscribe behavior must be modeled explicitly where applicable.
- Invocation targets must be expanded, not collapsed into opaque leaf nodes.

## 3. MessageBox and subscription rules

- Use the pattern: inbound → MessageBox → orchestration → MessageBox → outbound when the orchestration is MessageBox-bound.
- Subscription activates the orchestration instance, not merely the first receive shape.
- Do not assume all orchestrations are MessageBox-bound. Read `.odx` `DirectBindingType` values carefully:
  - `MessageBox` → direct subscription
  - `PartnerPort` → orchestration-to-orchestration link
  - `SpecifyLater` → physical receive/send port binding at deployment

## 4. Orchestration internal detail

Do not represent an orchestration as a single box. Expand internal shapes as separate logical steps:

- Receive
- Send
- Construct / Transform
- Decide
- Expression
- Scope
- Suspend
- Call or Start Orchestration

For each shape, capture at least the shape name, type, message variable or port, and any relevant transform or dependency reference.

## 5. Child orchestration expansion

If an orchestration invokes another orchestration:

- Expand the child orchestration as its own detailed subgraph or analysis block.
- Recurse through the invocation tree until the leaf orchestration is reached.
- A collapsed `CallOrchestration_*` or `StartOrchestration_*` node is not acceptable final analysis unless the target source artifact is missing, in which case label it as external or unresolved.

## 6. Analysis output quality gates

Before the analysis is considered complete, confirm:

- every orchestration in scope is expanded to shape level,
- every invoked child orchestration in scope is expanded,
- no invocation target is silently collapsed,
- all step labels and routing details come from source artifacts,
- and any unresolved invocation target is explicitly called out.

## 7. Mapping and migration implications

Analysis must preserve enough detail for downstream IR authoring and Azure compilation to make the correct migration choices:

- source XML parsing and validation opportunities,
- XSLT or map usage,
- flat-file or EDI schema usage,
- orchestration-to-workflow boundaries,
- custom code and external assembly usage,
- and MessageBox routing behavior.

This skill does not decide the final Azure implementation shape. It ensures the source behavior is fully understood before that decision is made.
