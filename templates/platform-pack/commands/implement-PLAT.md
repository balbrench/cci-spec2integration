---
description: Compile the integration IR to a <Platform Name> solution.
argument-hint: [spec-folder]
allowed-tools: Read, Write, Glob, Agent
---

Run the <Platform Name> pack's implementation chain.

Steps:
1. Resolve the integration folder (argument or most recently modified `specs/*/*/`).
2. Verify `.spec2integration/state.json` has `activePlatform: <plat>`; otherwise stop.
3. Verify `tasks.md` exists; otherwise instruct the user to run `/plan` and `/tasks`.
4. **Migration-mode preflight (Article II.a).** Read `metadata.scenario` from the IR. If `migration`:
   - The IR MUST have a top-level `source:` block with at least `platform` and `artifactsRoot`. Missing \u2192 stop with Sev-1.
   - Resolve `source.preservedRoot` (if set) and `source.artifactsRoot` to absolute paths and verify both exist on disk. Missing \u2192 stop with Sev-1 naming the missing folder.
   - For every `messages[].nativeSchemaSource.origin == "preserved"` and every `mappings[].origin == "preserved"`, verify the referenced on-disk file exists (resolution order: `preservedRoot` \u2192 `artifactsRoot` \u2192 IR folder). Missing \u2192 stop with Sev-1 listing all gaps.
   - For every preserved mapping, verify `transforms.<plat>` is set. Missing \u2192 stop with Sev-1 listing the mappings.
5. Resolve the output directory.
6. In order, invoke:
   - `<plat>-compiler`
   - `<plat>-connections-binder`
   - `<plat>-infra-author`
   - `<plat>-workflow-tester`
   - `<plat>-cicd-author`
   - `<plat>-reviewer`
7. After each agent, surface any TODOs it emitted.
8. Call the `secret-scanner` agent with the output directory. Block on any Sev-1 finding.
9. Compute SHA-256 hashes of all generated artifacts and record them in `.spec2integration/state.json` under `artifactHashes`.
10. Print the reviewer verdict and secret-scan verdict.

<!-- TODO: replace all <plat> and <Platform Name> placeholders. -->
