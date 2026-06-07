[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$SolutionRoot,
    [Parameter(Mandatory=$true)][string]$OutRoot
)

$ErrorActionPreference = 'Stop'

function Ensure-Dir($p) { if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null } }

# Extract every UTF-16LE '<?xml' literal embedded in a .NET assembly (used by
# BizTalk-compiled DLLs which store schemas/XSLT/ODX/BTP as IL string constants,
# not as managed resources).
function Get-EmbeddedXmlLiterals([byte[]]$bytes) {
    $needle = [Text.Encoding]::Unicode.GetBytes('<?xml')
    $results = New-Object System.Collections.ArrayList
    $i = 0
    $limit = $bytes.Length - $needle.Length
    while ($i -le $limit) {
        $ok = $true
        for ($j = 0; $j -lt $needle.Length; $j++) {
            if ($bytes[$i + $j] -ne $needle[$j]) { $ok = $false; break }
        }
        if ($ok) {
            $end = $i
            while ($end -lt $bytes.Length - 1 -and -not ($bytes[$end] -eq 0 -and $bytes[$end + 1] -eq 0)) {
                $end += 2
            }
            $len = $end - $i
            if ($len -ge 20) {
                $str = [Text.Encoding]::Unicode.GetString($bytes, $i, $len)
                # Trim any stray trailing byte after final '>'
                $lastGt = $str.LastIndexOf('>')
                if ($lastGt -gt 0) { $str = $str.Substring(0, $lastGt + 1) }
                $null = $results.Add([ordered]@{ offset = $i; text = $str })
            }
            $i = if ($end -gt $i) { $end } else { $i + 2 }
        } else {
            $i++
        }
    }
    return $results
}

function Classify-XmlLiteral([string]$xml) {
    if ($xml -match '<xsl:stylesheet')                    { return 'map' }
    if ($xml -match '<xs:schema' -or $xml -match '<xsd:schema' -or $xml -match '<schema\s+xmlns="http://www\.w3\.org/2001/XMLSchema"') { return 'schema' }
    if ($xml -match '<om:Element' -or $xml -match 'OrchestrationDesignerVersion' -or $xml -match '<Document\b') { return 'orchestration' }
    if ($xml -match '<Document\s+xmlns="http://schemas\.microsoft\.com/BizTalk/2003/DesignerLayout"') { return 'pipeline' }
    if ($xml -match '<Stages\b')                          { return 'pipeline' }
    return $null
}

function Get-XmlIdentifier([string]$xml, [string]$kind, [int]$seq) {
    switch ($kind) {
        'schema' {
            if ($xml -match 'targetNamespace="([^"]+)"') {
                $ns = $Matches[1]
                $leaf = ($ns -split '[/:#]' | Where-Object { $_ } | Select-Object -Last 1)
                if ($leaf) { return $leaf }
            }
            if ($xml -match '<(?:xs|xsd):element\s+[^>]*name="([^"]+)"') { return $Matches[1] }
            return "Schema_$seq"
        }
        'map' {
            if ($xml -match 'xmlns:s0="([^"]+)"' -and $xml -match 'xmlns:ns0="([^"]+)"') {
                $src = ($Matches[1] -split '[/:#]' | Where-Object { $_ } | Select-Object -Last 1)
                return "Map_$seq" + ($(if ($src) { "_$src" } else { '' }))
            }
            return "Map_$seq"
        }
        'orchestration' {
            if ($xml -match '<om:Property\s+Name="Name"\s+Value="([^"]+)"') { return $Matches[1] }
            return "Orchestration_$seq"
        }
        'pipeline' {
            if ($xml -match '<om:Property\s+Name="Name"\s+Value="([^"]+)"') { return $Matches[1] }
            return "Pipeline_$seq"
        }
        default { return "Artifact_$seq" }
    }
}

function Get-RelPath($abs, $base) {
    $absFull  = [IO.Path]::GetFullPath($abs)
    $baseFull = [IO.Path]::GetFullPath($base)
    if ($absFull.StartsWith($baseFull, [StringComparison]::OrdinalIgnoreCase)) {
        return $absFull.Substring($baseFull.Length).TrimStart('\','/').Replace('\','/')
    }
    return $absFull.Replace('\','/')
}

Ensure-Dir $OutRoot
$repoRoot = (Resolve-Path (Join-Path $OutRoot '..\..\..')).Path

# Discover MSIs
$msis = Get-ChildItem -Path $SolutionRoot -Filter *.msi -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\(\.msi-extract|_extracted)\\' }

if (-not $msis) {
    $manifest = [ordered]@{ schemaVersion = 1; extractedAt = (Get-Date).ToUniversalTime().ToString('o'); msis = @() }
    ($manifest | ConvertTo-Json -Depth 10) | Set-Content -Encoding UTF8 (Join-Path $OutRoot '_manifest.json')
    Write-Host "No MSIs found under $SolutionRoot - wrote empty manifest."
    return
}

$msiEntries = New-Object System.Collections.ArrayList

foreach ($msi in $msis) {
    $msiName = [IO.Path]::GetFileNameWithoutExtension($msi.Name)
    $perMsi  = Join-Path $OutRoot $msiName
    $work    = Join-Path $perMsi '_work'
    $expDir  = Join-Path $work '_expanded'

    Write-Host "=== $msiName ==="

    if (Test-Path $perMsi) {
        # Rename any locked DLLs aside so they don't block cleanup, then best-effort delete.
        Get-ChildItem $perMsi -Recurse -File -Filter *.dll -ErrorAction SilentlyContinue | ForEach-Object {
            try { Move-Item -LiteralPath $_.FullName -Destination "$($_.FullName).locked-$(Get-Random)" -ErrorAction Stop } catch { }
        }
        Remove-Item -Recurse -Force $perMsi -ErrorAction SilentlyContinue
        if (Test-Path $perMsi) {
            # Folder still has locked content; create a fresh sibling and re-point.
            $perMsi = "$perMsi-$([Guid]::NewGuid().ToString('N').Substring(0,6))"
        }
    }
    Ensure-Dir $perMsi
    Ensure-Dir $work
    Ensure-Dir $expDir
    foreach ($sub in 'assemblies','maps','schemas/native','orchestrations','pipelines','bindings','policies','components','helpers') {
        Ensure-Dir (Join-Path $perMsi $sub)
    }

    $entry = [ordered]@{
        msi               = $msi.Name
        appName           = $msiName
        extractedTo       = (Get-RelPath $perMsi $repoRoot)
        extractedAt       = (Get-Date).ToUniversalTime().ToString('o')
        assemblies        = @()
        bindings          = @()
        policies          = @()
        pipelineComponents= @()
        helpers           = @()
        warnings          = @()
    }

    # 1) Administrative install
    $proc = Start-Process -FilePath msiexec.exe -ArgumentList @('/a', "`"$($msi.FullName)`"", '/qn', "TARGETDIR=`"$work`"") -Wait -PassThru -WindowStyle Hidden
    if ($proc.ExitCode -ne 0) {
        $entry.skipped = $true
        $entry.reason  = "admin-install-failed (exit=$($proc.ExitCode))"
        $null = $msiEntries.Add($entry)
        continue
    }

    $adfFile = Get-ChildItem -Path $work -Filter 'ApplicationDefinition.adf' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $adfFile) {
        $entry.skipped = $true; $entry.reason = 'adf-missing'
        $null = $msiEntries.Add($entry); continue
    }
    $adfPath = $adfFile.FullName

    [xml]$adf = Get-Content -LiteralPath $adfPath -Encoding UTF8
    $resources = @($adf.ApplicationDefinition.Resources.Resource)

    # Resource types we expand from CAB
    $expandTypes = @{
        'System.BizTalk:BizTalkAssembly'   = 'assembly'
        'System.BizTalk:BizTalkBinding'    = 'binding'
        'System.BizTalk:Policy'            = 'policy'
        'System.BizTalk:Vocabulary'        = 'vocabulary'
        'System.BizTalk:PipelineComponent' = 'pipelinecomponent'
        'System.BizTalk:Assembly'          = 'helper'
    }

    foreach ($r in $resources) {
        $rt = $r.Type
        if (-not $expandTypes.ContainsKey($rt)) { continue }
        $cab = $null
        if ($r.Properties -and $r.Properties.Property) {
            $cabProp = @($r.Properties.Property) | Where-Object { $_.Name -eq 'ShortCabinetName' } | Select-Object -First 1
            if ($cabProp) { $cab = $cabProp.Value }
        }
        if (-not $cab) { continue }

        # Locate CAB under any guid subfolder
        $cabPath = Get-ChildItem -Path $work -Filter $cab -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $cabPath) {
            $entry.warnings += "cab-not-found: $cab ($rt)"
            continue
        }

        # Expand into a per-resource subfolder to avoid filename collisions
        $resOut = Join-Path $expDir ([IO.Path]::GetFileNameWithoutExtension($cab) + '_' + [Guid]::NewGuid().ToString('N').Substring(0,6))
        Ensure-Dir $resOut
        $expandLog = & expand.exe -R "$($cabPath.FullName)" "$resOut" 2>&1
        if ($LASTEXITCODE -ne 0) {
            $entry.warnings += "expand-failed: $cab :: $expandLog"
            continue
        }

        $kind = $expandTypes[$rt]
        $files = Get-ChildItem -Path $resOut -Recurse -File

        switch ($kind) {
            'assembly' {
                $dllFile = $files | Where-Object { $_.Extension -ieq '.dll' } | Select-Object -First 1
                if (-not $dllFile) { $entry.warnings += "no-dll-in-cab: $cab"; continue }
                $destDll = Join-Path $perMsi "assemblies\$($dllFile.Name)"
                Copy-Item -LiteralPath $dllFile.FullName -Destination $destDll -Force

                $asmInfo = [ordered]@{
                    fullName        = $r.Luid
                    dllPath         = (Get-RelPath $destDll $repoRoot)
                    maps            = @()
                    schemas         = @()
                    orchestrations  = @()
                    pipelines       = @()
                }

                try {
                    $dllBytes = [IO.File]::ReadAllBytes($destDll)

                    # Try managed-resource extraction first (use Load(byte[]) to avoid file locks)
                    $resourceItems = New-Object System.Collections.ArrayList
                    try {
                        $asm = [System.Reflection.Assembly]::Load($dllBytes)
                        foreach ($resName in $asm.GetManifestResourceNames()) {
                            $stream = $asm.GetManifestResourceStream($resName)
                            if (-not $stream) { continue }
                            try {
                                $ms = New-Object System.IO.MemoryStream
                                $stream.CopyTo($ms)
                                $rbytes = $ms.ToArray()
                            } finally { $stream.Dispose() }
                            $null = $resourceItems.Add([ordered]@{ name = $resName; bytes = $rbytes; source = 'manifestResource' })
                        }
                    } catch {
                        $entry.warnings += "reflect-warn: $($dllFile.Name) :: $($_.Exception.Message)"
                    }

                    # Fallback: scan IL UserStrings for embedded XML literals (BizTalk's default storage)
                    if ($resourceItems.Count -eq 0) {
                        $literals = Get-EmbeddedXmlLiterals $dllBytes
                        # Deduplicate by hash
                        $seen = @{}
                        $seqByKind = @{ map=0; schema=0; orchestration=0; pipeline=0 }
                        foreach ($lit in $literals) {
                            $kind = Classify-XmlLiteral $lit.text
                            if (-not $kind) { continue }
                            $hash = (Get-FileHash -Algorithm SHA1 -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($lit.text)))).Hash
                            if ($seen.ContainsKey($hash)) { continue }
                            $seen[$hash] = $true
                            $seqByKind[$kind]++
                            $ident = Get-XmlIdentifier $lit.text $kind $seqByKind[$kind]
                            $ext = switch ($kind) { 'map' {'.xsl'} 'schema' {'.xsd'} 'orchestration' {'.odx'} 'pipeline' {'.btp'} }
                            $resName = "$ident$ext"
                            $bytesUtf8 = [Text.Encoding]::UTF8.GetBytes($lit.text)
                            $null = $resourceItems.Add([ordered]@{ name = $resName; bytes = $bytesUtf8; source = 'ilUserString'; kind = $kind })
                        }
                    }

                    foreach ($item in $resourceItems) {
                        $resName = $item.name
                        $bytes   = $item.bytes
                        $ext = [IO.Path]::GetExtension($resName).ToLowerInvariant()
                        $type = $null; $sub = $null
                        switch ($ext) {
                            '.xsl'  { $sub = 'maps';            $type = 'map' }
                            '.xslt' { $sub = 'maps';            $type = 'map' }
                            '.xsd'  { $sub = 'schemas/native';  $type = 'schema' }
                            '.odx'  { $sub = 'orchestrations';  $type = 'orchestration' }
                            '.btp'  { $sub = 'pipelines';       $type = 'pipeline' }
                        }
                        if (-not $type) { continue }

                        $outName = if ($ext -eq '.xslt') { [IO.Path]::ChangeExtension($resName, '.xsl') } else { $resName }
                        $outPath = Join-Path $perMsi (Join-Path $sub $outName)
                        Ensure-Dir ([IO.Path]::GetDirectoryName($outPath))
                        [IO.File]::WriteAllBytes($outPath, $bytes)

                        $className = [IO.Path]::GetFileNameWithoutExtension($resName)
                        $relOut    = Get-RelPath $outPath $repoRoot

                        if ($type -eq 'map') {
                            $text = [Text.Encoding]::UTF8.GetString($bytes)
                            $usesInline   = ($text -match 'xmlns:userCSharp' -or $text -match 'xmlns:userVBNet' -or $text -match 'xmlns:userJScript' -or $text -match 'xmlns:userXslt')
                            $usesDbLookup = ($text -match 'xmlns:ScriptNS' -or $text -match 'userCSharp:LookupValue')
                            $xsltVer = ''
                            if ($text -match 'xsl:stylesheet[^>]*version\s*=\s*"([^"]+)"') { $xsltVer = $Matches[1] }
                            $extNs = @()
                            $nsPattern = 'xmlns:([A-Za-z0-9_\-]+)="([^"]+)"'
                            foreach ($m in [regex]::Matches($text, $nsPattern)) {
                                $prefix = $m.Groups[1].Value
                                if ($prefix -in @('xsl','msxsl','s0','ns0','b','var')) { continue }
                                $extNs += $prefix
                            }
                            $asmInfo.maps += [ordered]@{
                                class                  = $className
                                xsltPath               = $relOut
                                xsltVersion            = $xsltVer
                                usesInlineScript       = [bool]$usesInline
                                usesDatabaseLookup     = [bool]$usesDbLookup
                                containsEmbeddedSecrets= [bool]$usesDbLookup
                                extensionNamespaces    = ($extNs | Select-Object -Unique)
                            }
                        }
                        elseif ($type -eq 'schema') {
                            $text = [Text.Encoding]::UTF8.GetString($bytes)
                            $hasFF  = ($text -match 'biztalk-2003/properties' -and $text -match 'b:fieldInfo')
                            $hasEdi = ($text -match 'urn:.*:edi' -or $text -match 'X12' -or $text -match 'EDIFACT')
                            $root = ''
                            if ($text -match '<xs:element[^>]*name="([^"]+)"') { $root = $Matches[1] }
                            $asmInfo.schemas += [ordered]@{
                                class                 = $className
                                xsdPath               = $relOut
                                rootElement           = $root
                                hasFlatFileAnnotations= [bool]$hasFF
                                hasEdiAnnotations     = [bool]$hasEdi
                            }
                        }
                        elseif ($type -eq 'orchestration') {
                            $asmInfo.orchestrations += [ordered]@{ class = $className; odxPath = $relOut }
                        }
                        elseif ($type -eq 'pipeline') {
                            $asmInfo.pipelines += [ordered]@{ class = $className; btpPath = $relOut }
                        }
                    }
                } catch {
                    $entry.warnings += "extract-failed: $($dllFile.Name) :: $($_.Exception.Message)"
                }

                $entry.assemblies += $asmInfo
            }
            'binding' {
                foreach ($f in $files) {
                    if ($f.Extension -ieq '.xml') {
                        $dest = Join-Path $perMsi "bindings\$($f.Name)"
                        Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
                        $entry.bindings += (Get-RelPath $dest $repoRoot)
                    }
                }
            }
            'policy' {
                foreach ($f in $files) {
                    if ($f.Extension -ieq '.xml') {
                        $dest = Join-Path $perMsi "policies\$($f.Name)"
                        Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
                        $entry.policies += (Get-RelPath $dest $repoRoot)
                    }
                }
            }
            'vocabulary' {
                foreach ($f in $files) {
                    if ($f.Extension -ieq '.xml') {
                        $dest = Join-Path $perMsi "policies\$($f.Name)"
                        Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
                        $entry.policies += (Get-RelPath $dest $repoRoot)
                    }
                }
            }
            'pipelinecomponent' {
                foreach ($f in $files) {
                    if ($f.Extension -ieq '.dll' -or $f.Extension -ieq '.pdb') {
                        $dest = Join-Path $perMsi "components\$($f.Name)"
                        Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
                        if ($f.Extension -ieq '.dll') { $entry.pipelineComponents += (Get-RelPath $dest $repoRoot) }
                    }
                }
            }
            'helper' {
                foreach ($f in $files) {
                    if ($f.Extension -ieq '.dll' -or $f.Extension -ieq '.pdb') {
                        $dest = Join-Path $perMsi "helpers\$($f.Name)"
                        Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
                        if ($f.Extension -ieq '.dll') { $entry.helpers += (Get-RelPath $dest $repoRoot) }
                    }
                }
            }
        }
    }

    # Cleanup _work
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue

    $null = $msiEntries.Add($entry)
}

$manifest = [ordered]@{
    schemaVersion = 1
    extractedAt   = (Get-Date).ToUniversalTime().ToString('o')
    msis          = @($msiEntries)
}
$json = $manifest | ConvertTo-Json -Depth 12
Set-Content -LiteralPath (Join-Path $OutRoot '_manifest.json') -Value $json -Encoding UTF8

# Print summary
foreach ($e in $msiEntries) {
    if ($e.skipped) {
        Write-Host ("[SKIP] {0}: {1}" -f $e.msi, $e.reason)
    } else {
        $mapCount = ($e.assemblies | ForEach-Object { $_.maps.Count } | Measure-Object -Sum).Sum
        $schCount = ($e.assemblies | ForEach-Object { $_.schemas.Count } | Measure-Object -Sum).Sum
        $orchCount= ($e.assemblies | ForEach-Object { $_.orchestrations.Count } | Measure-Object -Sum).Sum
        $pipeCount= ($e.assemblies | ForEach-Object { $_.pipelines.Count } | Measure-Object -Sum).Sum
        Write-Host ("[OK]   {0}: asms={1} maps={2} schemas={3} orch={4} pipes={5} bindings={6} policies={7} components={8} helpers={9} warnings={10}" -f `
            $e.msi, $e.assemblies.Count, $mapCount, $schCount, $orchCount, $pipeCount, $e.bindings.Count, $e.policies.Count, $e.pipelineComponents.Count, $e.helpers.Count, $e.warnings.Count)
    }
}
