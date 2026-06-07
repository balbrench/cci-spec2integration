---
name: biztalk-decompilation
description: Rules for on-demand decompilation of BizTalk-referenced .NET assemblies (helper DLLs, custom pipeline components, map extension objects, functoid assemblies) with recursive dependency-tree resolution, verification gates, and fail-closed missing-dependency reporting. Used by `biztalk-inventory`, `biztalk-ir-compiler`, and the Azure pack's `azure-local-functions-author` whenever source behaviour exists only in compiled form. Adapted from the Azure Logic Apps Migration Agent reference.
---

# BizTalk Decompilation & Dependency Analysis

> **Purpose**: Recover the real business logic behind every BizTalk artifact whose source is only available as a compiled assembly, and prove that every external reference encountered while doing so is resolved (or explicitly recorded as missing). The goal is not to "decompile everything" but to walk the full dependency tree of code that the analysed flow actually executes.

This skill complements `biztalk-msi-extraction` (which recovers artifacts from an MSI) — it picks up at the point where you have `.dll` files in hand and need to translate them into IR migration hints or .NET local functions.

---

## 1. Decompilation prerequisite (hard gate)

> **⚠️ Sev-1 gate** — Whenever any of the following appears in a flow's dependency closure and its source code is NOT present in the workspace, you MUST decompile it BEFORE producing IR action mappings, planning workflows, or generating `InvokeFunction` actions:
>
> - A BizTalk orchestration that calls a .NET helper class.
> - A map that uses scripting functoids backed by a `.dll`.
> - A custom pipeline component (typed `Type = PipelineComponent` in the MSI ADF).
> - A binding file that references an assembly not available as `.cs`.
> - A `<xs:appinfo>` or extension-object reference inside a map XSLT that points at an assembly.
>
> Do NOT proceed to authoring `mappings[]` entries or platform-pack outputs while any of the above is unresolved. Recording the gap is acceptable; emitting a stub is not.

---

## 2. DLL discovery — build the candidate list from references, not from disk

DO build the dependency candidate list from **artifact inventory and source references**:

1. From the BizTalk inventory, enumerate every artifact that is in scope for the current flow group (orchestrations, maps, pipelines, custom pipeline components, helper assemblies).
2. For each, harvest the assembly/namespace references it declares (orchestration `using` statements, map `ExtensionObjects` / scripting functoids, pipeline component `Type` references, binding `AssemblyQualifiedName` values).
3. The union of those references — minus framework / BizTalk runtime assemblies — is the candidate list.

DO NOT just enumerate `*.dll` at the workspace root and call that "complete". The most common false negative comes from concluding closure based on a directory listing.

### Anti-pattern to avoid

```powershell
Get-ChildItem -Filter *.dll   # using this alone to declare "all dependencies decompiled"
```

A flow can depend on assemblies that never appear at the workspace root (they live next to a parent assembly, inside an MSI CAB, or in a GAC reference). The flow can also have several DLLs at the root that the analysed flow does not touch.

---

## 2.1 Reference resolution & fail-closed verification (Sev-1 gate)

> **⚠️ You MUST run an actual filesystem search before declaring any referenced artifact "missing" / "no source" / `manual` / `# BLOCKED:` / `x-unresolved`.** A reference path or a folder name is NOT evidence of absence. The single most damaging false negative in this pipeline is scoring recoverable source as missing because the agent reasoned from a reference string instead of probing the disk.

Three traps cause this false negative — guard against all three:

1. **Folder name ≠ assembly name.** A project's `<AssemblyName>` (and the DLL it produces) frequently differs from its containing folder. Real example: `PurchaseLibrary/PurchaseHelper.csproj` has `<AssemblyName>PurchaseHelper</AssemblyName>` — an orchestration referencing assembly `PurchaseHelper` resolves to the `PurchaseLibrary` folder, NOT a `PurchaseHelper` folder. **Resolve by reading the `<AssemblyName>`/`<RootNamespace>` of every `.csproj`/`.vbproj` in the solution, not by globbing for a folder whose name matches the assembly.**

2. **MSI-less projects still have full source.** Not every BizTalk project ships an MSI. The absence of an `_extracted/<name>/` entry or an `_manifest.json` row does NOT mean the source is missing. When the `_extracted/` manifest does not cover a project, fall back to the **original on-disk solution source tree** (`*.btproj`, `*.csproj`, `*.vbproj`, `*.cs`, `*.vb`, `*.xsd`, `*.btm`, `*.odx`). Reading the original source for *resolution* is allowed and required; only decompilation *output* is workspace-bounded (§3.2).

3. **Relative reference paths must be resolved, then `stat`-ed.** A `<ProjectReference Include="..\PurchaseLibrary\PurchaseHelper.csproj">` or an `.odx` `ExternalDeclaration` gives a path relative to the referencing project. Resolve it against the referencing project's directory and confirm existence on disk. "The path looks like it points outside the project" is not absence.

### Mandatory resolution procedure (before any "missing" verdict)

For every referenced assembly / schema / map / orchestration not already resolved via `_extracted/`:

1. **Glob the entire solution folder** for the candidate by base name and by extension family: `<solutionRoot>/**/*.csproj`, `**/*.cs`, `**/*.xsd`, `**/*.btm`, `**/*.odx`.
2. For assembly references, read every `.csproj`/`.vbproj` `<AssemblyName>` and `<RootNamespace>`; match the reference against those values (case-insensitive), not against the folder name.
3. Resolve any relative reference path against the referencing project directory and confirm the target exists.
4. **Record the exact path(s) you searched and the result** in the artifact's notes (e.g. `searched: PurchaseSample/**/*.csproj → matched PurchaseLibrary/PurchaseHelper.csproj (AssemblyName=PurchaseHelper)`). A "missing" verdict is only valid when accompanied by the searched paths that came back empty.

A `manual` / `# BLOCKED:` / `x-unresolved` verdict that does not cite a performed-and-empty filesystem search is itself a Sev-1 defect — the artifact is presumed recoverable until the search proves otherwise.

---

## 3. Decompilation procedure

### 3.1 Tool

Use `ilspycmd` (the cross-platform ILSpy CLI):

```powershell
# install once
dotnet tool install -g ilspycmd
```

```powershell
# decompile a single assembly
ilspycmd "<DllPath>" -o "out/__decompiled__/<DllNameWithoutExtension>/"
```

### 3.2 Output location — workspace-bounded

**ALWAYS** write decompilation output to `out/__decompiled__/` **inside the current migration workspace** (the integration folder under `specs/**/NNN-<slug>/`). NEVER write to:

- the original source folder,
- an extracted MSI staging folder,
- the BizTalk solution checkout,
- the user's `%TEMP%` or any other path outside the workspace.

This keeps the artifact graph reproducible: every output is git-trackable, and re-running the pipeline cannot pick up stale decompiled code from outside the workspace.

### 3.3 When decompilation fails

If `ilspycmd` exits with a non-zero status, the binary is native, obfuscated, or built against an unsupported framework. Record the assembly as a **critical missing dependency** (`severity=critical`, `blocksMigration=true`) and STOP for that branch — do not emit a stub local function.

---

## 4. Recursive dependency-tree resolution

After decompiling a DLL, inspect what *it* depends on and walk the full tree:

1. Read the decompiled `.cs` files. Harvest:
   - every `using` directive
   - every type reference and method call
   - every base-class / interface inheritance
2. For each referenced assembly, check whether it exists in the workspace as `.dll`, `.cs`, or `.csproj`.
3. If it is a `.dll` and has not yet been decompiled, decompile it (return to §3).
4. If that child DLL itself references more DLLs, recurse.
5. **Stop recursion** when the referenced assembly is one of:
   - already decompiled (idempotent), OR
   - a standard framework assembly (`System.*`, `Microsoft.CSharp.*`, `mscorlib`), OR
   - a standard BizTalk runtime assembly (`Microsoft.BizTalk.*`, `Microsoft.XLANGs.*`, `Microsoft.RuleEngine.*`), OR
   - not found in the workspace → record as missing dependency and stop.

---

## 5. Source-vs-decompiled precedence

When deciding whether a dependency is "resolved":

| Available | Decision |
|---|---|
| `.cs` / `.vb` source present in workspace | Use the source directly. Do NOT mark as missing. Do NOT re-decompile. |
| `.dll` decompiled successfully into `out/__decompiled__/` | Treat as resolved. Record the decompiled path in the dependency's `resolution` field. |
| `.dll` present but decompilation failed (native / obfuscated) | Mark as missing. `severity=critical`, `blocksMigration=true`. |
| Reference only (no `.dll`, no source) | Mark as missing. Severity per §7. |

A bare `using` reference does **not** resolve dependency status — resolution requires the actual implementation (source or readable decompiled output) to be available.

---

## 6. Verification gates — required before declaring "no missing dependencies"

You MUST pass **all four** gates below before storing an empty `missingDependencies` array on a flow.

### Gate 1 — Reference-to-artifact

Every non-framework namespace or type referenced by flow-used classes maps to one of:

- source code present in the workspace, OR
- decompiled assembly present under `out/__decompiled__/`, OR
- an explicit `missingDependencies[]` entry.

### Gate 2 — Instantiation / call-site

If the code contains constructor calls or casts to external repo/service types (e.g. `new XRepositorio()`, `(IXRepositorio)new XRepositorio()`), the implementing assembly is mandatory. A type reference *and* an instantiation but no implementation = missing dependency.

### Gate 3 — Using / type

A `using` directive or type reference into a custom namespace with no resolvable artifact is NOT silently ignored. It must be either:

- justified as unused by symbol-level evidence (the type/namespace is never actually referenced after the `using`), or
- recorded as a missing dependency.

### Gate 4 — Flow relevance

Unresolved dependencies in code paths executed by the analysed flow are `migrationRelevant=true`. If they block production of a non-stub implementation, set `severity=critical` and `blocksMigration=true`.

If any gate fails, do NOT return zero missing dependencies. Re-decompile, re-walk the tree, or record the gap. The default is fail-closed.

---

## 7. Missing-dependency record schema

Every entry in a flow's `missingDependencies[]` MUST have:

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier (`md-<short-name>` or hash). |
| `name` | string | Assembly / namespace / artifact name. |
| `type` | `dll` \| `assembly` \| `schema` \| `map` \| `pipeline-component` \| `connector` \| `library` \| `custom-code` \| `other` | |
| `origin` | `standard-framework` \| `standard-biztalk` \| `third-party` \| `custom` \| `unknown` | |
| `severity` | `critical` \| `warning` \| `info` | `critical` blocks migration; `warning` is recoverable with a documented gap; `info` is advisory. |
| `referencedBy` | string[] | Artifact names that reference this dependency. |
| `reason` | string | One sentence on why it is needed for the flow. |
| `blocksMigration` | boolean | `true` if this prevents producing a non-stub implementation. |
| `migrationRelevant` | boolean | `false` for build-only / design-time-only references. |
| `resolution` | string | **Must follow** the exact format: `Add the source code or binary for {name} to the migration source folder and re-run discovery.` Do NOT suggest code workarounds — the user must supply the artifact. |

Each flow group also records:

- `summary` — one paragraph of human-readable context.
- `allCriticalResolved` — boolean. `false` while any `severity=critical` entry exists.
- `counts` — `{ critical, warning, info }`.

### Fail-closed default

When the evidence is incomplete or ambiguous, default to recording the dependency as missing with the appropriate severity rather than declaring resolution. A clean `missingDependencies: []` is valid only when all four gates in §6 pass with explicit evidence.

---

## 8. Translation policy (what to do with the decompiled code)

Once an assembly is decompiled and its real business logic is understood:

1. The conversion agent (`azure-local-functions-author`) translates the real logic into a **.NET local function** invoked from the workflow via `InvokeFunction`. Per `workflow-json-rules` §7b, custom code from source **always** maps to level-5 (local function) — never to expressions, `Compose` + `concat`, or inline JavaScript.
2. Do NOT emit `NotImplementedException`, `// TODO`, or placeholder method bodies. Translate the actual logic.
3. Preserve the original design intent: the local function's public surface should match the source method's surface (parameters, return shape). Refactor freely inside the function body, but do not change what the workflow sees.
4. For custom pipeline components whose `Execute` / `Disassemble` / `GetNext` methods operate on streams of XML, lift the per-message logic into a function. Stream-batching/debatching that BizTalk did at the pipeline layer becomes `splitOn` on the trigger plus per-item actions (see `workflow-json-rules` §3).

---

## 9. Checklist before exiting decompilation phase

Before the agent stops decompiling and moves to IR authoring / planning, confirm:

- [ ] Every DLL **referenced by flow artifacts** has been decompiled, or its source code is available.
- [ ] Every child DLL discovered inside decompiled code has been traced recursively.
- [ ] Helper/utility libraries (e.g. `XmlHelper`, `ResourceHelper`, domain models) are fully decompiled and their public APIs are documented in the flow notes.
- [ ] Custom pipeline components are identified and their `Execute` / `Disassemble` / `GetNext` methods have been read.
- [ ] Shared domain-model classes referenced by multiple orchestrations are catalogued once (no duplicate translation in different local functions).
- [ ] All four §6 verification gates pass, or every failure is recorded as a `missingDependencies[]` entry.

Only then is it safe to call `migration_discovery_storeDependencies` (or the equivalent IR-compiler step) and proceed to planning.

---

_Adapted from the [Azure Logic Apps Migration Agent](https://github.com/Azure/logicapps-migration-agent) reference material._
