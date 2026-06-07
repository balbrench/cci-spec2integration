---
description: [Manual] Provision and deploy the Logic Apps Standard solution with azd.
argument-hint: "[--preview] [--confirm-subscription]"
allowed-tools: Read, Grep, Glob, Bash
---

Steps:
1. Verify `azure.yaml`, `infra/main.bicep`, and `app/` exist; otherwise stop.
2. Run `az account show` and stop with a clear error if the user is not logged into Azure.
3. Print the current Azure subscription from `az account show` including subscription name, subscription id, tenant id, and whether it is the default/current context.
4. Run `az account list --output table` and print the available Azure subscriptions before any provisioning step so the user can verify the target context.
5. If more than one subscription is available and `$ARGUMENTS` does not contain `--confirm-subscription`, stop before any Azure change and tell the user to either:
- rerun `/deploy-azure --confirm-subscription` to proceed with the currently active subscription, or
- switch Azure CLI context first, then rerun `/deploy-azure`.
6. Verify `azd` is installed and available on `PATH`; otherwise stop and tell the user to install it.
7. Run `az bicep build infra/main.bicep` to catch template errors before any Azure call.
7a. **azd parameter + scope prerequisites (per `logicapp-cloud-deployment` §1a/§1b).** Before any `azd provision`:
   - Confirm `infra/main.parameters.json` exists (azd reads it, NOT `.bicepparam`). If absent, stop and tell the user to re-run `/implement-azure` (the `azure-bicep-author` now emits it) or hand-author it — otherwise `azd provision` hangs prompting for the no-default params.
   - If `infra/main.bicep` is `targetScope = 'resourceGroup'`, ensure the resource group exists and `AZURE_RESOURCE_GROUP` is set in the azd env: if the RG is missing, `az group create -n <rg> -l <location>` and `azd env set AZURE_RESOURCE_GROUP <rg>` (azd does NOT create the RG for an RG-scoped template). For a subscription-scoped template, skip — azd creates the RG.
   - Set any required env vars the param file references (e.g. `azd env set SQL_AAD_ADMIN_OBJECT_ID <objectId>`); a value left as an all-zeros placeholder will fail the SQL/RBAC deploy.
8. If `$ARGUMENTS` contains `--preview`, run `azd provision --preview` and stop after printing the current subscription and preview summary.
9. Otherwise run `azd provision` to deploy infrastructure only.
10. If a sibling `Functions/*.csproj` project exists, run `dotnet build` on it before packaging so local-function DLLs are published into `app/lib/custom/net8/`. If no sibling `Functions` project exists, skip compilation.
11. Package the contents of `app/` for Logic Apps Standard deployment. Exclude local-only or tooling-only files such as `local.settings.json`, `.vscode/`, `workflow-designtime/`, `.azurite/`, `__azurite*`, `bin/`, and `obj/`.
12. Deploy the packaged `app/` content to the provisioned Logic App Standard site using zip deployment. Do not ask `azd` to build or deploy the Logic App project itself.
13. On success, print the endpoint and resource group name returned by the infrastructure deploy, together with the active subscription name and id used for the deployment.
14. On failure, print the Azure / azd error and do not retry.
15. On success, refresh `<folder>/status.json` per `.claude/skills/pipeline-status/SKILL.md`. Mark stage 12 (Deploy) as `done` with summary `<endpoint> in <resource-group>`. On failure, leave stage 12 untouched.

Rules:
- Do not guess or infer the subscription from repo files. Use the live Azure CLI context only.
- Do not switch subscriptions automatically.
- If multiple subscriptions are visible, require explicit confirmation before deployment by stopping unless `--confirm-subscription` is present.
- If the current subscription is wrong, stop after showing the available subscriptions and tell the user to change context, then rerun `/deploy-azure`.
- Do not hard-code subscription ids or tenant ids.
- Do not compile the Logic Apps Standard project itself. Only build a sibling `Functions/*.csproj` project when local functions exist.
- Do not model Logic Apps Standard `app/` as an `azd` application service. `azd` provisions infrastructure; the Logic App content is packaged from `app/` and deployed separately.
