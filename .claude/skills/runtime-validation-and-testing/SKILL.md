---
name: runtime-validation-and-testing
description: Rules for runtime validation and end-to-end testing of converted Logic Apps Standard projects. Covers func start validation, local E2E test matrix, splitOn verification, retry/timeout adaptation, test reporting, and no-source-platform-infra policy.
---

# Runtime Validation and Testing

> Purpose: Authoritative rules for validating and testing converted Logic Apps Standard projects. Follow exactly.

## 1. Runtime validation

- Run `func start --verbose` in the generated Logic Apps project folder.
- Check the output for runtime startup failures, bad connections, missing settings, missing artifacts, and schema-loading errors.
- **`parameters.json` type check (Sev-1).** Every entry in `parameters.json` must have BOTH a `type` (PascalCase: `String`/`Int`/`Bool`/`Object`/`Array`/`Float`/`SecureString`/`SecureObject`) and a `value`. A value-only entry makes the host fail with `Microsoft.Azure.Workflows.Templates: Template parameter type '' is not supported` and `Runtime version: Error` — the whole app is dead. `func start` surfaces this at load; treat it as a hard block. Also confirm the parameter names match each workflow's `definition.parameters`. This is easy to miss locally and only shows after deploy, so verify it here.
- Fix issues found and re-run until the runtime starts cleanly with no errors.
- For local execution, ensure Azurite is running when `AzureWebJobsStorage=UseDevelopmentStorage=true`.

## 2. Local E2E test matrix

Test all workflows end-to-end locally. Run every applicable scenario:

1. Happy path — valid input, expected successful output.
2. Error path — invalid or malformed input, verify error handling works.
3. Cross-workflow chain — if workflow A triggers workflow B, test the entire chain.
4. Timeout/retry path — if any workflow has timeout or retry logic, test it.
5. Resubmission path — if the flow supports message resubmission, test it.
6. SplitOn check — if any trigger returns an array and the workflow uses `For_each` where `splitOn` should be used, fix it and re-test.

Trigger each workflow according to trigger type:

- HTTP → `curl` / `Invoke-WebRequest`
- File → place the file in the configured `mountPath`
- Service Bus → send a message to the configured queue or topic
- Timer → verify execution via runtime logs

If a workflow fails, fix the issue and re-test until all applicable scenarios pass.

## 2a. Output content validation

Workflow completion (`status == Succeeded`) is necessary but not sufficient. For every output produced during E2E testing, perform field-level content validation:

1. Parse every output file or message and inspect the actual XML or JSON content.
2. Verify non-empty fields — any field that should carry a propagated value must be populated.
3. Verify value propagation — trace key business fields (IDs, amounts, dates, counts, names) from input through every transformation to output.
4. Verify constant and static values — status codes, acknowledgment strings, booleans, flags.
5. Verify collection preservation — repeating elements and arrays must retain all items, not just the first.
6. Compare against source behavior — for reverse-engineered flows, confirm the migrated workflow is semantically equivalent to the source-platform output for the same input.

If any field is empty, truncated, or contains the wrong value, treat it as a test failure even if the workflow status is `Succeeded`. Fix the root cause and re-test.

## 3. Test adaptation rules

- Never skip tests because a production timer, retry interval, or timeout is long.
- Temporarily reduce such values to test-friendly durations.
- Run the tests.
- Revert to production values after testing.
- Document all adaptations and reversions in the test report.

## 4. No source-platform infrastructure

During testing, never connect to original source-platform infrastructure (on-prem SQL Server, file shares, MQ, FTP, SAP, BizTalk environments, etc.).

- For local-capable connectors, use local resources.
- For cloud-only connectors (Service Bus, Event Hubs, Integration Account), use only Azure resources provisioned for the target integration.
- Do not depend on source-environment availability to validate the migration.

## 5. Local-first resource strategy

- Use Azurite for `AzureWebJobsStorage` where applicable.
- Use local file paths for File System connector `mountPath`.
- Use `localhost` for HTTP-triggered workflows.
- Prefer Docker containers for SQL Server, PostgreSQL, MySQL, Cosmos DB, or SFTP when a local equivalent is needed.
- Provision Azure resources only for connectors with no local or Docker alternative.

## 6. TEST-REPORT.md

After testing, generate `TEST-REPORT.md` in the integration project root. This report is mandatory.

Include:

- Test results per workflow.
- Output content validation results — per output, per validated field, expected vs actual, pass/fail.
- Summary count of field-level checks.
- Azure resources used during testing.
- Adjustments made during testing.
- Any design deviations from the plan (should normally be none).
- Re-test instructions with exact commands.

## 7. Completion gate

Do not consider local validation complete until:

- the runtime starts cleanly,
- all applicable E2E scenarios pass,
- field-level output validation passes, and
- `TEST-REPORT.md` exists in the project root.
