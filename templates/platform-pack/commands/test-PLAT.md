---
description: Run the <Platform Name> test harness against the compiled integration.
argument-hint: [project-dir]
allowed-tools: Read, Bash, Agent
---

Run the <Platform Name> pack's test chain.

Steps:
1. Resolve the project directory.
2. Verify the implementation artifacts exist; otherwise instruct the user to run `/implement-<plat>` first.
3. Invoke `<plat>-workflow-tester` to execute the generated tests.
4. Print pass/fail counts and any failing test details.

<!-- TODO: replace all <plat> and <Platform Name> placeholders. -->
