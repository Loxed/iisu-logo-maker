# Start the local UI on http://127.0.0.1:8765
# Usage: .\run.ps1        or        .\run.ps1 -Port 8790
param([int]$Port = 8765)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$venvPython = Join-Path $here ".venv\Scripts\python.exe"
$python = if (Test-Path $venvPython) { $venvPython } else { "python" }

& $python -m svgextrude.server --port $Port
