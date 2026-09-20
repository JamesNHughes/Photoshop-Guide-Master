$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot = Split-Path $PSScriptRoot -Parent
$pluginRoot = Join-Path $projectRoot 'ps-copy-paste-guides'
$manifest = Get-Content -LiteralPath (Join-Path $pluginRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.id -ne 'GuideMasterPhotoshop' -or $manifest.host.app -ne 'PS') {
    throw 'Expected the Photoshop-specific plugin identity and host.'
}
$releaseRoot = Join-Path $projectRoot 'Release'
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$packagePath = Join-Path $releaseRoot "$($manifest.id)_$($manifest.version).ccx"
$archive = [IO.Compression.ZipFile]::Open($packagePath, [IO.Compression.ZipArchiveMode]::Create)
try {
    # Exclude personal preset data, documentation, tests, and development files.
    $relativePaths = @('manifest.json', 'index.html', 'main.js', 'dialogs.js')
    $relativePaths += Get-ChildItem -LiteralPath (Join-Path $pluginRoot 'icons') -File |
        ForEach-Object { 'icons/' + $_.Name }
    foreach ($relativePath in $relativePaths) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, (Join-Path $pluginRoot $relativePath), $relativePath,
            [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {
    $archive.Dispose()
}
Write-Output $packagePath
