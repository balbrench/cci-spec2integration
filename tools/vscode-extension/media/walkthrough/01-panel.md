# Pipeline panel

The **Spec2Integration** view lists every integration under `specs/**`, each
expanded into its pipeline stages with live status read from `status.json`:

- ✓ green — done
- ○ yellow — missing / not run yet
- ⚠ yellow — stale (an upstream file changed)
- ✗ red — blocked

Integration rows show a findings badge (`2×Sev-1, 1 blocked, …`) and turn red or
yellow when attention is needed. The panel refreshes automatically whenever a
command updates a status file.
