# Migrate a group

**Run Pipeline** migrates the solution **one integration group at a time**. Pick a
group (`INT-NNN`) — or *All groups* for one combined integration — then toggle the
run options as checkboxes (unattended, auto-fix, allow Sev-2, …).

For the chosen group it runs, scoped via `--group INT-NNN`:

```
inventory (reused) → spec author → contract extractor → IR compiler
  → /model → /review → /plan → /tasks → /implement-azure → /test-azure
```

producing `spec.md`, `contracts/` (JSON Schemas from XSDs, OpenAPI from HTTP/SOAP
bindings, AsyncAPI from queue/topic bindings) and `integration-ir.yaml` for that
group, then the Azure artifacts — mapping every BizTalk construct to its
EIP-aligned IR equivalent and tagging custom code with a `migrationHint`.

Each group becomes its **own** integration under `specs/biztalk/NNN-<group>/`.
Re-run **Run Pipeline** to migrate the next group; deploy each from its
integration's **Deploy** action.
