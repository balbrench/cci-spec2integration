# refresh-status.ps1
#
# PostToolUse hook (Write|Edit) that rebuilds <integration-folder>/status.json
# whenever a file inside specs/<domain>/NNN-<slug>/ is created or modified.
#
# Implements the refresh protocol from
# .claude/skills/pipeline-status/SKILL.md.
#
# Wired in .claude/settings.json under hooks.PostToolUse.
#
# Design:
#   * Hook fires after EVERY Write/Edit (including from sub-agents). To stay
#     honest about provenance, every write is tagged refreshedBy
#     "auto:postwrite-hook"; slash commands are still expected to do the
#     authoritative refresh with their own name as their final step. The hook
#     is the safety net for ad-hoc edits.
#   * Idempotent: re-probes disk every time. Never trusts prior status.json.
#   * Computes mtime-based staleness (see pipeline-status/SKILL.md dependency
#     map): a `done` stage flips to `stale` when an upstream source is newer, the
#     `staleness[]` array is populated, `staleness_probed` is set true, and the
#     earliest stale stage drives `next`. This is the always-on staleness probe
#     the Bash-less slash commands can't perform - so editing an upstream file is
#     announced on the next /next or visualizer read without a manual /status.
#   * Never fails the tool call. Errors land in .spec2integration/hook.log.

param()

$ErrorActionPreference = "Stop"

# ---------- paths & logging ----------

$repoRoot = (Resolve-Path -Path (Join-Path $PSScriptRoot "..")).Path
$logPath  = Join-Path $repoRoot ".spec2integration/hook.log"
$logDir   = Split-Path -Parent $logPath
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$script:logSeq = 0
function Write-Log {
    param([string]$message)
    $script:logSeq++
    $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    [System.IO.File]::AppendAllText($logPath, "$ts #$($script:logSeq) $message`r`n")
}

# ---------- helpers ----------

function Find-IntegrationFolder {
    param([string]$StartPath, [string]$RepoRoot)

    $current = Split-Path -Parent $StartPath
    while ($current -and $current.StartsWith($RepoRoot)) {
        $leaf = Split-Path -Leaf $current
        # NNN-<slug> where NNN is digits and leaf has a dash
        if ($leaf -match '^[0-9]{3}-[a-z0-9-]+$') {
            # parent must be under specs/
            $parent = Split-Path -Parent $current
            if ($parent) {
                $relParent = $parent.Substring($RepoRoot.Length).TrimStart('\','/')
                if ($relParent -match '^specs([\\/]|$)') {
                    return $current
                }
            }
        }
        $next = Split-Path -Parent $current
        if ($next -eq $current) { break }
        $current = $next
    }
    return $null
}

function Test-StagePath {
    param([string]$Folder, [string]$RelPath)
    if ([string]::IsNullOrWhiteSpace($Folder)) {
        Write-Log "Test-StagePath called with empty Folder; RelPath=$RelPath"
        return $false
    }
    return Test-Path -Path (Join-Path $Folder $RelPath)
}

function Get-StageReport {
    param([string]$Path, [string]$Verdict = "PASS")
    if (-not (Test-Path $Path)) { return $null }
    try {
        $json = Get-Content $Path -Raw | ConvertFrom-Json
        return $json
    } catch {
        return $null
    }
}

function New-Stage {
    param([string]$Id, [string]$Name, [string]$Status, [string]$Summary)
    return [ordered]@{
        id      = $Id
        name    = $Name
        status  = $Status
        summary = $Summary
    }
}

function Get-StageProbe {
    param([string]$IntegrationFolder, [string]$RepoRoot)

    $stages = New-Object System.Collections.ArrayList

    # Stage 0a - Inventory (biztalk-only; implicit done for greenfield)
    $inventoryPath = Join-Path $RepoRoot "specs/biztalk/biztalk-inventory.md"
    if (Test-Path $inventoryPath) {
        [void]$stages.Add((New-Stage "0a" "Inventory" "done" "biztalk-inventory.md present"))
    } else {
        [void]$stages.Add((New-Stage "0a" "Inventory" "done" "greenfield (implicit)"))
    }

    # Stage 0b - Catalogue (biztalk-only; implicit done for greenfield)
    $cataloguePath = Join-Path $RepoRoot "specs/biztalk/integration-catalogue.md"
    if (Test-Path $cataloguePath) {
        [void]$stages.Add((New-Stage "0b" "Catalogue" "done" "integration-catalogue.md present"))
    } else {
        [void]$stages.Add((New-Stage "0b" "Catalogue" "done" "greenfield (implicit)"))
    }

    # Stage 1 - Spec
    if (Test-StagePath $IntegrationFolder "spec.md") {
        [void]$stages.Add((New-Stage "1" "Spec" "done" "spec.md present"))
    } else {
        [void]$stages.Add((New-Stage "1" "Spec" "missing" ""))
    }

    # Stage 1a - Clarifications
    $clarPath = Join-Path $IntegrationFolder "clarifications.md"
    $oqOpen = 0; $oqClosed = 0
    if (Test-Path $clarPath) {
        $clarText = Get-Content $clarPath -Raw
        $oqOpen   = ([regex]::Matches($clarText, '(?im)^\s*\|\s*OQ-\d+\b.*\|\s*open\b')).Count
        $oqClosed = ([regex]::Matches($clarText, '(?im)^\s*\|\s*OQ-\d+\b.*\|\s*closed\b')).Count
        $total = $oqOpen + $oqClosed
        [void]$stages.Add((New-Stage "1a" "Clarifications" "done" "clarifications.md ($oqClosed/$total closed, $oqOpen open)"))
    } else {
        [void]$stages.Add((New-Stage "1a" "Clarifications" "missing" ""))
    }

    # Stage 2 - Data model
    if (Test-StagePath $IntegrationFolder "data-model.md") {
        [void]$stages.Add((New-Stage "2" "Data model" "done" "data-model.md present"))
    } else {
        [void]$stages.Add((New-Stage "2" "Data model" "missing" ""))
    }

    # Stage 3 - Contracts
    $openapi  = Test-StagePath $IntegrationFolder "contracts/openapi.yaml"
    $asyncapi = Test-StagePath $IntegrationFolder "contracts/asyncapi.yaml"
    $schemasDir = Join-Path $IntegrationFolder "contracts/schemas"
    $hasSchemas = (Test-Path $schemasDir) -and ((Get-ChildItem $schemasDir -File -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
    if ($openapi -and $asyncapi -and $hasSchemas) {
        [void]$stages.Add((New-Stage "3" "Contracts" "done" "openapi + asyncapi + schemas/"))
    } else {
        $parts = @()
        if (-not $openapi)  { $parts += "openapi" }
        if (-not $asyncapi) { $parts += "asyncapi" }
        if (-not $hasSchemas) { $parts += "schemas" }
        [void]$stages.Add((New-Stage "3" "Contracts" "missing" "missing: $($parts -join ', ')"))
    }

    # Stage 3a - Contracts lint. The report nests its verdict under `summary`
    # (summary.{sev1,sev2,sev3,verdict}); read that, falling back to a top-level
    # `verdict` for resilience. A Sev-3-only report is verdict=PASS (advisory
    # findings never block), so keying off the verdict is correct — reading the
    # wrong (top-level) path returned $null and wrongly reported the stage blocked.
    $lintReport = Get-StageReport (Join-Path $IntegrationFolder "contract-lint-report.json")
    if ($lintReport) {
        $lintSummary = if ($lintReport.PSObject.Properties['summary']) { $lintReport.summary } else { $lintReport }
        $lintVerdict = $null
        if ($lintSummary -and $lintSummary.PSObject.Properties['verdict']) {
            $lintVerdict = $lintSummary.verdict
        } elseif ($lintReport.PSObject.Properties['verdict']) {
            $lintVerdict = $lintReport.verdict
        }
        if ($lintVerdict -eq "PASS") {
            [void]$stages.Add((New-Stage "3a" "Contracts lint" "done" "PASS"))
        } else {
            [void]$stages.Add((New-Stage "3a" "Contracts lint" "blocked" "verdict=$lintVerdict"))
        }
    } else {
        [void]$stages.Add((New-Stage "3a" "Contracts lint" "missing" ""))
    }

    # Stage 4 - Mappings (STM)
    $mappingsDir = Join-Path $IntegrationFolder "mappings"
    if (Test-Path $mappingsDir) {
        $stmCount = (Get-ChildItem $mappingsDir -Filter "*.md" -File -ErrorAction SilentlyContinue | Measure-Object).Count
        if ($stmCount -gt 0) {
            [void]$stages.Add((New-Stage "4" "Mappings (STM)" "done" "$stmCount STM document(s)"))
        } else {
            [void]$stages.Add((New-Stage "4" "Mappings (STM)" "missing" "mappings/ exists but no .md files"))
        }
    } else {
        [void]$stages.Add((New-Stage "4" "Mappings (STM)" "missing" ""))
    }

    # Stage 5 - IR
    if (Test-StagePath $IntegrationFolder "integration-ir.yaml") {
        [void]$stages.Add((New-Stage "5" "IR" "done" "integration-ir.yaml present"))
    } else {
        [void]$stages.Add((New-Stage "5" "IR" "missing" ""))
    }

    # Stage 5a - IR validation
    if (Test-StagePath $IntegrationFolder "ir-validation-report.json") {
        [void]$stages.Add((New-Stage "5a" "IR validation" "done" "ir-validation-report.json present"))
    } else {
        [void]$stages.Add((New-Stage "5a" "IR validation" "missing" ""))
    }

    # Stage 5b - STM drift (may be covered by /review)
    if (Test-StagePath $IntegrationFolder "stm-drift-report.json") {
        [void]$stages.Add((New-Stage "5b" "STM drift" "done" "stm-drift-report.json present"))
    } elseif (Test-StagePath $IntegrationFolder "review-report.json") {
        [void]$stages.Add((New-Stage "5b" "STM drift" "covered" "by /review"))
    } else {
        [void]$stages.Add((New-Stage "5b" "STM drift" "missing" ""))
    }

    # Stage 5c - Secret scan
    # Auto-runs only for reverse-engineered IRs (top-level `source:` block).
    # Greenfield integrations skip the scanner entirely - Article V + reviewer
    # audits cover no-inline-secrets on generated code.
    $irPathFor5c = Join-Path $IntegrationFolder "integration-ir.yaml"
    $irIsReverseEngineered = $false
    if (Test-Path $irPathFor5c) {
        $irHead = Get-Content $irPathFor5c -TotalCount 80 -ErrorAction SilentlyContinue
        if ($irHead -match '(?im)^\s*source\s*:') { $irIsReverseEngineered = $true }
    }
    $ssReport = Get-StageReport (Join-Path $IntegrationFolder "secret-scan-report.json")
    if ($ssReport) {
        # Read the verdict, not just existence. The report carries summary.{sev1,sev2,verdict,scanExecuted};
        # note `verdict` can be "PASS" even when scanExecuted=false (no Sev-1 found because nothing ran),
        # so a SCANNER_MISSING report must NOT be reported as a clean `done`.
        $ssSummary = if ($ssReport.PSObject.Properties['summary']) { $ssReport.summary } else { $ssReport }
        $ssSev1 = 0
        if ($ssSummary -and $ssSummary.PSObject.Properties['sev1'])      { $ssSev1 = [int]$ssSummary.sev1 }
        elseif ($ssSummary -and $ssSummary.PSObject.Properties['sev1Count']) { $ssSev1 = [int]$ssSummary.sev1Count }
        $ssExecuted = $true
        if ($ssSummary -and $ssSummary.PSObject.Properties['scanExecuted']) { $ssExecuted = [bool]$ssSummary.scanExecuted }
        if ($ssSev1 -gt 0) {
            [void]$stages.Add((New-Stage "5c" "Secret scan" "blocked" "$ssSev1 Sev-1 secret(s) detected"))
        } elseif (-not $ssExecuted) {
            [void]$stages.Add((New-Stage "5c" "Secret scan" "blocked" "SCANNER_MISSING (Sev-2) - scan did not run; install trufflehog/gitleaks and rerun"))
        } else {
            [void]$stages.Add((New-Stage "5c" "Secret scan" "done" "scan clean (0 Sev-1)"))
        }
    } elseif (-not $irIsReverseEngineered -and (Test-Path $irPathFor5c)) {
        [void]$stages.Add((New-Stage "5c" "Secret scan" "done" "not applicable (greenfield)"))
    } elseif (Test-StagePath $IntegrationFolder "review-report.json") {
        [void]$stages.Add((New-Stage "5c" "Secret scan" "covered" "by /review"))
    } else {
        [void]$stages.Add((New-Stage "5c" "Secret scan" "missing" ""))
    }

    # Stage 5d - PII flow (may be covered by /review)
    if (Test-StagePath $IntegrationFolder "pii-flow-report.json") {
        [void]$stages.Add((New-Stage "5d" "PII flow" "done" "pii-flow-report.json present"))
    } elseif (Test-StagePath $IntegrationFolder "review-report.json") {
        [void]$stages.Add((New-Stage "5d" "PII flow" "covered" "by /review"))
    } else {
        [void]$stages.Add((New-Stage "5d" "PII flow" "missing" ""))
    }

    # Stage 5e - Review
    $reviewReport = Get-StageReport (Join-Path $IntegrationFolder "review-report.json")
    if ($reviewReport) {
        $sev1 = if ($reviewReport.PSObject.Properties['sev1Count']) { $reviewReport.sev1Count } else { $null }
        $summary = if ($null -ne $sev1) { "review-report.json (sev1=$sev1)" } else { "review-report.json present" }
        $status = if ($null -ne $sev1 -and $sev1 -gt 0) { "blocked" } else { "done" }
        [void]$stages.Add((New-Stage "5e" "Review" $status $summary))
    } else {
        [void]$stages.Add((New-Stage "5e" "Review" "missing" ""))
    }

    # Stage 6 - Mapping tests
    $mtReport = Get-StageReport (Join-Path $IntegrationFolder "mapping-test-report.json")
    if ($mtReport) {
        $failed = if ($mtReport.PSObject.Properties['failed']) { $mtReport.failed } else { 0 }
        $passed = if ($mtReport.PSObject.Properties['passed']) { $mtReport.passed } else { 0 }
        if ($failed -gt 0) {
            [void]$stages.Add((New-Stage "6" "Mapping tests" "blocked" "passed=$passed failed=$failed"))
        } else {
            [void]$stages.Add((New-Stage "6" "Mapping tests" "done" "passed=$passed failed=0"))
        }
    } else {
        [void]$stages.Add((New-Stage "6" "Mapping tests" "missing" ""))
    }

    # Stage 6a - Flow tests
    $ftReport = Get-StageReport (Join-Path $IntegrationFolder "flow-test-report.json")
    if ($ftReport) {
        $failed = if ($ftReport.PSObject.Properties['failed']) { $ftReport.failed } else { 0 }
        $passed = if ($ftReport.PSObject.Properties['passed']) { $ftReport.passed } else { 0 }
        if ($failed -gt 0) {
            [void]$stages.Add((New-Stage "6a" "Flow tests" "blocked" "passed=$passed failed=$failed"))
        } else {
            [void]$stages.Add((New-Stage "6a" "Flow tests" "done" "passed=$passed failed=0"))
        }
    } else {
        [void]$stages.Add((New-Stage "6a" "Flow tests" "missing" ""))
    }

    # Stage 7 - Platform pack
    $stateJson = Get-StageReport (Join-Path $RepoRoot ".spec2integration/state.json")
    $activePlatform = $null
    if ($stateJson -and $stateJson.PSObject.Properties['activePlatform']) {
        $activePlatform = $stateJson.activePlatform
    } elseif ($stateJson -and $stateJson.PSObject.Properties['platform']) {
        $activePlatform = $stateJson.platform
    }
    if ($activePlatform) {
        [void]$stages.Add((New-Stage "7" "Platform pack" "done" "activePlatform=$activePlatform"))
    } else {
        [void]$stages.Add((New-Stage "7" "Platform pack" "missing" ""))
    }

    # Stage 8 - Plan
    if (Test-StagePath $IntegrationFolder "plan.md") {
        [void]$stages.Add((New-Stage "8" "Plan" "done" "plan.md present"))
    } elseif (Test-StagePath $IntegrationFolder "plan-blocked.md") {
        [void]$stages.Add((New-Stage "8" "Plan" "blocked" "plan-blocked.md present"))
    } else {
        [void]$stages.Add((New-Stage "8" "Plan" "missing" ""))
    }

    # Stage 9 - Tasks
    if (Test-StagePath $IntegrationFolder "tasks.md") {
        [void]$stages.Add((New-Stage "9" "Tasks" "done" "tasks.md present"))
    } else {
        [void]$stages.Add((New-Stage "9" "Tasks" "missing" ""))
    }

    # Stage 10 - Implement (platform-specific; azure only for now)
    if ($activePlatform -eq "azure") {
        $appDir = Join-Path $IntegrationFolder "app"
        $workflowCount = 0
        if (Test-Path $appDir) {
            $workflowCount = (Get-ChildItem $appDir -Recurse -Filter "workflow.json" -File -ErrorAction SilentlyContinue | Measure-Object).Count
        }
        if ($workflowCount -gt 0) {
            [void]$stages.Add((New-Stage "10" "Implement" "done" "$workflowCount workflow.json file(s) under app/"))
        } else {
            [void]$stages.Add((New-Stage "10" "Implement" "missing" "no app/<flow>/workflow.json found"))
        }
    } else {
        [void]$stages.Add((New-Stage "10" "Implement" "missing" "no active platform"))
    }

    # Stage 11 - Tests (platform-specific; azure only for now). Prefer the
    # execution result (tests-mstest/test-results.json, written by /test-azure)
    # over scaffold existence — otherwise a rebuild reverts an executed stage to a
    # generation-only summary and loses the pass/fail outcome.
    if ($activePlatform -eq "azure") {
        $mstestDir = Join-Path $IntegrationFolder "tests-mstest"
        $csprojCount = 0
        if (Test-Path $mstestDir) {
            $csprojCount = (Get-ChildItem $mstestDir -Recurse -Filter "*.csproj" -File -ErrorAction SilentlyContinue | Measure-Object).Count
        }
        $testReport = Get-StageReport (Join-Path $mstestDir "test-results.json")
        if ($testReport) {
            $failed = if ($testReport.PSObject.Properties['failed']) { $testReport.failed } else { 0 }
            $passed = if ($testReport.PSObject.Properties['passed']) { $testReport.passed } else { 0 }
            $total = $passed + $failed
            if ($failed -gt 0) {
                [void]$stages.Add((New-Stage "11" "Tests" "blocked" "MSTest executed: $passed/$total passed, $failed failed"))
            } else {
                [void]$stages.Add((New-Stage "11" "Tests" "done" "MSTest executed: $passed/$total passed"))
            }
        } elseif ($csprojCount -gt 0) {
            [void]$stages.Add((New-Stage "11" "Tests" "done" "$csprojCount MSTest project(s) generated; not yet executed - run /test-azure"))
        } else {
            [void]$stages.Add((New-Stage "11" "Tests" "missing" "no tests-mstest/*.csproj found"))
        }
    } else {
        [void]$stages.Add((New-Stage "11" "Tests" "missing" "no active platform"))
    }

    # Stage 12 - Deploy (platform-specific; azure only for now)
    if ($activePlatform -eq "azure") {
        $hasAzureYaml = Test-StagePath $IntegrationFolder "azure.yaml"
        $hasAzdDir    = Test-Path (Join-Path $IntegrationFolder ".azure")
        if ($hasAzureYaml -and $hasAzdDir) {
            [void]$stages.Add((New-Stage "12" "Deploy" "done" "azure.yaml + .azure/ present"))
        } elseif ($hasAzureYaml) {
            [void]$stages.Add((New-Stage "12" "Deploy" "missing" "azure.yaml present, .azure/ missing (not yet deployed)"))
        } else {
            [void]$stages.Add((New-Stage "12" "Deploy" "missing" ""))
        }
    } else {
        [void]$stages.Add((New-Stage "12" "Deploy" "missing" "no active platform"))
    }

    return @{
        stages         = $stages
        activePlatform = $activePlatform
        oqOpen         = $oqOpen
        oqClosed       = $oqClosed
        reviewReport   = $reviewReport
    }
}

function Get-NextStep {
    param($Probe, [string]$IntegrationFolder, [string]$RepoRoot)

    # Precedence: first unmet stage wins. Special-case the well-known progression.
    foreach ($stage in $Probe.stages) {
        if ($stage.status -eq "missing" -or $stage.status -eq "blocked") {
            $cmd = switch ($stage.id) {
                "1"   { "/specify" }
                "1a"  { "/clarify" }
                "2"   { "/model" }
                "3"   { "/contracts" }
                "3a"  { "/contracts" }
                "4"   { "/map" }
                "5"   { "/architect" }
                "5a"  { "/review" }
                "5b"  { "/review" }
                "5c"  { "/review" }
                "5d"  { "/review" }
                "5e"  { "/review" }
                "6"   { "/test-mappings" }
                "6a"  { "/test-flows" }
                "7"   { "/platform" }
                "8"   { "/plan" }
                "9"   { "/tasks" }
                "10"  { "/implement-$($Probe.activePlatform)" }
                "11"  { "/test-$($Probe.activePlatform)" }
                "12"  { "/deploy-$($Probe.activePlatform)" }
                default { $null }
            }
            if ($cmd) {
                $rel = $IntegrationFolder.Substring($RepoRoot.Length).TrimStart('\','/') -replace '\\','/'
                return @{
                    command = "$cmd $rel"
                    reason  = "Stage $($stage.id) ($($stage.name)) is $($stage.status)"
                }
            }
        }
    }
    return @{ command = ""; reason = "All stages done." }
}

function Get-Counts {
    param($Probe, [string]$IntegrationFolder, [string]$RepoRoot)

    $review = $Probe.reviewReport
    $sev1 = if ($review -and $review.PSObject.Properties['sev1Count']) { $review.sev1Count } else { $null }
    $sev2 = if ($review -and $review.PSObject.Properties['sev2Count']) { $review.sev2Count } else { $null }
    $sev3 = if ($review -and $review.PSObject.Properties['sev3Count']) { $review.sev3Count } else { $null }

    # Best-effort scan for BLOCKED flows in IR
    $blockedFlows = 0
    $irPath = Join-Path $IntegrationFolder "integration-ir.yaml"
    if (Test-Path $irPath) {
        $irText = Get-Content $irPath -Raw
        $blockedFlows = ([regex]::Matches($irText, '(?m)#\s*BLOCKED:')).Count
    }

    # Azure / local function dep counts - coarse text scan
    $azureFnDeps = 0; $localFnDeps = 0
    if (Test-Path $irPath) {
        $azureFnDeps = ([regex]::Matches($irText, '(?im)migrationHint:\s*azure-function')).Count
        $localFnDeps = ([regex]::Matches($irText, '(?im)migrationHint:\s*local-function')).Count
    }

    # MSI cracked count - manifest file
    $msisCracked = 0
    $manifestPath = Join-Path $RepoRoot "_extracted/_manifest.json"
    if (Test-Path $manifestPath) {
        try {
            $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
            if ($manifest.PSObject.Properties['msis']) {
                $msisCracked = ($manifest.msis | Measure-Object).Count
            }
        } catch { }
    }

    return [ordered]@{
        openClarifications   = $Probe.oqOpen
        closedClarifications = $Probe.oqClosed
        sev1                 = $sev1
        sev2                 = $sev2
        sev3                 = $sev3
        blockedFlows         = $blockedFlows
        azureFunctionDeps    = $azureFnDeps
        localFunctionDeps    = $localFnDeps
        msisCracked          = $msisCracked
    }
}

# ---------- coverage & blocked-flow ids (best-effort IR scan) ----------
#
# Surfaced in the VS Code progress view. The IR is YAML; we do a line-oriented
# scan (no YAML parser available in the hook) keyed off the top-level `flows:` and
# `mappings:` sections. Counts are advisory, not load-bearing for any gate.

function Get-IrFlowStats {
    param([string]$IntegrationFolder)

    $irPath = Join-Path $IntegrationFolder "integration-ir.yaml"
    $result = [ordered]@{ flowsTotal = $null; flowsWithTests = $null; mappingsTotal = $null; blockedFlowIds = @() }
    if (-not (Test-Path $irPath)) { return $result }

    $lines = Get-Content $irPath
    $flows = 0; $flowsWithTests = 0; $mappings = 0
    $blocked = New-Object System.Collections.ArrayList
    $inFlows = $false; $inMappings = $false; $lastId = $null

    foreach ($line in $lines) {
        # Top-level key (no leading whitespace) switches section context.
        if ($line -match '^[A-Za-z0-9_]+\s*:') {
            $inFlows    = ($line -match '^flows\s*:')
            $inMappings = ($line -match '^mappings\s*:')
        }
        if ($inFlows -and $line -match '^\s+-\s+id\s*:\s*[''"]?([A-Za-z0-9_.\-]+)') {
            $flows++; $lastId = $Matches[1]
        }
        if ($inFlows -and $line -match '^\s+tests\s*:') { $flowsWithTests++ }
        if ($inMappings -and $line -match '^\s+-\s+name\s*:\s*[''"]?([A-Za-z0-9_.\-]+)') { $mappings++ }
        if ($line -match '#\s*BLOCKED\s*:') {
            $id = if ($lastId) { $lastId } else { "flow-$($blocked.Count + 1)" }
            if (-not $blocked.Contains($id)) { [void]$blocked.Add($id) }
        }
    }

    $result.flowsTotal     = $flows
    $result.flowsWithTests = $flowsWithTests
    $result.mappingsTotal  = $mappings
    $result.blockedFlowIds = @($blocked)
    return $result
}

# ---------- staleness (mtime-based) ----------
#
# Implements the dependency map from pipeline-status/SKILL.md. A `done` stage
# becomes `stale` when any of its upstream sources has a newer mtime than the
# stage's own artifact. Because this hook fires after every Write/Edit, it is the
# always-on staleness probe that the Bash-less slash commands cannot run - so a
# user who edits spec.md after the IR exists sees the IR flip to `stale` (and the
# `next` recommendation point at the rebuild) without having to run /status.

function Get-PathMtimeUtc {
    param([string]$FullPath)
    if (Test-Path -LiteralPath $FullPath -PathType Leaf) {
        return (Get-Item -LiteralPath $FullPath).LastWriteTimeUtc
    }
    if (Test-Path -LiteralPath $FullPath -PathType Container) {
        $max = $null
        foreach ($f in (Get-ChildItem -LiteralPath $FullPath -Recurse -File -ErrorAction SilentlyContinue)) {
            if ($null -eq $max -or $f.LastWriteTimeUtc -gt $max) { $max = $f.LastWriteTimeUtc }
        }
        return $max
    }
    return $null
}

function Get-NewestOver {
    param([string]$Folder, [string[]]$RelPaths)
    $max = $null
    foreach ($rp in $RelPaths) {
        $m = Get-PathMtimeUtc (Join-Path $Folder $rp)
        if ($null -ne $m -and ($null -eq $max -or $m -gt $max)) { $max = $m }
    }
    return $max
}

function Get-ProducerCommand {
    param([string]$Id, [string]$ActivePlatform)
    switch ($Id) {
        "1"   { "/specify" }
        "1a"  { "/clarify" }
        "2"   { "/model" }
        "3"   { "/contracts" }
        "3a"  { "/contracts" }
        "4"   { "/map" }
        "5"   { "/architect" }
        "5a"  { "/review" }
        "5b"  { "/review" }
        "5c"  { "/review" }
        "5d"  { "/review" }
        "5e"  { "/review" }
        "6"   { "/test-mappings" }
        "6a"  { "/test-flows" }
        "7"   { "/platform" }
        "8"   { "/plan" }
        "9"   { "/tasks" }
        "10"  { "/implement-$ActivePlatform" }
        "11"  { "/test-$ActivePlatform" }
        "12"  { "/deploy-$ActivePlatform" }
        default { $null }
    }
}

function Get-Staleness {
    param($Folder, $Stages, $RepoRoot)

    $stale = New-Object System.Collections.ArrayList

    # Stage 1 (Spec) <- specs/PRD.md. The PRD lives at the repo-root specs/ folder,
    # not inside the integration folder, so it is checked separately (and first, so
    # it drives `next` ahead of later stages). Greenfield only: a reverse-engineered
    # (BizTalk) IR has a top-level `source:` block and no PRD, so skip it there.
    $specStage = $Stages | Where-Object { $_.id -eq "1" } | Select-Object -First 1
    if ($specStage -and $specStage.status -eq "done") {
        $specMtime = Get-PathMtimeUtc (Join-Path $Folder "spec.md")
        $prdMtime  = Get-PathMtimeUtc (Join-Path $RepoRoot "specs/PRD.md")
        if ($null -ne $specMtime -and $null -ne $prdMtime -and $prdMtime -gt $specMtime) {
            $isReverse = $false
            $irPath = Join-Path $Folder "integration-ir.yaml"
            if (Test-Path $irPath) {
                $head = Get-Content $irPath -TotalCount 80 -ErrorAction SilentlyContinue
                if ($head -match '(?im)^\s*source\s*:') { $isReverse = $true }
            }
            if (-not $isReverse) {
                $specStage.status = "stale"
                [void]$stale.Add([ordered]@{
                    stage      = "1"
                    stagename  = $specStage.name
                    stalerThan = "specs/PRD.md"
                    reason     = "specs/PRD.md edited after spec.md"
                })
            }
        }
    }

    # downstream stage id -> { artifact path(s); upstream source path(s) }
    # Mirrors the dependency map in .claude/skills/pipeline-status/SKILL.md.
    $depMap = [ordered]@{
        "2"  = @{ artifact = @("data-model.md");                                                         upstream = @("spec.md") }
        "3"  = @{ artifact = @("contracts/openapi.yaml","contracts/asyncapi.yaml","contracts/schemas");  upstream = @("spec.md","data-model.md") }
        "3a" = @{ artifact = @("contract-lint-report.json");                                             upstream = @("contracts/openapi.yaml","contracts/asyncapi.yaml","contracts/schemas") }
        "4"  = @{ artifact = @("mappings");                                                              upstream = @("spec.md","data-model.md","contracts") }
        "5"  = @{ artifact = @("integration-ir.yaml");                                                   upstream = @("spec.md","data-model.md","contracts","mappings") }
        "5a" = @{ artifact = @("ir-validation-report.json");                                             upstream = @("integration-ir.yaml") }
        "5b" = @{ artifact = @("stm-drift-report.json");                                                 upstream = @("integration-ir.yaml","mappings") }
        "5c" = @{ artifact = @("secret-scan-report.json");                                               upstream = @("integration-ir.yaml") }
        "5d" = @{ artifact = @("pii-flow-report.json");                                                  upstream = @("integration-ir.yaml") }
        "5e" = @{ artifact = @("review-report.json");                                                    upstream = @("spec.md","data-model.md","contracts","mappings","integration-ir.yaml") }
        "6"  = @{ artifact = @("mapping-test-report.json");                                              upstream = @("integration-ir.yaml","mappings") }
        "6a" = @{ artifact = @("flow-test-report.json");                                                 upstream = @("integration-ir.yaml") }
        "8"  = @{ artifact = @("plan.md");                                                               upstream = @("spec.md","data-model.md","contracts","mappings","integration-ir.yaml") }
        "9"  = @{ artifact = @("tasks.md");                                                              upstream = @("plan.md","integration-ir.yaml") }
        "10" = @{ artifact = @("app");                                                                   upstream = @("tasks.md","integration-ir.yaml") }
        "11" = @{ artifact = @("tests-mstest");                                                          upstream = @("tasks.md","integration-ir.yaml") }
    }

    foreach ($id in $depMap.Keys) {
        $stage = $Stages | Where-Object { $_.id -eq $id } | Select-Object -First 1
        if (-not $stage) { continue }
        if ($stage.status -ne "done") { continue }   # only a 'done' stage can go stale
        $artMtime = Get-NewestOver -Folder $Folder -RelPaths $depMap[$id].artifact
        if ($null -eq $artMtime) { continue }
        $trigger = $null; $triggerMtime = $null
        foreach ($up in $depMap[$id].upstream) {
            $m = Get-NewestOver -Folder $Folder -RelPaths @($up)
            if ($null -ne $m -and $m -gt $artMtime) {
                if ($null -eq $triggerMtime -or $m -gt $triggerMtime) { $triggerMtime = $m; $trigger = $up }
            }
        }
        if ($trigger) {
            $stage.status = "stale"
            $artName = $depMap[$id].artifact[0]
            [void]$stale.Add([ordered]@{
                stage      = $id
                stagename  = $stage.name
                stalerThan = $trigger
                reason     = "$trigger edited after $artName"
            })
        }
    }
    return ,$stale
}

function Update-IntegrationStatus {
    param([string]$IntegrationFolder, [string]$RepoRoot)

    $statusPath = Join-Path $IntegrationFolder "status.json"

    # Read the prior status.json once, up front: it carries agent-owned baseline
    # keys the disk probe cannot reconstruct AND the prior stage-completion
    # timestamps we want to keep stable across rebuilds.
    $prior = $null
    if (Test-Path $statusPath) {
        try { $prior = Get-Content $statusPath -Raw | ConvertFrom-Json }
        catch { Write-Log "could not read prior status.json: $($_.Exception.Message)" }
    }

    $probe  = Get-StageProbe -IntegrationFolder $IntegrationFolder -RepoRoot $RepoRoot
    $counts = Get-Counts -Probe $probe -IntegrationFolder $IntegrationFolder -RepoRoot $RepoRoot

    # Compute staleness; this mutates $probe.stages (done -> stale where an upstream is newer).
    $staleness = Get-Staleness -Folder $IntegrationFolder -Stages $probe.stages -RepoRoot $RepoRoot
    $counts['staleStages'] = $staleness.Count

    $relFolder = $IntegrationFolder.Substring($RepoRoot.Length).TrimStart('\','/') -replace '\\','/'

    # Staleness wins over forward progression for the next-step recommendation.
    if ($staleness.Count -gt 0) {
        $se   = $staleness[0]
        $cmd  = Get-ProducerCommand -Id $se.stage -ActivePlatform $probe.activePlatform
        $next = @{
            command = ("$cmd $relFolder").Trim()
            reason  = "$($se.reason) - rebuild stage $($se.stage) ($($se.stagename)) before continuing"
        }
    } else {
        $next = Get-NextStep -Probe $probe -IntegrationFolder $IntegrationFolder -RepoRoot $RepoRoot
    }

    $nowIso = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

    # Coverage + blocked-flow ids (best-effort IR scan).
    $irStats = Get-IrFlowStats -IntegrationFolder $IntegrationFolder
    $mappingsDir = Join-Path $IntegrationFolder "mappings"
    $stmCount = 0
    if (Test-Path $mappingsDir) {
        $stmCount = (Get-ChildItem $mappingsDir -Filter "*.md" -File -ErrorAction SilentlyContinue | Measure-Object).Count
    }

    # Per-stage timing: keep prior completedAt stable, stamp now for newly-complete
    # stages, and derive elapsedMs as the gap to the previous completed stage.
    $priorTiming = @{}
    if ($prior -and $prior.PSObject.Properties['stageTiming'] -and $prior.stageTiming) {
        foreach ($p in $prior.stageTiming.PSObject.Properties) {
            if ($p.Value -and $p.Value.PSObject.Properties['completedAt']) {
                $priorTiming[$p.Name] = [string]$p.Value.completedAt
            }
        }
    }
    $stageTiming = [ordered]@{}
    $lastCompleted = $null
    foreach ($stage in $probe.stages) {
        if ($stage.status -eq "done" -or $stage.status -eq "covered") {
            $completedAt = if ($priorTiming.ContainsKey($stage.id)) { $priorTiming[$stage.id] } else { $nowIso }
            $entry = [ordered]@{ completedAt = $completedAt }
            if ($lastCompleted) {
                try {
                    $ms = ([datetime]$completedAt - [datetime]$lastCompleted).TotalMilliseconds
                    if ($ms -ge 0) { $entry['elapsedMs'] = [int][math]::Round($ms) }
                } catch { }
            }
            $stageTiming[$stage.id] = $entry
            $lastCompleted = $completedAt
        }
    }

    $status = [ordered]@{
        folder           = $relFolder
        generatedAt      = $nowIso
        refreshedBy      = "auto:postwrite-hook"
        activePlatform   = $probe.activePlatform
        stages           = $probe.stages
        counts           = $counts
        staleness        = @($staleness)
        staleness_probed = $true
        next             = $next
        blockedFlowIds   = @($irStats.blockedFlowIds)
        stageTiming      = $stageTiming
    }
    if ($null -ne $irStats.flowsTotal) {
        $status['coverage'] = [ordered]@{
            flowsTotal         = $irStats.flowsTotal
            flowsWithTests     = $irStats.flowsWithTests
            mappingsTotal      = $irStats.mappingsTotal
            mappingsDocumented = $stmCount
        }
    }

    # Preserve agent-owned keys the disk probe cannot reconstruct. This rebuild is
    # otherwise authoritative (it never trusts prior stage rows), but a few keys are
    # written by agents and have no probe equivalent - dropping them on every edit
    # would silently wipe the /drift-check baseline (artifactHashes/lastImplement)
    # and the spec-coverage block. Carry them forward verbatim if present.
    if ($prior) {
        foreach ($key in @('artifactHashes', 'lastImplement', 'specCoverage')) {
            if ($prior.PSObject.Properties[$key]) { $status[$key] = $prior.$key }
        }
    }

    # Depth 64: artifactHashes is a flat 100+ key map, but go deep enough that any
    # nested preserved value serializes fully rather than collapsing to "System...".
    $json = $status | ConvertTo-Json -Depth 64
    [System.IO.File]::WriteAllText($statusPath, $json, [System.Text.UTF8Encoding]::new($false))
    Write-Log "wrote $statusPath (next=$($next.command), preserved baseline keys where present)"
}

# ---------- main ----------

Write-Log "=== hook start ==="

try {
    $payloadJson = [Console]::In.ReadToEnd()
    Write-Log "main: read payload length=$($payloadJson.Length)"
    if ([string]::IsNullOrWhiteSpace($payloadJson)) {
        Write-Log "no stdin payload - skipping"
        exit 0
    }

    $payload = $payloadJson | ConvertFrom-Json
    $toolName = $payload.tool_name
    $filePath = $payload.tool_input.file_path

    if ([string]::IsNullOrWhiteSpace($filePath)) {
        Write-Log "tool=$toolName no file_path - skipping"
        exit 0
    }

    # Avoid infinite loop: if the hook is writing status.json, skip.
    if ([System.IO.Path]::GetFileName($filePath) -eq "status.json") {
        Write-Log "tool=$toolName wrote status.json directly - skipping refresh"
        exit 0
    }

    # Normalise to absolute. Fall back to .NET GetFullPath if file vanished.
    $absPath = $null
    try { $absPath = (Resolve-Path -Path $filePath -ErrorAction Stop).Path }
    catch { $absPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $filePath)) }

    # A PRD edit (specs/PRD.md) affects the Spec stage of every greenfield integration,
    # but PRD.md lives outside any NNN-<slug> folder, so refresh them all. Enumerate at
    # fixed depths (specs/NNN-slug and specs/<domain>/NNN-slug) to avoid recursing into
    # node_modules / bin under tests-mstest.
    if ([System.IO.Path]::GetFileName($absPath) -eq "PRD.md") {
        $specsRoot = Join-Path $repoRoot "specs"
        $refreshed = 0
        Get-ChildItem -Path $specsRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $lvl1 = $_
            if ($lvl1.Name -match '^[0-9]{3}-' -and (Test-Path (Join-Path $lvl1.FullName "spec.md"))) {
                Update-IntegrationStatus -IntegrationFolder $lvl1.FullName -RepoRoot $repoRoot; $refreshed++
            }
            Get-ChildItem -Path $lvl1.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                if ($_.Name -match '^[0-9]{3}-' -and (Test-Path (Join-Path $_.FullName "spec.md"))) {
                    Update-IntegrationStatus -IntegrationFolder $_.FullName -RepoRoot $repoRoot; $refreshed++
                }
            }
        }
        Write-Log "PRD edit ($absPath) - refreshed $refreshed integration folder(s)"
        exit 0
    }

    $integrationFolder = Find-IntegrationFolder -StartPath $absPath -RepoRoot $repoRoot
    if ([string]::IsNullOrWhiteSpace([string]$integrationFolder)) {
        Write-Log "tool=$toolName file=$absPath outside specs/*/NNN-*/ - skipping"
        exit 0
    }

    Update-IntegrationStatus -IntegrationFolder $integrationFolder -RepoRoot $repoRoot
    Write-Log "tool=$toolName updated $integrationFolder/status.json"
}
catch {
    Write-Log "ERROR $($_.Exception.Message) at $($_.InvocationInfo.ScriptLineNumber):$($_.InvocationInfo.OffsetInLine) line='$($_.InvocationInfo.Line.Trim())'"
}

# PostToolUse hooks cannot block tool calls; always exit 0.
exit 0
