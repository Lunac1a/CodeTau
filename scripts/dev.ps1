$ErrorActionPreference = "Stop"

$runtime = Join-Path $HOME ".cache\codex-runtimes\codex-primary-runtime\dependencies"
$nodeDir = Join-Path $runtime "node\bin"
$binDir = Join-Path $runtime "bin"
$gitDir = Join-Path $runtime "native\git\cmd"
$pythonExe = Join-Path $runtime "python\python.exe"

if (-not (Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path $nodeDir)) {
  $env:PATH = "$nodeDir;$binDir;$gitDir;$env:PATH"
}

if (Test-Path $pythonExe) {
  Set-Alias python $pythonExe -Scope Script
}

Write-Host "CodeTau development environment"
Write-Host "  Node:   $(& node --version)"
Write-Host "  pnpm:   $(& pnpm --version)"
Write-Host "  Python: $(& python --version)"
Write-Host "  Git:    $(& git --version)"
Write-Host ""
Write-Host "Environment ready. Keep this PowerShell session open."
