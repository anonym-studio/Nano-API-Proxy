# Registers the Nano API Proxy Native Messaging Host for the current user on Windows
# (spec §5 item 7). Native Messaging Host manifests pin allowed_origins to a specific extension
# ID (wildcards aren't allowed), so this script needs that ID as an argument.
#
# Usage:
#   1. Load this repo as an unpacked extension (chrome://extensions -> Developer mode -> Load
#      unpacked) and copy the extension ID shown there.
#   2. Have a host binary ready — either build one (cd host; go build -o bin\nano-proxy-host.exe .)
#      or use the prebuilt one from a Release zip (host\bin\nano-proxy-host-windows-amd64.exe);
#      this script auto-selects that prebuilt binary if host\bin\nano-proxy-host.exe doesn't exist.
#   3. .\install.ps1 -ExtensionId <chrome-extension-id>
param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinDir = Join-Path $ScriptDir "host\bin"
$BinaryPath = Join-Path $BinDir "nano-proxy-host.exe"
$HostName = "com.local.nano.proxy"
$TemplatePath = Join-Path $ScriptDir "host-manifest.template.json"

if (-not (Test-Path $BinaryPath)) {
    $Prebuilt = Join-Path $BinDir "nano-proxy-host-windows-amd64.exe"
    if (Test-Path $Prebuilt) {
        Copy-Item $Prebuilt $BinaryPath
        Write-Host "Using prebuilt binary: $Prebuilt"
    }
}

if (-not (Test-Path $BinaryPath)) {
    Write-Error "error: $BinaryPath not found, and no prebuilt binary was found in $BinDir. Build it yourself: cd host; go build -o bin\nano-proxy-host.exe ."
}

$ManifestDir = Join-Path $env:LOCALAPPDATA "Nano-API-Proxy"
New-Item -ItemType Directory -Force -Path $ManifestDir | Out-Null
$TargetFile = Join-Path $ManifestDir "$HostName.json"

$manifest = Get-Content $TemplatePath -Raw | ConvertFrom-Json
$manifest.path = $BinaryPath
$manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $TargetFile -Encoding UTF8

$RegistryKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $RegistryKey -Force | Out-Null
Set-ItemProperty -Path $RegistryKey -Name "(default)" -Value $TargetFile

Write-Host "Installed Native Messaging Host manifest: $TargetFile"
Write-Host "Registered under: $RegistryKey"
Write-Host "  path:            $BinaryPath"
Write-Host "  allowed_origins: chrome-extension://$ExtensionId/"
