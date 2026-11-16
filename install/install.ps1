# Syok Code installer for Windows (PowerShell).
#   irm https://syok-ai.com/syok-code/install.ps1 | iex
# Puts everything in %USERPROFILE%\.syok and adds one folder to your own PATH (no administrator rights needed).
# It brings its own private copy of the Bun runtime, so you do not need to install anything first.
# Run it again any time to update.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$BunVersion = if ($env:SYOK_BUN_VERSION) { $env:SYOK_BUN_VERSION } else { '1.4.4' }
$Site = if ($env:SYOK_SITE) { $env:SYOK_SITE } else { 'https://syok-ai.com/syok-code' }
$BunBase = if ($env:SYOK_BUN_BASE) { $env:SYOK_BUN_BASE } else { "https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion" }
$Dir = if ($env:SYOK_HOME) { $env:SYOK_HOME } else { Join-Path $env:USERPROFILE '.syok' }
$Bin = Join-Path $Dir 'bin'

function Fail($m) { throw "Syok Code install failed: $m" }
function Sha($p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }
# Downloads are https only. (http is accepted only from this same computer, which the automatic tests use.)
function Get($u, $o) {
  if ($u -notmatch '^https://' -and $u -notmatch '^http://(127\.0\.0\.1|localhost):') { Fail "refusing a download that is not https: $u" }
  try { Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $o } catch { Fail "could not download $u" }
}

$arch = $env:PROCESSOR_ARCHITEW6432; if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
if ($arch -eq 'ARM64') { $target = 'bun-windows-aarch64' }
elseif ($arch -eq 'AMD64') {
  $target = 'bun-windows-x64'
  # Older processors without AVX2 need the "baseline" build.
  try {
    Add-Type -Namespace SyokCpu -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int f);'
    if (-not [SyokCpu.K]::IsProcessorFeaturePresent(40)) { $target = 'bun-windows-x64-baseline' }
  } catch {}
} else { Fail "unsupported processor: $arch" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("syok-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp, $Bin | Out-Null
try {
  $bunExe = Join-Path $Bin 'bun.exe'
  $have = ''
  if (Test-Path $bunExe) { try { $have = (& $bunExe --version) } catch {} }
  if ($have -ne $BunVersion) {
    Write-Host "Downloading the runtime ($target $BunVersion)..."
    Get "$BunBase/$target.zip" (Join-Path $tmp 'bun.zip')
    Get "$BunBase/SHASUMS256.txt" (Join-Path $tmp 'sums.txt')
    $row = Get-Content (Join-Path $tmp 'sums.txt') | Where-Object { $_ -match "\s$([regex]::Escape($target))\.zip$" } | Select-Object -First 1
    if (-not $row) { Fail "no checksum is published for $target.zip" }
    if ((Sha (Join-Path $tmp 'bun.zip')) -ne ($row -split '\s+')[0].ToLower()) { Fail 'the runtime download is damaged (checksum does not match). Try again.' }
    Expand-Archive -LiteralPath (Join-Path $tmp 'bun.zip') -DestinationPath (Join-Path $tmp 'x') -Force
    $got = Join-Path $tmp "x\$target\bun.exe"
    if (-not (Test-Path $got)) { Fail 'the runtime download did not contain the program' }
    & $got --version | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'the runtime does not start on this computer' }
    Move-Item -Force $got $bunExe
  }

  Write-Host 'Downloading Syok Code...'
  $js = Join-Path $tmp 'syok.js'
  Get "$Site/syok.js" $js
  Get "$Site/syok.js.sha256" (Join-Path $tmp 'syok.sum')
  $want = ((Get-Content (Join-Path $tmp 'syok.sum') | Select-Object -First 1) -split '\s+')[0].ToLower()
  if (-not $want -or (Sha $js) -ne $want) { Fail 'the Syok Code download is damaged (checksum does not match). Try again.' }
  & $bunExe $js --help | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'the downloaded program does not start' }
  Move-Item -Force $js (Join-Path $Dir 'syok.js')

  # The "syok" command.
  Set-Content -Encoding ASCII -Path (Join-Path $Bin 'syok.cmd') -Value "@echo off`r`n`"%~dp0bun.exe`" `"%~dp0..\syok.js`" %*"

  # Make the command findable: add the folder to your own PATH (not the whole computer's).
  $userPath = "$([Environment]::GetEnvironmentVariable('Path', 'User'))"
  $added = $false
  if (-not (($userPath -split ';') -contains $Bin)) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $Bin).TrimStart(';')), 'User')
    $added = $true
  }
  if (-not (($env:Path -split ';') -contains $Bin)) { $env:Path = "$env:Path;$Bin" }

  Write-Host ''
  Write-Host "Syok Code is installed: $(Join-Path $Bin 'syok.cmd')"
  if ($added) { Write-Host "New terminal windows will find the 'syok' command. This window can use it now." }
  Write-Host "Next: set your Syok address and key, then run 'syok' in a project folder. See: syok --help"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
