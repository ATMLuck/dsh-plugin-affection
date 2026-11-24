# Run from the repository root after npm ci. Only the local DSH installation and
# npm dependencies already present on disk are used. Each run owns a fresh home.
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $project
$previousHome = $env:DSH_HOME
$previousRestore = $env:AFFECTION_SMOKE_RESTORE
$previousLive = $env:AFFECTION_SMOKE_LIVE
try {
    $stage = Join-Path $project ('.local-test/host-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    $env:DSH_HOME = Join-Path $stage 'home'
    $env:AFFECTION_SMOKE_RESTORE = '0'
    $env:AFFECTION_SMOKE_LIVE = '0'
    function Invoke-Dsh {
        & dsh @args 2>&1 | ForEach-Object { ("$_" -replace 'token=[^ ]+', 'token=<redacted>') }
        if ($LASTEXITCODE -ne 0) { throw "DSH exited with $LASTEXITCODE" }
    }
    function New-TestPackage($source) {
        $cache = Join-Path $stage 'npm-cache'
        $file = & npm pack $source --pack-destination $stage --cache $cache --silent
        if ($LASTEXITCODE -ne 0) { throw "npm pack failed for $source" }
        return Join-Path $stage ($file | Select-Object -Last 1)
    }

    $plugin = New-TestPackage '.'
    $zod = New-TestPackage './node_modules/zod'
    Invoke-Dsh --profile web --dump-config | Out-Null
    $profile = Join-Path $env:DSH_HOME 'profiles/web'
    $store = (Join-Path $stage 'pnpm-store').Replace('\','/').Replace("'","''")
    $zod = $zod.Replace('\','/').Replace("'","''")
    Add-Content -LiteralPath (Join-Path $profile 'pnpm-workspace.yaml') -Value @"
packageImportMethod: copy
storeDir: '$store'
overrides:
  zod: 'file:$zod'
"@
    Invoke-Dsh plugin --profile web add $plugin --offline
    $fixture = (Join-Path $PSScriptRoot 'fixtures/host-smoke.mjs').Replace('\','/').Replace("'","''")
    $overlay = Join-Path $stage 'smoke.yml'
    Set-Content -LiteralPath $overlay -Value @"
- id: affection
  config:
    enabledPresets: [standard]
- insert:
    - id: affection-smoke
      name: '$fixture'
"@
    Invoke-Dsh --profile web --patch $overlay --no-open --port 0
    $env:AFFECTION_SMOKE_RESTORE = '1'
    Invoke-Dsh --profile web --patch $overlay --no-open --port 0
    Invoke-Dsh plugin --profile web remove dsh-plugin-affection
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $profile 'package.json') | ConvertFrom-Json
    if ('dsh-plugin-affection' -in $manifest.dsh.profile.bundles) { throw 'Uninstall retained the bundle' }
    Write-Output 'Verified packed install, agent turns, reload, restart and uninstall.'
} finally {
    $env:DSH_HOME = $previousHome
    $env:AFFECTION_SMOKE_RESTORE = $previousRestore
    $env:AFFECTION_SMOKE_LIVE = $previousLive
    Pop-Location
}
