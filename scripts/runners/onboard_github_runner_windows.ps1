param(
  [Parameter(Mandatory=$true)][string] $Token,
  [Parameter(Mandatory=$true)][string] $Url,
  [Parameter(Mandatory=$false)][string] $Name  = $(hostname).ToUpper() + "-RUNNER",
  [Parameter(Mandatory=$false)][string] $InstallDir = "C:\actions-runner"
)

# Support positional args for convenience:
#   .\onboard_github_runner_windows.sh <token> <url>
if (-not $Token -and $args.Count -ge 1) { $Token = $args[0] }
if (-not $Url   -and $args.Count -ge 2) { $Url   = $args[1] }

function Show-Usage {
  Write-Output "Usage:"
  Write-Output "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Token <TOKEN> -Url <GITHUB_URL>"
  Write-Output "  OR (positional): powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" <TOKEN> <GITHUB_URL>"
  exit 1
}

if (-not $Token -or -not $Url) {
  Write-Warning "Missing required parameters."
  Show-Usage
}

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  Write-Error "This script must be run as Administrator."
  exit 1
}

$Latest = (Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/actions/runner/releases/latest")
$Tag = $Latest.tag_name
$Version = $Tag.TrimStart("v")
$Archive = "actions-runner-win-x64-$Version.zip"
$DownloadUrl = "https://github.com/actions/runner/releases/download/$Tag/$Archive"

$TargetDir = Join-Path -Path $InstallDir -ChildPath ($Name -replace '[^a-zA-Z0-9\-_]','')
$ArchivePath = Join-Path -Path $env:TEMP -ChildPath $Archive

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

Write-Output "Downloading runner $Tag..."
Invoke-WebRequest -UseBasicParsing -Uri $DownloadUrl -OutFile $ArchivePath

Write-Output "Extracting to $TargetDir..."
Expand-Archive -Force -Path $ArchivePath -DestinationPath $TargetDir

# configure runner non-interactive
pushd $TargetDir
$ConfigCmd = Join-Path $TargetDir "config.cmd"
Write-Output "Configuring runner..."
& $ConfigCmd --unattended --url $Url --token $Token --name $Name --work _work --runasservice
if ($LASTEXITCODE -ne 0) {
  Write-Error "Runner config failed."
  popd
  exit 1
}