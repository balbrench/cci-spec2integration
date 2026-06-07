# Analyse the solution

**Analyse Solution** runs `/biztalk-inventory <source>` against the folder you
specified: it catalogs every orchestration, map, schema, pipeline, binding and
BRE policy, groups them by integration boundary, and assigns a migration-
complexity score per artifact.

The result lands in `specs/biztalk/biztalk-inventory.md` and
`specs/biztalk/integration-catalogue.md` — the catalogue defines the `INT-NNN`
boundaries that each migrate **independently**.

When analysis finishes, the **BizTalk solution** node in the panel lists every
group (`INT-001`, `INT-002`, …), each with a **Migrate ▶** action — ready for the
next step.
