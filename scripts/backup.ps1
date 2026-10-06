<#
.SYNOPSIS
  Respalda la pila Docker Compose de Vectorify (dev/staging): Postgres + volumen App_Data.

.DESCRIPTION
  Genera, dentro de <OutDir>\vectorify-backup-<fecha>\, tres archivos que se respaldan JUNTOS (ver docs/BACKUP_RESTORE.md):
    db.dump              pg_dump -Fc de la base (formato custom, se restaura con pg_restore)
    backend_data.tar.gz  contenido del volumen vectorify_backend_data (= /app/App_Data: originales, assets/SVG,
                         thumbnails y registros clásicos JSON)
    manifest.txt         fecha, proyecto compose, versión de Postgres, conteos y SHA-256 de los archivos
  NO destructivo: solo lee (la base y el volumen se leen, nada se borra ni se detiene) y nunca pisa un respaldo
  anterior (cada corrida crea su propia carpeta; si ya existe, falla). Requiere que Postgres esté corriendo.
  El dump se toma ANTES que el tar del volumen a propósito: un archivo guardado entre medio queda como archivo
  sin fila (huérfano inofensivo), nunca como fila sin archivo.
  Si la pila se creó con puertos/variables propios (POSTGRES_PORT, BACKEND_PORT, ...), definí las mismas variables
  de entorno al correr el script: docker compose las usa para resolver el archivo.

.PARAMETER OutDir
  Carpeta destino (se crea si no existe). Default: .\backups

.PARAMETER ProjectName
  Nombre del proyecto compose. Default: $env:COMPOSE_PROJECT_NAME, o el que compose deduce de la carpeta.

.EXAMPLE
  .\scripts\backup.ps1
  .\scripts\backup.ps1 -OutDir D:\respaldos -ProjectName vectorify
#>
[CmdletBinding()]
param(
    [string]$OutDir = (Join-Path (Get-Location).Path 'backups'),
    [string]$ProjectName = $env:COMPOSE_PROJECT_NAME
)

# Los comandos nativos (docker) escriben progreso por stderr: se valida por $LASTEXITCODE, no por excepciones.
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-Native {
    param([Parameter(Mandatory)][string]$Description, [Parameter(Mandatory)][scriptblock]$Command)
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "Falló: $Description (código $LASTEXITCODE)" }
}

# SHA-256 con .NET puro: Get-FileHash no existe en todos los hosts de PowerShell (PowerShell < 4, hosts restringidos);
# en M2.2-S10 un host así hizo fallar el manifiesto ("Get-FileHash no se reconoce") y el ciclo de backup no se pudo verificar.
function Get-Sha256Hex {
    param([Parameter(Mandatory)][string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}

$composeArgs = @('compose')
if ($ProjectName) { $composeArgs += @('-p', $ProjectName) }

Push-Location $repoRoot
$helper = $null
try {
    $postgresContainer = (& docker @composeArgs ps --status running -q postgres | Select-Object -First 1)
    if (-not $postgresContainer) {
        throw "Postgres no está corriendo en el proyecto compose '$ProjectName'. Levantá la pila (docker compose up -d) y reintentá."
    }
    $inspected = (& docker inspect $postgresContainer | ConvertFrom-Json)[0]
    $resolvedProject = $inspected.Config.Labels.'com.docker.compose.project'
    $image = $inspected.Config.Image
    $volume = (& docker volume ls -q --filter "label=com.docker.compose.project=$resolvedProject" --filter 'label=com.docker.compose.volume=vectorify_backend_data' | Select-Object -First 1)
    if (-not $volume) { throw "No se encontró el volumen vectorify_backend_data del proyecto '$resolvedProject'." }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $target = Join-Path $OutDir "vectorify-backup-$stamp"
    if (Test-Path $target) { throw "Ya existe $target; no se pisan respaldos. Reintentá en un segundo." }
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    $target = (Resolve-Path $target).Path

    Write-Host "Proyecto compose : $resolvedProject"
    Write-Host "Volumen de datos : $volume"
    Write-Host "Destino          : $target"

    # 1) Base: pg_dump dentro del contenedor (usa POSTGRES_USER/POSTGRES_DB del propio contenedor) y copia binaria hacia afuera.
    #    No se usa redirección ">" de PowerShell: corrompe archivos binarios.
    Write-Host '1/3 pg_dump (Postgres)...'
    Invoke-Native 'pg_dump' { & docker @composeArgs exec -T postgres sh -c 'pg_dump -U $POSTGRES_USER -d $POSTGRES_DB -Fc -f /tmp/vectorify.dump' }
    Invoke-Native 'copiar db.dump' { & docker @composeArgs cp 'postgres:/tmp/vectorify.dump' (Join-Path $target 'db.dump') }
    & docker @composeArgs exec -T postgres rm -f /tmp/vectorify.dump | Out-Null

    # 2) Volumen: tar.gz en un contenedor efímero (lectura solamente) y copia hacia afuera. La imagen de Postgres ya está local (trae tar).
    Write-Host '2/3 tar del volumen App_Data...'
    $helper = "vectorify-backup-helper-$([guid]::NewGuid().ToString('n').Substring(0, 8))"
    Invoke-Native 'crear contenedor auxiliar' { & docker create --name $helper -v "${volume}:/data:ro" --entrypoint tar $image czf /tmp/backend_data.tar.gz -C /data . | Out-Null }
    Invoke-Native 'tar del volumen' { & docker start -a $helper | Out-Null }
    Invoke-Native 'copiar backend_data.tar.gz' { & docker cp "${helper}:/tmp/backend_data.tar.gz" (Join-Path $target 'backend_data.tar.gz') }

    # 3) Manifiesto: sirve para verificar el respaldo a mano y para comparar contra lo restaurado.
    Write-Host '3/3 manifiesto...'
    $query = @'
SELECT 'projects=' || (SELECT count(*) FROM projects) || ' assets=' || (SELECT count(*) FROM assets) || ' document_versions=' || (SELECT count(*) FROM document_versions) || ' layers=' || (SELECT count(*) FROM layers) || ' migrations=' || (SELECT count(*) FROM "__EFMigrationsHistory");
'@
    $counts = ($query | & docker @composeArgs exec -T postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -At') -join ' '
    $pgVersion = (('SHOW server_version;' | & docker @composeArgs exec -T postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -At') -join ' ').Trim()
    $files = foreach ($name in 'db.dump', 'backend_data.tar.gz') {
        $path = Join-Path $target $name
        '{0}  {1}  {2} bytes' -f (Get-Sha256Hex $path), $name, (Get-Item $path).Length
    }
    @(
        "vectorify-backup creado: $(Get-Date -Format o)",
        "compose_project: $resolvedProject",
        "postgres_version: $pgVersion",
        "conteos: $($counts.Trim())",
        'sha256:'
    ) + $files | Set-Content -Path (Join-Path $target 'manifest.txt') -Encoding UTF8

    Write-Host ''
    Write-Host "Respaldo completo: $target"
    Get-Content (Join-Path $target 'manifest.txt') | ForEach-Object { Write-Host "  $_" }
}
catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    $failed = $true
}
finally {
    if ($helper) { & docker rm -f $helper 2>$null | Out-Null }
    Pop-Location
}
if ($failed) { exit 1 }
