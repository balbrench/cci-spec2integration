# Start from a brief

A **greenfield** project begins with a rough integration brief — a few sentences
describing what moves from where to where, and the rules along the way.

`/draft-prd` turns that brief into a structured PRD under `specs/`. From there the
pipeline is fully guided:

```
brief → /draft-prd → /specify → /clarify → /model → /contracts → /map → /architect → /review → /plan → /tasks → /implement-azure
```

Your new workspace already has every agent, skill and command bundled under
`.claude/` — nothing else to install. Use the **Run** prompt that appeared when
the project opened, or compose `/draft-prd` from the panel toolbar.
