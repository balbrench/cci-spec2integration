# Changelog

All notable changes to the **Spec2Integration Pipeline** extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] — 2026-06-09

Status-refresh hook fixes (`scripts/refresh-status.ps1`).

### Fixed

- **Stage 3a (Contracts lint) wrongly shown blocked** — the PostToolUse status
  hook read the lint verdict from the top level, but the report nests it under
  `summary.verdict`. With the field always `null`, a clean PASS (including a
  Sev-3-advisory-only report) was rendered as `blocked` with an empty `verdict=`.
  The hook now reads `summary.verdict` (falling back to top level), so a PASS is
  reported `done`. Sev-3 advisories never block.
- **Wrong next step after IR** — stage `5a` (IR validation) mapped its `next`
  command to `/architect`; like `5b`–`5e` it runs as part of `/review`, so the
  recommended next step after the IR is now `/review`.

[1.0.2]: https://github.com/balbrench/cci-spec2integration/releases/tag/v1.0.2

## [1.0.1] — 2026-06-09

Greenfield "Run Pipeline" fixes from end-to-end testing.

### Added

- **Multi-line brief editor** — the greenfield **Run Pipeline** flow now opens a
  real editor (`specs/_intake/brief.md`) to capture the integration brief, instead
  of a one-line input box. The brief is written to a file and passed via the new
  `--input-file` argument to `/run-pipeline`, so multi-line briefs travel safely
  and always run through `/draft-prd` (PRD authoring stays in the loop).
- **"Pipeline running…" panel state** — after a greenfield run is launched, the
  empty panel shows a running placeholder during intake (`/draft-prd` → `/specify`)
  instead of looking idle, then hands off to the live stage tree the moment the
  first `status.json` lands.
- **Pause for spec review** — a new **Run Pipeline** option (and `--pause-after
  <stage>` argument on `/run-pipeline`) stops the run after a chosen stage —
  `spec` by default — so you can review and edit `spec.md` before the data model
  and everything downstream are built. Resume with `/run-pipeline --folder
  <folder>`; the checkpoint is one-time and does not re-fire. The spec can be
  edited directly or via `/specify "<change>"` — no PRD round-trip required.

### Fixed

- **Missing brief on fresh greenfield runs** — **Run Pipeline** no longer assembles
  `/run-pipeline --mode greenfield` without an `--input`, which previously forced
  the orchestrator to stop mid-session and ask for a brief, defeating `--unattended`.
- **Panel auto-reveal** — the Spec2Integration panel now opens automatically when a
  project window opens, so the pipeline tree is visible without hunting for the
  activity-bar icon.

[1.0.1]: https://github.com/balbrench/cci-spec2integration/releases/tag/v1.0.1

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
