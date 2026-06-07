---
description: Deploy the compiled <Platform Name> integration to the target environment.
argument-hint: [environment] (dev | prod)
allowed-tools: Read, Bash, Agent
---

Deploy the <Platform Name> integration.

Steps:
1. Resolve the target environment from the argument (default: `dev`).
2. Verify tests have passed; otherwise instruct the user to run `/test-<plat>` first.
3. Run the IaC deployment for infrastructure.
4. Deploy the compiled integration artifacts.
5. Run a smoke test against the deployed endpoint.
6. Print the deployment status and endpoint URL.

<!-- TODO: replace all <plat> and <Platform Name> placeholders. -->
