---
name: logic-apps-rules-engine
description: Converting BizTalk Business Rules Engine (BRE) policies/vocabularies to the Azure Logic Apps Standard Rules Engine. Covers the Rules Engine project layout, the Microsoft.Azure.Workflows.RuleEngine API (FileStoreRuleExplorer + RuleSet execution invoked via InvokeFunction), fact types (XML / .NET objects), vocabulary and ruleset porting, and the IR `runtime: bre` dependency mapping. Consumed by biztalk-ir-compiler (IR mapping) and azure-local-functions-author / azure-logic-apps-compiler (implementation). Bundles the official Microsoft Rules Engine docs under reference/.
---

# logic-apps-rules-engine skill

The BizTalk **Business Rules Engine (BRE)** has a first-class successor in Logic Apps Standard: the **Azure Logic Apps Rules Engine** — a .NET decision/inference engine that executes BRE-compatible rulesets over XML and .NET-object "facts". A BizTalk BRE policy is **not** custom code to hand-rewrite; it ports to a Rules Engine ruleset and is invoked from a workflow. This is the target for any IR dependency with `runtime: bre`.

## reference/ contents (official Microsoft docs)

`rules-engine-overview.md`, `create-rules-engine-project.md`, `create-rules.md`, `create-manage-vocabularies.md`, `build-fact-creators-retrievers.md`, `add-rules-operators.md`, `add-rules-control-functions.md`, `perform-advanced-ruleset-tasks.md`, `rules-engine-optimization.md`, `test-rulesets.md`.

## 1. IR mapping (biztalk-ir-compiler — already wired)

A BizTalk **Call Rules** shape / BRE policy maps to an IR `execute`/`invoke` step with a dependency of `kind: function`, `runtime: bre`, `codeRef` to the policy `.xml`, and a `migrationHint` from the inventory `breMap` (policy → rule count, vocabulary names). Keep the ruleset name as a stable identifier — it is the `ruleSetName` passed at invocation.

## 2. Implementation target (azure-local-functions-author / azure-logic-apps-compiler)

The Rules Engine runs **in-process** as a Logic Apps Standard local function (Custom Code) — so a `runtime: bre` dependency compiles to an `InvokeFunction` action whose function wraps the Rules Engine API. Do NOT model it as a stand-alone Function App or inline expression.

**Project layout** (`create-rules-engine-project.md`): the local-functions project gains a `Rules/` folder holding the ported ruleset/vocabulary `.xml` files; the `FileStoreRuleExplorer` loads them by name at runtime.

**The function shape** (namespace `Microsoft.Azure.Workflows.RuleEngine`):
```csharp
using Microsoft.Azure.Functions.Extensions.Workflows;
using Microsoft.Azure.Workflows.RuleEngine;

public sealed class ApplyPurchaseRules
{
    private readonly FileStoreRuleExplorer ruleExplorer;
    public ApplyPurchaseRules(ILoggerFactory lf) => this.ruleExplorer = new FileStoreRuleExplorer(lf);

    [FunctionName(nameof(ApplyPurchaseRules))]
    public RuleExecutionResult Run(
        [WorkflowActionTrigger] string ruleSetName,   // the ported BRE policy name
        string factXml)                               // the XML fact (typically the upstream message body)
    {
        var ruleSet = this.ruleExplorer.GetRuleSet(ruleSetName)
            ?? throw new Exception($"RuleSet '{ruleSetName}' was not found.");
        // build typed/XML facts, execute the ruleset, return the asserted/updated facts
        ...
    }
}
```
- **Facts** are XML documents (`TypedXmlDocument`) and/or .NET objects (`build-fact-creators-retrievers.md`). Map BizTalk fact types accordingly: XML schema facts → `TypedXmlDocument` over the preserved XSD; .NET facts → POCOs recovered from the helper assembly.
- **Vocabularies** (`create-manage-vocabularies.md`) port 1:1; keep vocabulary names so rule readability survives.
- **Operators / control functions** — `add-rules-operators.md`, `add-rules-control-functions.md` give the supported set; if a BizTalk rule uses a custom .NET member that has no equivalent, surface it as a migration note rather than silently dropping it.
- Author/edit rulesets with the **Microsoft Rules Composer** (BizTalk-compatible) — the ported `.brl`/policy XML is largely reusable.

## 3. Honor no-stubs + testing

- The ported ruleset must be the real recovered logic (no empty rulesets / `TODO`). If a BRE policy can't be recovered (source-less), it follows the same BLOCKED-flow path as any manual artifact.
- `test-rulesets.md` covers ruleset testing; the `azure-workflow-tester` mocks the `InvokeFunction` Rules Engine call like any other local function (success/failure), and a dedicated ruleset test asserts the asserted facts.

## 4. When NOT to use the Rules Engine

A trivial BizTalk Decide shape or a single boolean policy is better expressed as a workflow `If`/`Switch` (per `eip-to-azure-mapping`) — reserve the Rules Engine for genuine multi-rule rulesets / forward-chaining inference. The `logic-apps-planning-rules` component ladder still applies: prefer a built-in control shape when the logic is a simple branch.
