<#
.SYNOPSIS
  Reasigna los datos LEGADOS (proyectos del usuario de desarrollo y registros clásicos sin dueño) a UNA cuenta real existente (M3.1-S10, ADR P10).

.DESCRIPTION
  Envuelve `dotnet Vectorify.Api.dll --reassign-legacy-data` (ver backend/Vectorify.Api/Maintenance/ReassignLegacyDataCommand.cs).
  Sin -Apply es un DRY-RUN: solo informa qué cambiaría y no escribe nada (puede correr con la API arriba). Con -Apply: pide confirmar
  la COPIA DE SEGURIDAD (scripts\backup.ps1), PARA el backend (guarda los registros clásicos en memoria), corre el comando en un contenedor
  efímero con los mismos volúmenes y la misma base, y vuelve a ARRANCAR el backend. Idempotente.
  Código de salida: 0 correcto, 1 aplicado a medias (repetir), 2 no se pudo.
  NUNCA la ejecute contra datos reales sin decidir a quién se asignan (decisión de producto, docs/MVP31_RELEASE.md).

.PARAMETER TargetEmail
  Correo de la cuenta destino (registrada y con al menos un inicio de sesión).

.PARAMETER ProjectName
  Nombre del proyecto compose. Default: $env:COMPOSE_PROJECT_NAME, o el que compose deduce de la carpeta.

.PARAMETER Apply
  Aplica el cambio. Sin esta opción solo informa.

.PARAMETER Yes
  No pide la confirmación interactiva al aplicar.

.EXAMPLE
  .\scripts\reassign-legacy-data.ps1 -TargetEmail ana@ejemplo.com            # dry-run
  .\scripts\reassign-legacy-data.ps1 -TargetEmail ana@ejemplo.com -Apply
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TargetEmail,
    [string]$ProjectName = $env:COMPOSE_PROJECT_NAME,
    [switch]$Apply,
    [switch]$Yes
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$composeArgs = @('compose')
if ($ProjectName) { $composeArgs += @('-p', $ProjectName) }
$commandArgs = @('--reassign-legacy-data', "--target-email=$TargetEmail")

Push-Location $repoRoot
try {
    if (-not $Apply) {
        & docker @composeArgs exec -T backend dotnet Vectorify.Api.dll @commandArgs
        exit $LASTEXITCODE
    }

    Write-Host "Se van a REASIGNAR datos legados a la cuenta indicada en el proyecto compose '$ProjectName'."
    Write-Host 'Antes: 1) ¿hiciste una COPIA DE SEGURIDAD (scripts\backup.ps1)? 2) ¿corriste primero el DRY-RUN (sin -Apply) y revisaste la lista?'
    if (-not $Yes) {
        $answer = Read-Host 'Escribí SI para continuar'
        if ($answer -ne 'SI') { Write-Host 'Cancelado: no se cambió nada.'; exit 2 }
    }

    Write-Host 'Parando el backend (sus registros clásicos en memoria quedarían obsoletos)...'
    & docker @composeArgs stop backend | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Error 'No se pudo parar el backend.'; exit 2 }
    try {
        & docker @composeArgs run --rm --no-deps -T backend dotnet Vectorify.Api.dll @commandArgs '--apply'
        $code = $LASTEXITCODE
    }
    finally {
        Write-Host 'Arrancando el backend...'
        & docker @composeArgs start backend | Out-Null
    }
    exit $code
}
finally {
    Pop-Location
}
