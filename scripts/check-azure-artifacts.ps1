# check-azure-artifacts.ps1
#
# Deterministic gate for the Azure artifact tree that /implement-azure emits.
# The generating agents have no Bash, so they cannot parse, build or test what
# they write; every check here catches a defect that shipped undetected before
# the check existed. Called by /implement-azure (gates 8c-8e) and by CI.
#
# Usage:
#   powershell -File scripts/check-azure-artifacts.ps1 -Folder specs/<domain>/NNN-<slug> [-Build] [-Test]
#
#   (no switch)  static checks only (JSON parse, workflow shape rules, SQL and
#                Bicep rules, stored-procedure cross-check, paired-test presence)
#   -Build       also `dotnet build` every project (Functions/ first, so
#                app/lib/custom/net8 holds the DLLs the workflow tests load)
#   -Test        also `dotnet test` every tests-mstest/*/*.csproj, ONE AT A
#                TIME (Logic Apps test hosts all bind port 7071)
#
# Output: one line per finding, "ERROR <rule> <file>: <message>" or
# "WARN  <rule> <file>: <message>", then a summary line. Exit code 1 when any
# ERROR was reported, else 0. Compatible with Windows PowerShell 5.1 and pwsh 7.

param(
    [Parameter(Mandatory = $true)][string]$Folder,
    [switch]$Build,
    [switch]$Test
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$root = (Get-Item -LiteralPath $Folder).FullName.TrimEnd('\', '/')
$script:errors = 0
$script:warnings = 0

function Rel([string]$path) {
    if ($path.StartsWith($root)) { return $path.Substring($root.Length).TrimStart('\', '/') }
    return $path
}
function Report([string]$level, [string]$rule, [string]$file, [string]$message) {
    if ($level -eq 'ERROR') { $script:errors++ } else { $script:warnings++ }
    Write-Output ("{0,-5} {1} {2}: {3}" -f $level, $rule, (Rel $file), $message)
}
function Get-Files([string]$sub, [string]$filter) {
    $dir = Join-Path $root $sub
    if (-not (Test-Path -LiteralPath $dir)) { return @() }
    return @(Get-ChildItem -LiteralPath $dir -Recurse -File -Filter $filter |
        Where-Object { $_.FullName -notmatch '[\\/](bin|obj|node_modules|TestResults|\.vscode)[\\/]' })
}
function Test-Prop($obj, [string]$name) {
    return ($null -ne $obj) -and ($obj -is [psobject]) -and ($obj.PSObject.Properties.Name -contains $name)
}
function Get-Children($obj) {
    if ($null -eq $obj -or -not ($obj -is [psobject])) { return @() }
    return @($obj.PSObject.Properties)
}

# ---------------------------------------------------------------- 1. JSON parse
# Every JSON file the runtime or ARM will read must strict-parse.
$parsed = @{}
$jsonFiles = @()
$jsonFiles += Get-Files 'app' '*.json' | Where-Object { $_.FullName -notmatch '[\\/]\.github[\\/]' }
$jsonFiles += Get-Files 'adf' '*.json'
$jsonFiles += Get-Files 'FunctionApps' 'host.json'
foreach ($f in $jsonFiles) {
    try {
        $parsed[$f.FullName] = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json
    } catch {
        Report 'ERROR' 'JSON_PARSE' $f.FullName ($_.Exception.Message -split "`n")[0]
    }
}

# ---------------------------------------------------------------- 2. workflow.json shape rules
# workflow-json-rules §8.6, §8.6a, §8.6c. All are rejected by the runtime; the
# secured-action rule is NOT enforced by the unit-test host.
$calledProcs = @()   # @{ name; params; file }

function Test-SchemaPattern($node) {
    foreach ($p in (Get-Children $node)) {
        if ($p.Name -eq 'pattern' -or $p.Name -eq 'patternProperties') { return $true }
        $v = $p.Value
        if ($v -is [System.Array]) { foreach ($i in $v) { if (Test-SchemaPattern $i) { return $true } } }
        elseif ($v -is [psobject]) { if (Test-SchemaPattern $v) { return $true } }
    }
    return $false
}

function Test-Actions($actions, [string]$file) {
    foreach ($a in (Get-Children $actions)) {
        $name = $a.Name; $act = $a.Value
        $type = if (Test-Prop $act 'type') { [string]$act.type } else { '' }

        if ($type -eq 'ServiceProvider' -and (Test-Prop $act 'limit')) {
            Report 'ERROR' 'SERVICEPROVIDER_LIMIT' $file "action '$name': 'limit' is not allowed on ServiceProvider actions (workflow-json-rules 8.6a)"
        }
        if ($type -eq 'ParseJson' -and (Test-Prop $act 'inputs') -and (Test-Prop $act.inputs 'schema') -and (Test-SchemaPattern $act.inputs.schema)) {
            Report 'ERROR' 'PARSEJSON_PATTERN' $file "action '$name': Parse JSON schema contains pattern/patternProperties (workflow-json-rules 8.6)"
        }
        $secured = (Test-Prop $act 'runtimeConfiguration') -and (Test-Prop $act.runtimeConfiguration 'secureData')
        if ($secured -and (Test-Prop $act 'trackedProperties')) {
            Report 'ERROR' 'TRACKED_ON_SECURED' $file "action '$name': trackedProperties on an action with secureData (workflow-json-rules 8.6c)"
        }
        if ($type -eq 'Switch' -and (Test-Prop $act 'cases') -and @(Get-Children $act.cases).Count -eq 1) {
            Report 'WARN' 'ONE_CASE_SWITCH' $file "action '$name': one-case Switch; emit If/else so tests can see the branch actions (workflow-json-rules 8.6a)"
        }
        if ($type -eq 'ServiceProvider' -and (Test-Prop $act 'inputs') -and (Test-Prop $act.inputs 'parameters') -and (Test-Prop $act.inputs.parameters 'storedProcedureName')) {
            $params = @()
            if (Test-Prop $act.inputs.parameters 'storedProcedureParameters') {
                $params = @(Get-Children $act.inputs.parameters.storedProcedureParameters | ForEach-Object { $_.Name })
            }
            $script:calledProcs += , @{ name = [string]$act.inputs.parameters.storedProcedureName; params = $params; file = $file; action = $name }
        }

        # Recurse into every nested action container.
        if (Test-Prop $act 'actions') { Test-Actions $act.actions $file }
        if ((Test-Prop $act 'else') -and (Test-Prop $act.else 'actions')) { Test-Actions $act.else.actions $file }
        if ((Test-Prop $act 'default') -and (Test-Prop $act.default 'actions')) { Test-Actions $act.default.actions $file }
        if (Test-Prop $act 'cases') {
            foreach ($c in (Get-Children $act.cases)) { if (Test-Prop $c.Value 'actions') { Test-Actions $c.Value.actions $file } }
        }
    }
}

foreach ($f in (Get-Files 'app' 'workflow.json')) {
    $wf = $parsed[$f.FullName]
    if ($null -eq $wf -or -not (Test-Prop $wf 'definition')) { continue }
    if (Test-Prop $wf.definition 'triggers') {
        foreach ($t in (Get-Children $wf.definition.triggers)) {
            $tr = $t.Value
            if ((Test-Prop $tr 'runtimeConfiguration') -and (Test-Prop $tr.runtimeConfiguration 'secureData') -and (Test-Prop $tr 'trackedProperties')) {
                Report 'ERROR' 'TRACKED_ON_SECURED' $f.FullName "trigger '$($t.Name)': trackedProperties on a secured trigger"
            }
        }
    }
    if (Test-Prop $wf.definition 'actions') { Test-Actions $wf.definition.actions $f.FullName }
}

# ---------------------------------------------------------------- 3. parameters.json types
foreach ($f in (Get-Files 'app' 'parameters.json')) {
    $p = $parsed[$f.FullName]
    foreach ($e in (Get-Children $p)) {
        if ((Test-Prop $e.Value 'type') -and ([string]$e.Value.type -match '^(?i)secure(string|object)$')) {
            Report 'ERROR' 'PARAMETERS_SECURE_TYPE' $f.FullName "parameter '$($e.Name)': type $($e.Value.type) is not accepted in parameters.json; use String with an @appsetting() Key Vault reference (azure-connections-binder)"
        }
    }
}

# ---------------------------------------------------------------- 4. SQL rules + stored-procedure cross-check
$sqlFiles = Get-Files 'sql' '*.sql'
$procs = @{}   # lower-case name without schema/brackets -> @(param names, lower-case)
foreach ($f in $sqlFiles) {
    $text = Get-Content -LiteralPath $f.FullName -Raw
    # Ignore comments for rule matching.
    $code = [regex]::Replace($text, '(?s)/\*.*?\*/', '')
    $code = [regex]::Replace($code, '--[^\r\n]*', '')
    if ($code -match '(?i)FROM\s+EXTERNAL\s+PROVIDER') {
        Report 'ERROR' 'SQL_EXTERNAL_PROVIDER' $f.FullName 'CREATE USER ... FROM EXTERNAL PROVIDER needs Directory Readers on the server identity; create users WITH SID = ..., TYPE = E (azure-sql-schema-author)'
    }
    $defs = [regex]::Matches($code, '(?is)CREATE\s+(?:OR\s+ALTER\s+)?PROC(?:EDURE)?\s+((?:\[?\w+\]?\.)?\[?(\w+)\]?)(.*?)\bAS\b')
    foreach ($m in $defs) {
        $pn = $m.Groups[2].Value.ToLowerInvariant()
        $params = @([regex]::Matches($m.Groups[3].Value, '@(\w+)') | ForEach-Object { $_.Groups[1].Value.ToLowerInvariant() })
        $procs[$pn] = $params
    }
}
foreach ($c in $calledProcs) {
    $short = ($c.name -replace '^\[?\w+\]?\.', '' -replace '[\[\]]', '').ToLowerInvariant()
    if ($sqlFiles.Count -eq 0) {
        Report 'ERROR' 'SQL_PROC_MISSING' $c.file "action '$($c.action)' calls $($c.name) but there is no sql/ tree"
    } elseif (-not $procs.ContainsKey($short)) {
        Report 'ERROR' 'SQL_PROC_MISSING' $c.file "action '$($c.action)' calls $($c.name), which no sql/*.sql script creates"
    } else {
        foreach ($k in $c.params) {
            if ($procs[$short] -notcontains $k.ToLowerInvariant()) {
                Report 'ERROR' 'SQL_PROC_PARAM' $c.file "action '$($c.action)' passes '$k' to $($c.name), which declares no @$k"
            }
        }
    }
}

# ---------------------------------------------------------------- 5. Bicep: SQL audit statement capture
foreach ($f in (Get-Files 'infra' '*.bicep')) {
    $code = [regex]::Replace((Get-Content -LiteralPath $f.FullName -Raw), '//[^\r\n]*', '')
    foreach ($g in 'BATCH_COMPLETED_GROUP', 'BATCH_STARTED_GROUP', 'SCHEMA_OBJECT_ACCESS_GROUP') {
        if ($code -match "'$g'") {
            Report 'WARN' 'SQL_AUDIT_STATEMENT_TEXT' $f.FullName "$g records statement text, including procedure parameters; not allowed when a SQL-bound message is confidential/restricted or has pii fields (azure-bicep-author)"
        }
    }
}

# ---------------------------------------------------------------- 6. Paired tests (Article VII)
$faDir = Join-Path $root 'FunctionApps'
if (Test-Path -LiteralPath $faDir) {
    foreach ($proj in (Get-ChildItem -LiteralPath $faDir -Directory)) {
        $csproj = Join-Path $proj.FullName "$($proj.Name).csproj"
        if (-not (Test-Path -LiteralPath $csproj)) { continue }
        $content = Get-Content -LiteralPath $csproj -Raw
        if ($content -notmatch '(?i)<AzureFunctionsVersion>') { continue }   # a shared library, not a Function App
        $testProj = Join-Path $root "tests-mstest/$($proj.Name).Tests/$($proj.Name).Tests.csproj"
        if (-not (Test-Path -LiteralPath $testProj)) {
            Report 'ERROR' 'FUNCTIONAPP_NO_TESTS' $csproj "no paired test project tests-mstest/$($proj.Name).Tests/ (Article VII, azure-functions-compiler step 10)"
        }
    }
}
foreach ($tp in (Get-Files 'tests-mstest' '*.Tests.csproj')) {
    $content = Get-Content -LiteralPath $tp.FullName -Raw
    if ($content -match '(?i)MSTest\.TestFramework' -and $content -notmatch 'Microsoft\.VisualStudio\.TestTools\.UnitTesting') {
        $dirProps = Join-Path $tp.DirectoryName 'Directory.Build.props'
        $parentProps = Join-Path (Split-Path $tp.DirectoryName -Parent) 'Directory.Build.props'
        $viaProps = $false
        foreach ($pp in $dirProps, $parentProps) {
            if ((Test-Path -LiteralPath $pp) -and ((Get-Content -LiteralPath $pp -Raw) -match 'Microsoft\.VisualStudio\.TestTools\.UnitTesting')) { $viaProps = $true }
        }
        if (-not $viaProps) {
            Report 'WARN' 'MSTEST_USING' $tp.FullName 'no <Using Include="Microsoft.VisualStudio.TestTools.UnitTesting" />; ImplicitUsings does not import MSTest (CS0246 unless every file has the using)'
        }
    }
}

# ---------------------------------------------------------------- 7. dotnet build / test
# Streams dotnet's output straight to the host and records a finding on failure.
# Returns nothing, so callers never swallow the output by discarding a return value.
$script:dotnetRuns = 0
function Invoke-Dotnet([string[]]$arguments, [string]$label) {
    $script:dotnetRuns++
    Write-Output "----- dotnet $($arguments[0]) $(Rel $arguments[1])"
    & dotnet @arguments 2>&1 | Out-Host
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        Report 'ERROR' $label $arguments[1] "dotnet $($arguments[0]) exited $code"
    } else {
        Write-Output "      ok"
    }
}

if ($Build -or $Test) {
    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
        Report 'ERROR' 'DOTNET_MISSING' $root 'dotnet SDK not on PATH; cannot run the build/test gates'
    } else {
        # Order matters: the in-process custom code publishes into app/lib/custom/net8, which the workflow tests load.
        $buildOrder = @()
        $buildOrder += Get-Files 'Functions' '*.csproj'
        $buildOrder += Get-Files 'FunctionApps' '*.csproj'
        $buildOrder += Get-Files 'tests-mstest' '*.csproj'
        if ($buildOrder.Count -eq 0) { Write-Output 'check-azure-artifacts: no .csproj found; build/test gates not applicable' }
        foreach ($p in $buildOrder) { Invoke-Dotnet @('build', $p.FullName, '--nologo', '-v', 'q') 'DOTNET_BUILD' }

        if ($Test) {
            # Sequential on purpose: every Logic Apps test host binds port 7071.
            foreach ($p in (Get-Files 'tests-mstest' '*.Tests.csproj')) {
                Invoke-Dotnet @('test', $p.FullName, '--no-build', '--nologo', '-v', 'q') 'DOTNET_TEST'
            }
        }
    }
}

Write-Output ("check-azure-artifacts: {0} error(s), {1} warning(s), {2} stored-procedure call(s) checked, {3} dotnet run(s)" -f $script:errors, $script:warnings, $calledProcs.Count, $script:dotnetRuns)
if ($script:errors -gt 0) { exit 1 } else { exit 0 }
