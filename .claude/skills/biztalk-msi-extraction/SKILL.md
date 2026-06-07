---
name: biztalk-msi-extraction
description: How to crack a BizTalk application MSI (BTSTask ExportApp output) to recover compiled maps, schemas, orchestrations, custom pipeline components, and helper assemblies — including extracting embedded XSLT/XSD/ODX from BizTalk-compiled DLLs. Used by the biztalk-msi-cracker agent.
---

# BizTalk MSI Extraction Reference

> **Scope:** what's inside a BizTalk Server `BTSTask ExportApp` MSI and how to extract every artifact deterministically without installing the MSI on the host.

> **Reference implementation.** This procedure is implemented end-to-end in [`scripts/crack-msi.ps1`](../../../scripts/crack-msi.ps1) (no Mono.Cecil dependency — managed-resource reflection with an IL-UserString fallback). The `biztalk-msi-cracker` agent **runs that script as its primary path** and only falls back to performing the steps below by hand if the script is unavailable or fails. Keep the script and this document in sync: the manifest schema in §8 is the contract both must satisfy.

---

## 1. MSI structure

A BizTalk application MSI is a Windows Installer database. After an **administrative install** (`msiexec /a`) the payload lays out as:

```
<extract-root>/
  ApplicationDefinition.adf      ← XML manifest of all resources
  <Guid>/
    ITEM~1.CAB                   ← one CAB per resource (numbered, dot-stripped)
    ITEM~2.CAB
    ITEM~N.CAB
```

The CAB filenames are sequential (`ITEM~1.CAB`, `ITEM~2.CAB`, …); the **mapping from CAB to artifact lives in `ApplicationDefinition.adf`** — never guess by index.

---

## 2. ApplicationDefinition.adf

Root: `<ApplicationDefinition>`. Authoritative resource list lives at `ApplicationDefinition/Resources/Resource[]`. Every `Resource` has:

- `Type` — one of `System.BizTalk:BizTalkAssembly`, `System.BizTalk:BizTalkBinding`, `System.BizTalk:Map`, `System.BizTalk:Schema`, `System.BizTalk:Orchestration`, `System.BizTalk:Pipeline`, `System.BizTalk:PipelineComponent`, `System.BizTalk:Policy`, `System.BizTalk:Vocabulary`, `System.BizTalk:Assembly` (plain .NET helper)
- `Luid` — logical identifier (assembly FullName for `BizTalkAssembly`, etc.)
- `ShortCabinetName` — e.g. `ITEM~3.CAB`. **Use this to find the CAB.**
- `Files/File[]/RelativePath` — path inside the CAB once expanded

Key invariant: a single `BizTalkAssembly` resource contains **all** the maps / schemas / orchestrations / pipelines authored in that Visual Studio project, embedded as managed resources in one `.dll`. So `Type = BizTalkAssembly` is the rich one — `Map` / `Schema` / `Orchestration` resources point at metadata files alongside it.

---

## 3. Cracking sequence

### 3a. Administrative install (no actual install)

```powershell
msiexec /a "<msi>" /qn TARGETDIR="<absolute-extract-root>"
```

- `/a` = administrative — extracts files, never registers anything, never requires elevation.
- `TARGETDIR` **must be absolute**. `msiexec` silently fails with relative paths.
- Already-extracted folders are safe to re-use; don't re-run `msiexec` if the ADF is present.

### 3b. CAB expansion

For each `Resource` whose CAB you need:

```powershell
expand -R "<extract-root>/<Guid>/<ShortCabinetName>" "<extract-root>/extracted_artifacts"
```

- `-R` rebuilds the file's stored relative path (e.g. `BizTalkBinding/Application-Foo/BindingInfo.xml`, or `BizTalkAssembly/<AssemblyName>.dll`).
- The DLL is the prize for `BizTalkAssembly` resources — it carries every map/schema/orch as embedded managed resources.

---

## 4. What's embedded in a BizTalk DLL

After expanding a `BizTalkAssembly` CAB you have a `.dll`. Reflection over its manifest resources yields:

| Resource-name pattern                 | Artifact      | Format            |
|---------------------------------------|---------------|-------------------|
| `<Namespace>.<MapClass>.xsl`          | Compiled map  | XSLT 1.0 or 2.0   |
| `<Namespace>.<SchemaClass>.xsd`       | Schema        | XSD               |
| `<Namespace>.<OrchClass>.btx`         | Orchestration | BizTalk binary IL (XLANG/s) |
| `<Namespace>.<OrchClass>.odx`         | Orchestration | Designer source   |
| `<Namespace>.<PipelineClass>.btp`     | Pipeline      | XML graph         |

The naming pattern is BizTalk-deterministic: `<TypeFullName>.<extension>`. There may also be `*.bts` (binary type metadata) — ignore those; they're internal.

**Inline scripts.** Maps using inline C#/VB/JScript scripting functoids (FID 321 `Inline C#`) compile the user code into the **same DLL** as a separate type. The XSLT calls these via `<msxsl:script>` blocks. The DLL is required at runtime; the XSLT alone is not enough. Detection rule: scan the extracted XSLT for `xmlns:userCSharp` / `xmlns:userVBNet` / `xmlns:userJScript` / `xmlns:userXslt` namespaces — if present, flag the map as `migrationHint: manual` (or `local-function` if the inline script body can be lifted).

**External DLL functoids.** `DatabaseLookup` (FID 524) emits an XSLT extension function call resolved at runtime by `Microsoft.BizTalk.BaseFunctoids.DatabaseFunctoid`. Detection rule: scan for `xmlns:ScriptNS` extension namespaces or `<xsl:variable>` with `select="userCSharp:LookupValue(...)"` — these need a sidecar.

---

## 5. Reflection pattern (PowerShell, no BizTalk tools required)

```powershell
# Load DLL into a reflection-only context so dependencies don't have to resolve
$asm = [System.Reflection.Assembly]::ReflectionOnlyLoadFrom($dllPath)

foreach ($name in $asm.GetManifestResourceNames()) {
    $stream = $asm.GetManifestResourceStream($name)
    $reader = New-Object System.IO.StreamReader($stream)
    $body   = $reader.ReadToEnd()
    $reader.Close()

    switch -Regex ($name) {
        '\.xsl$'  { $out = "maps/$name";          break }
        '\.xsd$'  { $out = "schemas/native/$name"; break }
        '\.odx$'  { $out = "orchestrations/$name"; break }
        '\.btp$'  { $out = "pipelines/$name";      break }
        default   { continue }
    }
    Set-Content -LiteralPath $out -Value $body -Encoding UTF8
}
```

**Notes:**
- `ReflectionOnlyLoadFrom` works for BizTalk DLLs without `Microsoft.XLANGs.BaseTypes` resolving, because we only enumerate resources, never invoke types.
- BizTalk-emitted XSLT/XSD/ODX are UTF-16 LE in source but **UTF-8 once embedded as managed resources** — re-encoding is unnecessary.
- For .NET Framework BizTalk DLLs (the common case), use Windows PowerShell 5.1 or `dotnet` with `System.Reflection.Metadata`. PowerShell 7+ on .NET 8 cannot load .NET Framework assemblies in `ReflectionOnly` mode — use `MetadataLoadContext` instead.

### .NET 8 / pwsh 7 alternative

```powershell
Add-Type -AssemblyName System.Reflection.MetadataLoadContext
$resolver = [System.Reflection.PathAssemblyResolver]::new(
    [string[]](Get-ChildItem $dllDir -Filter *.dll | % FullName))
$mlc = [System.Reflection.MetadataLoadContext]::new($resolver)
$asm = $mlc.LoadFromAssemblyPath($dllPath)
# GetManifestResourceNames() works; GetManifestResourceStream() does NOT in MLC.
# For resource bytes use Mono.Cecil or the AssemblyDefinition API:
#   Add-Type -Path (Resolve-Path "Mono.Cecil.dll")
#   $def = [Mono.Cecil.AssemblyDefinition]::ReadAssembly($dllPath)
#   $def.MainModule.Resources | ? { $_ -is [Mono.Cecil.EmbeddedResource] } | % {
#       Set-Content -LiteralPath "out/$($_.Name)" -Value $_.GetResourceData() -Encoding Byte
#   }
```

`Mono.Cecil` is the reliable cross-runtime path — it reads the PE file directly and never executes assembly code.

---

## 6. What to extract per resource type

| Resource Type                       | Extract | Destination (per-MSI)                        |
|-------------------------------------|---------|----------------------------------------------|
| `System.BizTalk:BizTalkAssembly`    | Reflect DLL → embedded `.xsl`, `.xsd`, `.odx`, `.btp` | `_extracted/<msi>/{maps,schemas/native,orchestrations,pipelines}/` |
| `System.BizTalk:BizTalkBinding`     | Expand CAB → `BindingInfo.xml`              | `_extracted/<msi>/bindings/`                 |
| `System.BizTalk:Policy`             | Expand CAB → `*.xml` BRE export             | `_extracted/<msi>/policies/`                 |
| `System.BizTalk:Vocabulary`         | Expand CAB → `*.xml`                        | `_extracted/<msi>/policies/`                 |
| `System.BizTalk:PipelineComponent`  | Expand CAB → `*.dll` (binary, retain as-is) | `_extracted/<msi>/components/`               |
| `System.BizTalk:Assembly` (plain .NET) | Expand CAB → `*.dll`                     | `_extracted/<msi>/helpers/`                  |
| `System.BizTalk:Map` / `:Schema` / `:Orchestration` / `:Pipeline` | Skip — these point at the parent BizTalkAssembly which already gives us the embedded form | — |

---

## 7. Manifest format

Emit `<solution-root>/specs/biztalk/_extracted/_manifest.json`:

```json
{
  "schemaVersion": 1,
  "extractedAt": "2026-05-09T12:34:56Z",
  "msis": [
    {
      "msi": "Aim.XmlMapping.msi",
      "appName": "Aim.XmlMapping",
      "extractedTo": "specs/biztalk/_extracted/Aim.XmlMapping",
      "assemblies": [
        {
          "fullName": "Aim.XmlMapping.Maps, Version=1.0.0.0, Culture=neutral, PublicKeyToken=...",
          "dllPath": "specs/biztalk/_extracted/Aim.XmlMapping/assemblies/Aim.XmlMapping.Maps.dll",
          "maps": [
            {
              "class": "Aim.XmlMapping.Maps.PaymentInbound_To_Payment",
              "xsltPath": "specs/biztalk/_extracted/Aim.XmlMapping/maps/Aim.XmlMapping.Maps.PaymentInbound_To_Payment.xsl",
              "xsltVersion": "1.0",
              "usesInlineScript": false,
              "usesDatabaseLookup": false,
              "extensionNamespaces": []
            }
          ],
          "schemas": [ /* { class, xsdPath, hasFlatFileAnnotations, hasEdiAnnotations, rootElement } */ ],
          "orchestrations": [ /* { class, odxPath } */ ],
          "pipelines": [ /* { class, btpPath, stages: [...] } */ ]
        }
      ],
      "bindings": [ "specs/biztalk/_extracted/Aim.XmlMapping/bindings/BindingInfo.xml" ],
      "policies": [],
      "pipelineComponents": [],
      "helpers": []
    }
  ]
}
```

Downstream agents (`biztalk-contract-extractor`, `biztalk-ir-compiler`) read this manifest to locate XSLT/XSD/ODX without re-cracking the MSI.

---

## 8. Failure modes and how to surface them

| Failure                                     | Action                                                                               |
|---------------------------------------------|--------------------------------------------------------------------------------------|
| `msiexec` not on PATH                       | Skip MSI, record in `_manifest.json` as `{ "skipped": true, "reason": "msiexec-missing" }` |
| `msiexec /a` returns non-zero               | Same as above with `reason: "admin-install-failed"` and stderr captured              |
| `expand` not on PATH                        | Skip CAB, record `reason: "expand-missing"`                                          |
| DLL fails to load (mixed-mode, native)      | Try `Mono.Cecil` fallback; if still fails, record `reason: "reflect-failed"`         |
| Embedded resource is empty / corrupt        | Write empty file to output, record `warnings[].emptyResource: <name>`                |
| Two MSIs produce assemblies with same name  | Disambiguate by MSI folder; never overwrite                                          |

Every failure is **recoverable** — the rest of the pipeline must continue. The cracker never throws; it records.

---

## 9. Idempotency

The cracker is idempotent. On re-run:

1. If `_extracted/<msi>/` exists **and** `_manifest.json` lists this MSI **and** the MSI's mtime ≤ the manifest's `extractedAt`, skip re-extraction for that MSI.
2. Otherwise, wipe `_extracted/<msi>/` and re-extract.
3. Always rewrite `_manifest.json` from scratch — never patch it.
