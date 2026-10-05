<#
.SYNOPSIS
  Verifica en SOLO LECTURA que los Assets de la base y los archivos del storage de la pila Docker se correspondan.

.DESCRIPTION
  Envuelve `dotnet Vectorify.Api.dll --check-consistency` ejecutado dentro del contenedor del backend
  (docker compose exec). Lista los assets sin archivo, los archivos sin asset (huérfanos) y, con -VerifyChecksums,
  los assets cuyos bytes ya no coinciden con su SHA-256. No borra nada salvo que pases -DeleteOrphanFiles (borra
  únicamente archivos huérfanos con más de 10 minutos, nunca filas; hacelo con la API sin tráfico).
  Código de salida: 0 consistente, 1 hay inconsistencias, 2 no se pudo verificar.

.PARAMETER ProjectName
  Nombre del proyecto compose. Default: $env:COMPOSE_PROJECT_NAME, o el que compose deduce de la carpeta.

.EXAMPLE
  .\scripts\check-consistency.ps1
  .\scripts\check-consistency.ps1 -VerifyChecksums
#>
[CmdletBinding()]
param(
    [string]$ProjectName = $env:COMPOSE_PROJECT_NAME,
    [switch]$VerifyChecksums,
    [switch]$DeleteOrphanFiles
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$composeArgs = @('compose')
if ($ProjectName) { $composeArgs += @('-p', $ProjectName) }

$commandArgs = @('--check-consistency')
if ($VerifyChecksums) { $commandArgs += '--verify-checksums' }
if ($DeleteOrphanFiles) { $commandArgs += '--delete-orphan-files' }

Push-Location $repoRoot
try {
    & docker @composeArgs exec -T backend dotnet Vectorify.Api.dll @commandArgs
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
