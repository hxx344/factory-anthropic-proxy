param(
    [string]$Config = $env:PROXY_CONFIG
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$NodeVersion = '24.15.0'
$Node = $null

function Test-NodeVersion([string]$Executable) {
    try {
        $Version = & $Executable --version 2>$null
        return $LASTEXITCODE -eq 0 -and $Version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22
    } catch { return $false }
}

try {
    $ExistingNode = Get-Command node -ErrorAction SilentlyContinue
    if ($ExistingNode -and (Test-NodeVersion $ExistingNode.Source)) {
        $Node = $ExistingNode.Source
        Write-Host "Using Node.js $(& $Node --version)."
    } else {
        if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
            throw 'Automatic runtime installation supports Windows x64. Install Node.js 22 or later for this architecture.'
        }
        $RuntimeRoot = Join-Path $ProjectRoot '.local\runtime'
        $RuntimeName = "node-v$NodeVersion-win-x64"
        $Node = Join-Path $RuntimeRoot "$RuntimeName\node.exe"
        if (-not (Test-Path -LiteralPath $Node) -or -not (Test-NodeVersion $Node)) {
            New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
            $Stage = Join-Path $RuntimeRoot ('.download-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $Stage | Out-Null
            try {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                $ArchiveName = "$RuntimeName.zip"
                $Archive = Join-Path $Stage $ArchiveName
                $SumsPath = Join-Path $Stage 'SHASUMS256.txt'
                $BaseUrl = "https://nodejs.org/dist/v$NodeVersion"
                Write-Host "Downloading Node.js $NodeVersion once."
                Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHASUMS256.txt" -OutFile $SumsPath -TimeoutSec 120
                Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$ArchiveName" -OutFile $Archive -TimeoutSec 300
                $SumLine = Get-Content -LiteralPath $SumsPath | Where-Object { $_ -match ('^[a-fA-F0-9]{64}\s+' + [regex]::Escape($ArchiveName) + '$') }
                if (@($SumLine).Count -ne 1) { throw 'The official Node.js checksum entry is missing or ambiguous.' }
                $Expected = ($SumLine -split '\s+')[0]
                if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $Expected) { throw 'Node.js download checksum mismatch.' }
                Expand-Archive -LiteralPath $Archive -DestinationPath $Stage
                $StagedRuntime = Join-Path $Stage $RuntimeName
                if (-not (Test-NodeVersion (Join-Path $StagedRuntime 'node.exe'))) { throw 'The downloaded Node.js runtime did not pass its version check.' }
                $TargetRuntime = Join-Path $RuntimeRoot $RuntimeName
                if (Test-Path -LiteralPath $TargetRuntime) {
                    $ResolvedTarget = [IO.Path]::GetFullPath($TargetRuntime)
                    $ResolvedRoot = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\') + '\'
                    if (-not $ResolvedTarget.StartsWith($ResolvedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe runtime target.' }
                    Move-Item -LiteralPath $ResolvedTarget -Destination ($ResolvedTarget + '.previous-' + [guid]::NewGuid().ToString('N'))
                }
                Move-Item -LiteralPath $StagedRuntime -Destination $TargetRuntime
            } finally {
                $ResolvedStage = [IO.Path]::GetFullPath($Stage)
                $ResolvedRuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\') + '\'
                if ($ResolvedStage.StartsWith($ResolvedRuntimeRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $ResolvedStage)) {
                    Remove-Item -LiteralPath $ResolvedStage -Recurse -Force
                }
            }
        } else { Write-Host 'Using the cached Node.js runtime.' }
    }
    Set-Location -LiteralPath $ProjectRoot
    if (-not $Config) { $Config = Join-Path $ProjectRoot 'proxy.config.json' }
    if (-not [IO.Path]::IsPathRooted($Config)) { $Config = Join-Path $ProjectRoot $Config }
    $env:PROXY_CONFIG = [IO.Path]::GetFullPath($Config)
    & $Node (Join-Path $ProjectRoot 'bin\proxy.mjs') init
    if ($LASTEXITCODE -ne 0) { throw 'Proxy configuration initialization failed.' }
    Write-Host 'Starting the proxy. Press Ctrl+C or close this window to stop it.'
    & $Node (Join-Path $ProjectRoot 'bin\proxy.mjs') serve
    if ($LASTEXITCODE -ne 0) { throw "Proxy exited with status $LASTEXITCODE." }
} catch {
    Write-Error $_
    exit 1
}
