# Decisions: <Integration Name>

<!-- The DD-NN decision registry for this integration.
     Appended to by /change (one DD-NN per targeted change) and by hand.
     Read by the reviewer (deviations from a default should have a decision)
     and by solution-design-author (rendered into the IDD's Decision Log).
     Number decisions sequentially: the next id is max(existing DD-NN) + 1. -->

- **Integration folder:** specs/<domain>/NNN-<slug>/
- **Last updated:** <ISO-8601 date>

## Decision log

### DD-01 — <one-line title>
- **Date:** <ISO-8601 date>
- **Change:** <what changed, or the decision made>
- **Artifacts:** <relative paths affected, or "design-only">
- **Agent:** <agent that applied it, or "design decision">
- **Rationale:** <why this choice over the alternatives>
- **Status:** <proposed | applied (not yet deployed) | deployed | open (needs external action)>

<!-- Example of an environment-metadata open item the pipeline cannot see from the IR:

### DD-02 — Remove contoso_sourcekey alternate key from contoso_event
- **Date:** 2026-01-01
- **Change:** Dynamics admin to remove the alternate key blocking the create-only history pattern
- **Artifacts:** design-only (target-org metadata)
- **Agent:** design decision (azure-dataverse-binder flagged it)
- **Rationale:** The append-only history model writes multiple contoso_event rows per source+type; the alternate key blocks the second NEWID() upsert. See the dataverse-365ce skill §3.
- **Status:** open (needs external action)
-->
