# README screenshots

These images are referenced by the extension `README.md` using **absolute raw
GitHub URLs**, e.g.:

```
https://raw.githubusercontent.com/balbrench/cci-spec2integration/main/tools/vscode-extension/media/screenshots/pipeline-tree.png
```

Absolute URLs are required because the VS Code **Marketplace does not render
relative image paths** in the README (GitHub does, but the Marketplace listing
does not). Committing them here and linking the raw URL makes them render in
both places.

They are **excluded from the packaged `.vsix`** (see `.vscodeignore`) so they
don't bloat the extension download — the published README pulls the hosted copy.

## Expected files

Save each screenshot with exactly these names (PNG, ideally ~1200–1600px wide,
trimmed to the relevant UI):

| File | What it shows |
| --- | --- |
| `pipeline-tree.png` | The Spec2Integration activity-bar panel: integrations expanded into pipeline stages with status pills (hero image). |
| `install-marketplace.png` | Installing the extension from the Marketplace in the VS Code Extensions view (search result + Install button). |
| `progress-cockpit.png` | The live Pipeline Progress dashboard webview (stage table, coverage, generated artifacts). |
| `ir-visualizer.png` | The Cytoscape flow graph of an `integration-ir.yaml`. |
| `launcher.png` | The no-workspace launcher welcome (Greenfield / BizTalk buttons). |
| `run-pipeline-options.png` | The Run Pipeline option checkboxes (unattended, auto-fix, …). |

After adding/replacing any image, just commit and push to `main` — the README
updates automatically (no repackage needed for the GitHub/Marketplace render).
