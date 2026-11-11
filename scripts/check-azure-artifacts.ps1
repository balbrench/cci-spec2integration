# check-azure-artifacts.ps1
#
# Deterministic gate for the Azure artifact tree that /implement-azure emits.
# The generating agents have no Bash, so they cannot parse, build or test what
# they write; every check here catches a defect that shipped undetected before
# the check existed. Called by /implement-azure (gates 8a-8d) and by CI.
#
# Usage:
#   powershell -File scripts/check-azure-artifacts.ps1 -Folder specs/<domain>/NNN-<slug> [-Build] [-Test] [-ReportFile <path>]
#
#   (no switch)  static checks only (JSON parse incl. adf/, workflow shape rules,
#                SQL and Bicep rules, stored-procedure cross-check, paired tests)
#   -Build       also `az bicep build` infra/main.bicep and `dotnet build` every
#                project (Functions/ first, so app/lib/custom/net8 holds the
#                DLLs the workflow tests load)
#   -Test        also `dotnet test` every tests-mstest/*/*.Tests.csproj, ONE AT
#                A TIME (Logic Apps test hosts all bind port 7071)
#   -ReportFile  also write the gate results as JSON (by convention
#                <folder>/implement-gates.json). scripts/refresh-status.ps1
#                reads it for stages 10 (Implement) and 11 (Tests).
#
# Output: one line per finding, "ERROR <rule> <file>: <message>" or
# "WARN  <rule> <file>: <message>", then a summary line. Exit code 1 when any
# ERROR was reported, else 0. Compatible with Windows PowerShell 5.1 and pwsh 7.

param(
    [Parameter(Mandatory = $true)][string]$Folder,
    [switch]$Build,
    [switch]$Test,
    [string]$ReportFile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$root = (Get-Item -LiteralPath $Folder).FullName.TrimEnd('\', '/')
$script:errors = 0
$script:warnings = 0
$script:findings = New-Object System.Collections.ArrayList
# Gate outcomes: pass | fail | not-run | not-applicable. Static is always run.
$script:gates = [ordered]@{ staticChecks = 'pass'; bicepBuild = 'not-run'; dotnetBuild = 'not-run'; dotnetTest = 'not-run' }
$script:testTotals = [ordered]@{ projects = 0; failedProjects = 0; passed = 0; failed = 0; skipped = 0 }

function Rel([string]$path) {
    if ($path.StartsWith($root)) { return $path.Substring($root.Length).TrimStart('\', '/') }
    return $path
}
function Report([string]$level, [string]$rule, [string]$file, [string]$message) {
    if ($level -eq 'ERROR') { $script:errors++ } else { $script:warnings++ }
    [void]$script:findings.Add([ordered]@{ level = $level; rule = $rule; file = ((Rel $file) -replace '\\', '/'); message = $message })
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
    $ErrorActionPreference = 'Continue'   # see the az call: native stderr is not fatal
    $lines = @(& dotnet @arguments 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $lines | Out-Host
    if ($arguments[0] -eq 'test') {
        $script:testTotals.projects++
        if ($code -ne 0) { $script:testTotals.failedProjects++ }
        # "Passed!  - Failed:     0, Passed:    10, Skipped:     0, Total:    10, ..."
        foreach ($l in $lines) {
            $m = [regex]::Match($l, 'Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+)')
            if ($m.Success) {
                $script:testTotals.failed  += [int]$m.Groups[1].Value
                $script:testTotals.passed  += [int]$m.Groups[2].Value
                $script:testTotals.skipped += [int]$m.Groups[3].Value
            }
        }
    }
    if ($code -ne 0) {
        Report 'ERROR' $label $arguments[1] "dotnet $($arguments[0]) exited $code"
        $script:lastDotnetOk = $false
        return
    }
    Write-Output "      ok"
    $script:lastDotnetOk = $true
}

$staticErrors = $script:errors
if ($staticErrors -gt 0) { $script:gates.staticChecks = 'fail' }

if ($Build) {
    $mainBicep = Join-Path $root 'infra/main.bicep'
    if (-not (Test-Path -LiteralPath $mainBicep)) {
        $script:gates.bicepBuild = 'not-applicable'
    } elseif (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        $script:gates.bicepBuild = 'not-run'
        Report 'ERROR' 'AZ_CLI_MISSING' $mainBicep 'Azure CLI not on PATH; cannot compile the Bicep (gate 8a)'
    } else {
        Write-Output "----- az bicep build infra/main.bicep"
        # --stdout: compile without leaving a transient main.json behind.
        # Native stderr (e.g. az's "new Bicep release" warning) must not become a
        # terminating error under ErrorActionPreference=Stop in Windows PowerShell 5.1.
        $ErrorActionPreference = 'Continue'
        $bicepOut = @(& az bicep build --file $mainBicep --stdout 2>&1 | ForEach-Object { "$_" })
        $bicepCode = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($bicepCode -ne 0) {
            $bicepOut | Where-Object { $_ -match '(?i)error' } | Out-Host
            $script:gates.bicepBuild = 'fail'
            Report 'ERROR' 'BICEP_BUILD' $mainBicep "az bicep build exited $bicepCode"
        } else {
            $script:gates.bicepBuild = 'pass'
            Write-Output "      ok"
        }
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
        if ($buildOrder.Count -eq 0) {
            Write-Output 'check-azure-artifacts: no .csproj found; build/test gates not applicable'
            $script:gates.dotnetBuild = 'not-applicable'
            if ($Test) { $script:gates.dotnetTest = 'not-applicable' }
        } else {
            $buildOk = $true
            foreach ($p in $buildOrder) {
                Invoke-Dotnet @('build', $p.FullName, '--nologo', '-v', 'q') 'DOTNET_BUILD'
                if (-not $script:lastDotnetOk) { $buildOk = $false }
            }
            $script:gates.dotnetBuild = if ($buildOk) { 'pass' } else { 'fail' }

            if ($Test) {
                # Sequential on purpose: every Logic Apps test host binds port 7071.
                $testOk = $true
                $testProjects = @(Get-Files 'tests-mstest' '*.Tests.csproj')
                foreach ($p in $testProjects) {
                    Invoke-Dotnet @('test', $p.FullName, '--no-build', '--nologo', '-v', 'q') 'DOTNET_TEST'
                    if (-not $script:lastDotnetOk) { $testOk = $false }
                }
                $script:gates.dotnetTest = if ($testProjects.Count -eq 0) { 'not-applicable' } elseif ($testOk) { 'pass' } else { 'fail' }
            }
        }
    }
}

Write-Output ("check-azure-artifacts: {0} error(s), {1} warning(s), {2} stored-procedure call(s) checked, {3} dotnet run(s)" -f $script:errors, $script:warnings, $calledProcs.Count, $script:dotnetRuns)
if ($ReportFile) {
    $report = [ordered]@{
        generated = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        tool      = 'scripts/check-azure-artifacts.ps1'
        summary   = [ordered]@{
            verdict  = if ($script:errors -gt 0) { 'FAIL' } else { 'PASS' }
            errors   = $script:errors
            warnings = $script:warnings
        }
        gates     = $script:gates
        tests     = $script:testTotals
        storedProcedureCalls = $calledProcs.Count
        findings  = @($script:findings)
    }
    $json = $report | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($ReportFile), $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "check-azure-artifacts: wrote $ReportFile"
}
if ($script:errors -gt 0) { exit 1 } else { exit 0 }
