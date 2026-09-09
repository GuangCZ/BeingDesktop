$ErrorActionPreference = 'Stop'
# UI checks never copy a saved Being connection.
& (Join-Path $PSScriptRoot 'Run-OnboardingAudit.ps1')
