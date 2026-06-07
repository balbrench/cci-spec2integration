# Changelog

All notable changes to the **Spec2Integration Pipeline** extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-06-07

First public release.

### Added

- **Project launcher** — start a new pipeline workspace with no folder open:
  - **Greenfield** — scaffold from a PRD or brief.
  - **BizTalk migration** — reverse-engineer an existing BizTalk solution.
  - Bundled agents, skills, commands, schemas, templates and scripts are laid into
    the new workspace (BizTalk-only assets are omitted from greenfield projects),
    so scaffolding is fully offline.
- **BizTalk flow** — Specify Source → Analyse → Migrate a group → Deploy, with the
  source folder remembered and smart defaults, and per-group `INT-NNN` migration.
- **Run Pipeline** — end-to-end orchestrator with option checkboxes (unattended,
  auto-fix, allow Sev-2, auto-accept clarifications, dry-run); BizTalk runs also
  pick a single catalogue group or *All*.
- **Pipeline tree** — every integration under `specs/**`, grouped by domain and
  expanded into live stages read from `status.json`, with findings badges,
  coverage/blocked-flow tooltips, and an auto-refreshing file watcher.
- **Pipeline Progress cockpit** — a live, read-only dashboard per integration:
  progress bar, stage table, Sev/stale badges, generated-artifacts panel,
  coverage, blocked-flow ids and per-stage timings.
- **Guided command composer** — pick any slash command and a wizard collects its
  options, then hands the assembled command to the live Claude Code chat
  (in-process command → deep link → clipboard fallback). Optional one-tab-per-run
  session reuse via `spec2integration.continueSession`.
- **IR visualizer** — bundled Cytoscape graph seeded with an integration's
  `integration-ir.yaml`, overlaid with status and Sev-1/2/3 findings.
- **IR IntelliSense** — `integration-ir.yaml` validated and autocompleted against
  the bundled schema (requires the Red Hat YAML extension).
- **Notifications** — stage-completion toasts and Sev-1 warnings.
- **Update Pipeline Assets from GitHub** — refresh a workspace's `.claude/`,
  `schemas/`, `templates/` and `scripts/` to the latest from the repo.
- **Adaptive walkthroughs** — separate Getting Started guides for greenfield and
  BizTalk migrations.

[1.0.0]: https://github.com/balbrench/cci-spec2integration/releases/tag/v1.0.0
