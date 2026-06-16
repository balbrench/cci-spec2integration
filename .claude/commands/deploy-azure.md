---
description: [Manual] Provision and deploy the Logic Apps Standard solution with azd.
argument-hint: "[--preview] [--confirm-subscription]"
allowed-tools: Read, Grep, Glob, Bash
---

Steps:
1. Verify `azure.yaml` and `infra/main.bicep` exist, plus at least one deployable content tree — `app/` (Logic Apps Standard) and/or `adf/` (Data Factory). Stop if `azure.yaml`/`infra` is missing, or if neither `app/` nor `adf/` exists. Steps 10–12 (Logic App package + deploy) run only when `app/` exists; step 12a (ADF publish) runs only when `adf/` exists.
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
9b. **Apply the SQL schema (only when a sibling `sql/` tree exists).** Bicep provisions an *empty* database; the Logic App calls its stored procedures the moment its recurrence trigger fires, and the ADF data flow sinks into its tables — so the schema MUST be applied **after `azd provision` and before the app/ADF content deploy**. Steps:
   - Resolve `sqlServerFqdn` and `stagingDatabaseName` (or the IR's db name) from `azd env get-values`. If neither a `sql/` tree nor a `dataFactoryName`/SQL output exists, skip.
   - Apply `sql/*.sql` in **lexical order** (`01-schema.sql` → `02-procedures.sql` → `03-grants.sql`) against the database using the deployer's AAD token — `sqlcmd -G -S <fqdn> -d <db> -i <file>` or PowerShell `Invoke-Sqlcmd -AccessToken (az account get-access-token --resource https://database.windows.net/ --query accessToken -o tsv) -ServerInstance <fqdn> -Database <db> -InputFile <file>`. **Never pass a SQL password** — the deployer is the AAD admin set at provision time (Article V). The scripts are idempotent, so re-running is safe.
   - Before applying `03-grants.sql`, substitute the `__mi_*__` tokens with the provisioned resource names from `azd env get-values`: `__mi_logicapp__`→`logicAppName`, `__mi_datafactory__`→`dataFactoryName`, `__mi_functionapp_<Flow>__`→that Function App's name. These create the managed-identity DB users (`CREATE USER [...] FROM EXTERNAL PROVIDER`) the flows authenticate as.
   - If a SQL apply fails (e.g. the deployer is not the AAD admin, or the firewall blocks the client IP), print the error and stop — the flows will fail at runtime without the schema, so do not proceed to deploy app/ADF content on top of a hollow database.
10. If a sibling `Functions/*.csproj` project exists, run `dotnet build` on it before packaging so local-function DLLs are published into `app/lib/custom/net8/`. If no sibling `Functions` project exists, skip compilation.
11. Package the contents of `app/` for Logic Apps Standard deployment (skip steps 10–12 entirely if there is no `app/` tree). Exclude local-only or tooling-only files such as `local.settings.json`, `.vscode/`, `workflow-designtime/`, `.azurite/`, `__azurite*`, `bin/`, and `obj/`.
12. Deploy the packaged `app/` content to the provisioned Logic App Standard site using zip deployment. Do not ask `azd` to build or deploy the Logic App project itself.
12a. **Data Factory artifacts (only when a sibling `adf/` tree exists).** If the integration folder contains a non-empty `adf/` directory, publish its artifacts into the factory that `azd provision` created (the factory *resource* is emitted by `infra/`; the pipeline/dataset/dataflow/linkedService/trigger JSON is **not** deployed by `azd` and `azd deploy` does nothing for it). Steps:
   - Resolve the resource group and factory name from `azd env get-values` (`resourceGroupName`, `dataFactoryName`). If `dataFactoryName` is absent, the IR has no Data Factory flow — skip.
   - Ensure the CLI extension is present: `az extension add --name datafactory --upgrade --yes`.
   - Import in strict dependency order — **linkedServices → datasets → dataflows → pipelines → triggers** — with `az datafactory <type> create`, reading each file's `.name` and `.properties` (e.g. via `jq`).
   - **`az datafactory data-flow create` requires an explicit `--flow-type`** (e.g. `MappingDataFlow`) read from the artifact's `.properties.type`; it is NOT inferred from `--properties`. Omitting it errors `the following arguments are required: --flow-type/-t`.
   - **Strip a `connectVia` block that references `AutoResolveIntegrationRuntime`** before `linked-service create`. On a freshly-provisioned factory that reference fails validation (`InputIsMalformedDetailed: Could not get integration runtime details for AutoResolveIntegrationRuntime`); auto-resolve is the default IR, so omitting `connectVia` is behaviourally identical and deploys cleanly.
   - For triggers, substitute the `__env_*__` deploy-time tokens (`__env_blobServiceEndpoint__`, `__env_sqlServerFqdn__`, `__env_databaseName__`, `__env_sourceStorageAccountResourceId__`, `__env_keyVaultUri__`) from the matching `azd env get-values` keys before create. Leave a trigger **stopped** unless the IR declares it active (`runtimeState=Started`).
   - Smoke-check with `az datafactory pipeline show` for at least one imported pipeline.
   - This mirrors the `publish-adf-*` jobs in `app/.github/workflows/deploy.yml` (authored by `azure-cicd-author`) so a manual `/deploy-azure` matches CI. If `adf/` is absent or empty, skip silently.
13. On success, print the endpoint and resource group name returned by the infrastructure deploy, together with the active subscription name and id used for the deployment. When ADF artifacts were published, also print the factory name and the count of pipelines imported.
14. On failure, print the Azure / azd error and do not retry.
15. On success, refresh `<folder>/status.json` per `.claude/skills/pipeline-status/SKILL.md`. Mark stage 12 (Deploy) as `done` with summary `<endpoint> in <resource-group>` (append `+ ADF <factory>` when Data Factory artifacts were published). On failure, leave stage 12 untouched.

Rules:
- Do not guess or infer the subscription from repo files. Use the live Azure CLI context only.
- Do not switch subscriptions automatically.
- If multiple subscriptions are visible, require explicit confirmation before deployment by stopping unless `--confirm-subscription` is present.
- If the current subscription is wrong, stop after showing the available subscriptions and tell the user to change context, then rerun `/deploy-azure`.
- Do not hard-code subscription ids or tenant ids.
- Do not compile the Logic Apps Standard project itself. Only build a sibling `Functions/*.csproj` project when local functions exist.
- Do not model Logic Apps Standard `app/` as an `azd` application service. `azd` provisions infrastructure; the Logic App content is packaged from `app/` and deployed separately.
- A solution may contain a sibling `adf/` artifact tree (Data Factory flows) alongside or instead of `app/`. `azd provision` creates the factory *resource*; its artifacts are published separately with `az datafactory`, never by `azd deploy`. Do not skip the ADF publish (step 12a) when `adf/` is present — a manual deploy that provisions an empty factory and stays silent is a partial deploy.
