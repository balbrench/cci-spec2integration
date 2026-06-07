# Visualize the IR

**Open IR Visualizer** (from an integration row or the command palette) renders
the integration's `integration-ir.yaml` as an interactive flow graph — channels,
flows, mappings, and routing — in a webview, seeded with the selected folder.

While editing `integration-ir.yaml` directly, you also get live validation and
autocomplete against `schemas/integration-ir.schema.json` (requires the YAML
extension), the same schema the pipeline enforces later.
