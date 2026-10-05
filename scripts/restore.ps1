<#
.SYNOPSIS
  Restaura un respaldo de scripts\backup.ps1 (Postgres + volumen App_Data) en la pila Docker Compose de Vectorify.

.DESCRIPTION
  DESTRUCTIVO sobre los datos actuales de ese proyecto compose: reemplaza TODO el contenido de la base (esquema
  public) y TODO el contenido del volumen vectorify_backend_data por lo del respaldo. Por eso NO hace nada hasta
  que lo confirmás: con -Force sigue sin preguntar; sin -Force muestra qué va a pisar y pide escribir RESTAURAR
  (en una sesión no interactiva, sin -Force, aborta sin tocar nada).
  Pasos: levanta Postgres (crea los volúmenes si no existen, p. ej. después de `docker compose down -v`), detiene el
  backend, restaura la base (pg_restore), vacía y restaura el volumen (tar), y vuelve a levantar la pila (el backend
  aplica las migraciones pendientes al arrancar, no hace falta nada más). Restaurá SIEMPRE los dos archivos del mismo
  respaldo: restaurar solo uno deja filas sin archivo o archivos sin fila (ver scripts\check-consistency.ps1).
  Si la pila usa puertos/variables propios (POSTGRES_PORT, BACKEND_PORT, ...), definí las mismas variables de entorno
  al correr el script para que compose no recree los contenedores con otra configuración.

.PARAMETER BackupDir
  Carpeta vectorify-backup-<fecha> generada por backup.ps1 (debe contener db.dump y backend_data.tar.gz).

.PARAMETER ProjectName
  Nombre del proyecto compose. Default: $env:COMPOSE_PROJECT_NAME, o el que compose deduce de la carpeta.

.PARAMETER Force
  Confirma la restauración (pisa los datos actuales) sin preguntar.

.PARAMETER NoStart
  No levanta la pila completa al terminar (deja solo Postgres corriendo).

.EXAMPLE
  .\scripts\restore.ps1 -BackupDir .\backups\vectorify-backup-20261005-120000
  .\scripts\restore.ps1 -BackupDir .\backups\vectorify-backup-20261005-120000 -ProjectName vectorify -Force
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BackupDir,
    [string]$ProjectName = $env:COMPOSE_PROJECT_NAME,
    [switch]$Force,
    [switch]$NoStart
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-Native {
    param([Parameter(Mandatory)][string]$Description, [Parameter(Mandatory)][scriptblock]$Command)
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "Falló: $Description (código $LASTEXITCODE)" }
}

$dump = Join-Path $BackupDir 'db.dump'
$tarball = Join-Path $BackupDir 'backend_data.tar.gz'
foreach ($file in $dump, $tarball) {
    if (-not (Test-Path $file)) { throw "Falta ${file}: no es una carpeta de respaldo válida (se esperaba la salida de backup.ps1)." }
}
$dump = (Resolve-Path $dump).Path
$tarball = (Resolve-Path $tarball).Path

$composeArgs = @('compose')
if ($ProjectName) { $composeArgs += @('-p', $ProjectName) }
$projectLabel = if ($ProjectName) { $ProjectName } else { '(el que compose deduce de la carpeta del repo)' }

Write-Host "Respaldo a restaurar : $((Resolve-Path $BackupDir).Path)"
Write-Host "Proyecto compose     : $projectLabel"
Write-Host 'Esto REEMPLAZA todo el contenido de la base (esquema public) y del volumen vectorify_backend_data de ese proyecto.'
if (-not $Force) {
    if (-not [Environment]::UserInteractive) {
        Write-Host 'Sesión no interactiva y sin -Force: no se toca nada.'
        exit 1
    }
    $answer = Read-Host 'Escribí RESTAURAR para continuar'
    if ($answer -cne 'RESTAURAR') {
        Write-Host 'Cancelado: no se tocó nada.'
        exit 1
    }
}

Push-Location $repoRoot
$helper = $null
try {
    # 1) Postgres arriba y sano (crea red/volumen de la base si no existen). El backend se detiene: nadie debe escribir mientras se restaura.
    Write-Host '1/4 levantando Postgres...'
    Invoke-Native 'docker compose up postgres' { & docker @composeArgs up -d --wait postgres }
    & docker @composeArgs stop backend 2>$null | Out-Null

    $postgresContainer = (& docker @composeArgs ps -q postgres | Select-Object -First 1)
    $inspected = (& docker inspect $postgresContainer | ConvertFrom-Json)[0]
    $resolvedProject = $inspected.Config.Labels.'com.docker.compose.project'
    $image = $inspected.Config.Image

    # 2) Base: se vacía el esquema public y se restaura el dump (incluye el historial de migraciones de EF).
    Write-Host '2/4 restaurando la base (pg_restore)...'
    Invoke-Native 'copiar db.dump al contenedor' { & docker @composeArgs cp $dump 'postgres:/tmp/vectorify.dump' }
    Invoke-Native 'vaciar el esquema public' { 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;' | & docker @composeArgs exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U $POSTGRES_USER -d $POSTGRES_DB' | Out-Null }
    Invoke-Native 'pg_restore' { & docker @composeArgs exec -T postgres sh -c 'pg_restore --no-owner --exit-on-error -U $POSTGRES_USER -d $POSTGRES_DB /tmp/vectorify.dump' }
    & docker @composeArgs exec -T postgres rm -f /tmp/vectorify.dump | Out-Null

    # 3) Volumen: se crea si no existe (con las etiquetas de compose, para que compose lo adopte) y se reemplaza su contenido.
    Write-Host '3/4 restaurando el volumen App_Data...'
    $volume = (& docker volume ls -q --filter "label=com.docker.compose.project=$resolvedProject" --filter 'label=com.docker.compose.volume=vectorify_backend_data' | Select-Object -First 1)
    if (-not $volume) {
        $volume = "${resolvedProject}_vectorify_backend_data"
        Invoke-Native 'crear el volumen' { & docker volume create --label "com.docker.compose.project=$resolvedProject" --label 'com.docker.compose.volume=vectorify_backend_data' $volume | Out-Null }
    }
    $helper = "vectorify-restore-helper-$([guid]::NewGuid().ToString('n').Substring(0, 8))"
    Invoke-Native 'crear contenedor auxiliar' { & docker create --name $helper -v "${volume}:/data" --entrypoint sh $image -c 'find /data -mindepth 1 -delete && tar xzf /tmp/backend_data.tar.gz -C /data' | Out-Null }
    Invoke-Native 'copiar backend_data.tar.gz' { & docker cp $tarball "${helper}:/tmp/backend_data.tar.gz" }
    Invoke-Native 'extraer el volumen' { & docker start -a $helper | Out-Null }

    # 4) Pila completa de nuevo (el backend migra lo pendiente al arrancar y lee todo del disco/la base).
    if ($NoStart) {
        Write-Host '4/4 -NoStart: la pila queda con solo Postgres. Levantala con: docker compose up -d'
    }
    else {
        Write-Host '4/4 levantando la pila...'
        Invoke-Native 'docker compose up' { & docker @composeArgs up -d --wait }
    }

    Write-Host ''
    Write-Host 'Restauración completa. Verificá con: .\scripts\check-consistency.ps1 -VerifyChecksums'
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
