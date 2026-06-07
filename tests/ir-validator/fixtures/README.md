# IR Validator — Phase 9 semantic test fixtures

Each subfolder is a self-contained integration IR designed to either pass cleanly or trip one specific Phase 9 semantic rule in [`.claude/agents/ir-validator.md`](../../../.claude/agents/ir-validator.md). The fixtures are the executable specification for the Phase 9 rules — if a fixture stops firing the rule it targets, the rule has regressed.

Each fixture contains:

- `integration-ir.yaml` — the IR to validate.
- `contracts/schemas/*.json` — minimal schemas keeping the cross-reference checks happy.
- `expected-findings.json` — declarative list of Phase 9 rule IDs that should fire, plus the expected verdict.

## Coverage matrix

| Fixture | Phase 9 rules it should trip | Verdict |
|---|---|---|
| [pass-clean/](pass-clean/) | _(none — clean baseline)_ | PASS |
| [fail-step-dag/](fail-step-dag/) | `STEP_CYCLE` (Sev-1), `STEP_UNREACHABLE` (Sev-2) | BLOCKED |
| [fail-orphans/](fail-orphans/) | `CHANNEL_UNUSED`, `MESSAGE_UNUSED`, `MAPPING_UNUSED`, `DEPENDENCY_UNUSED` (all Sev-3) | PASS |
| [fail-trigger/](fail-trigger/) | `TRIGGER_CHANNEL_DIRECTION_INVALID` (Sev-1), `TRIGGER_HTTP_CHANNEL_SHARED` (Sev-2) | BLOCKED |
| [fail-retry/](fail-retry/) | `RETRY_INTERVAL_EXCESSIVE` (Sev-3) | PASS |

The Phase 9 rules NOT covered by a dedicated fixture (`RETRY_POLICY_UNDEFINED`) are currently unreachable because the schema enforces `retry.required: [policy, count, interval]`. The rule is kept as defensive future-proofing — if the schema ever relaxes that constraint, add a fixture.

## How to use

Each fixture is laid out exactly like a normal integration folder (`integration-ir.yaml` at the root, `contracts/schemas/` alongside), so the validator agent can be pointed at it directly:

1. Invoke the `ir-validator` agent (via `/review` or directly) with the fixture's `integration-ir.yaml` as its input path.
2. The agent emits `ir-validation-report.md` and `ir-validation-report.json` next to the IR.
3. Compare the emitted `ir-validation-report.json.findings[].ruleId` set to the `expected-findings.json.phase9Findings[].ruleId` set:
   - Every expected rule ID MUST be present (missing finding = regression in the rule's detection logic).
   - The verdict MUST match (`PASS` or `BLOCKED`).
   - Extra Phase-9 findings beyond the expected list are acceptable IF they reveal a real defect in the fixture — but more often they indicate the fixture accidentally trips an unrelated rule and should be tightened.

The `expectedMessageFragment` field in `expected-findings.json` is a substring the emitted message should contain — not a regex, not a full string match. It's there so a human reading the report can spot-check that the right entity (step id, channel name, flow name) was flagged, not just the right rule.

## Adding a new fixture

1. Copy `pass-clean/` to a sibling folder named `fail-<rule-shorthand>/` (or `pass-<scenario>/`).
2. Edit `integration-ir.yaml` to introduce ONLY the defect you want to test. The fixture should pass every Phase 1-8 check; it should fail ONLY the Phase 9 rule you're exercising. If your fixture also trips an unrelated existing finding, tighten the IR to remove the noise.
3. Update `expected-findings.json` with the rule IDs and severities you expect.
4. Add a row to the coverage matrix above.

## Why these are not automated

The validator is an agent, not a programmatic library. There is no `npm test`-style runner today. These fixtures are still valuable:

- They codify what each rule means in concrete, runnable IR — a future contributor adding a rule has a template to copy.
- A human reviewer can run the agent against any fixture and eyeball the report in under a minute.
- When we eventually wire a programmatic validator (or a `/review` integration test), these fixtures are the input set the test harness will iterate over — `expected-findings.json` is already in machine-readable form.
