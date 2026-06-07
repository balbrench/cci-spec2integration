# Advance the pipeline

Every integration's `status.json` records a **recommended next step** — the
earliest stale or unmet stage. Run it from:

- the **▶** action on the integration row,
- the **status bar** item (active integration · next command), or
- **Spec2Integration: Run Recommended Next Step** in the command palette.

The recommendation (and its reason) is sent to chat verbatim, so the pipeline
advances exactly as the status file intends.
