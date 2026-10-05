#!/usr/bin/env bash
# Restaura un respaldo de scripts/backup.sh|ps1 (Postgres + volumen App_Data) en la pila Docker Compose de Vectorify.
#
# Uso:   scripts/restore.sh -b CARPETA_DEL_RESPALDO [-p NOMBRE_PROYECTO_COMPOSE] [-f] [-n]
#          -b  carpeta vectorify-backup-<fecha> (debe contener db.dump y backend_data.tar.gz)
#          -p  proyecto compose (default: $COMPOSE_PROJECT_NAME o el que compose deduce de la carpeta)
#          -f  confirma sin preguntar (equivale a -Force de la versión PowerShell)
#          -n  no levantar la pila completa al terminar (queda solo Postgres)
#
# DESTRUCTIVO sobre los datos actuales de ese proyecto compose: reemplaza TODO el contenido de la base (esquema
# public) y del volumen vectorify_backend_data. Sin -f muestra qué va a pisar y pide escribir RESTAURAR (sin terminal
# interactiva y sin -f, aborta sin tocar nada). Restaurá SIEMPRE los dos archivos del mismo respaldo.
# Si la pila usa puertos/variables propios (POSTGRES_PORT, BACKEND_PORT...), exportalos al correr.
set -euo pipefail

# Git Bash/MSYS (Windows) reescribe argumentos que parecen rutas (/tmp/...) y rompe `docker cp`/`docker exec`.
export MSYS_NO_PATHCONV=1

BACKUP_DIR=""
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
FORCE=0
NO_START=0
while getopts "b:p:fnh" opt; do
  case "$opt" in
    b) BACKUP_DIR="$OPTARG" ;;
    p) PROJECT_NAME="$OPTARG" ;;
    f) FORCE=1 ;;
    n) NO_START=1 ;;
    *) sed -n '2,13p' "$0"; exit 1 ;;
  esac
done

[[ -n "$BACKUP_DIR" ]] || { echo "Falta -b CARPETA_DEL_RESPALDO" >&2; exit 1; }
dump="$BACKUP_DIR/db.dump"
tarball="$BACKUP_DIR/backend_data.tar.gz"
for file in "$dump" "$tarball"; do
  [[ -f "$file" ]] || { echo "Falta $file: no es una carpeta de respaldo válida (se esperaba la salida de backup)." >&2; exit 1; }
done
dump="$(cd "$(dirname "$dump")" && { pwd -W 2>/dev/null || pwd; })/db.dump"  # pwd -W: ruta Windows en Git Bash (docker.exe no entiende /tmp/...)
tarball="$(cd "$(dirname "$tarball")" && { pwd -W 2>/dev/null || pwd; })/backend_data.tar.gz"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
compose=(docker compose)
[[ -n "$PROJECT_NAME" ]] && compose+=(-p "$PROJECT_NAME")

echo "Respaldo a restaurar : $BACKUP_DIR"
echo "Proyecto compose     : ${PROJECT_NAME:-(el que compose deduce de la carpeta del repo)}"
echo "Esto REEMPLAZA todo el contenido de la base (esquema public) y del volumen vectorify_backend_data de ese proyecto."
if [[ "$FORCE" -ne 1 ]]; then
  if [[ ! -t 0 ]]; then
    echo "Sin terminal interactiva y sin -f: no se toca nada."
    exit 1
  fi
  read -r -p "Escribí RESTAURAR para continuar: " answer
  if [[ "$answer" != "RESTAURAR" ]]; then
    echo "Cancelado: no se tocó nada."
    exit 1
  fi
fi

helper=""
cleanup() { [[ -n "$helper" ]] && docker rm -f "$helper" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "1/4 levantando Postgres..."
"${compose[@]}" up -d --wait postgres
"${compose[@]}" stop backend >/dev/null 2>&1 || true

postgres_container="$("${compose[@]}" ps -q postgres | head -n1)"
resolved_project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$postgres_container")"
image="$(docker inspect -f '{{ .Config.Image }}' "$postgres_container")"

echo "2/4 restaurando la base (pg_restore)..."
"${compose[@]}" cp "$dump" postgres:/tmp/vectorify.dump
"${compose[@]}" exec -T postgres sh -c "psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'" >/dev/null
"${compose[@]}" exec -T postgres sh -c 'pg_restore --no-owner --exit-on-error -U "$POSTGRES_USER" -d "$POSTGRES_DB" /tmp/vectorify.dump'
"${compose[@]}" exec -T postgres rm -f /tmp/vectorify.dump

echo "3/4 restaurando el volumen App_Data..."
volume="$(docker volume ls -q --filter "label=com.docker.compose.project=$resolved_project" --filter 'label=com.docker.compose.volume=vectorify_backend_data' | head -n1)"
if [[ -z "$volume" ]]; then
  volume="${resolved_project}_vectorify_backend_data"
  docker volume create --label "com.docker.compose.project=$resolved_project" --label 'com.docker.compose.volume=vectorify_backend_data' "$volume" >/dev/null
fi
helper="vectorify-restore-helper-$RANDOM$RANDOM"
docker create --name "$helper" -v "$volume:/data" --entrypoint sh "$image" -c 'find /data -mindepth 1 -delete && tar xzf /tmp/backend_data.tar.gz -C /data' >/dev/null
docker cp "$tarball" "$helper:/tmp/backend_data.tar.gz"
docker start -a "$helper" >/dev/null

if [[ "$NO_START" -eq 1 ]]; then
  echo "4/4 -n: la pila queda con solo Postgres. Levantala con: docker compose up -d"
else
  echo "4/4 levantando la pila..."
  "${compose[@]}" up -d --wait
fi

echo
echo "Restauración completa. Verificá con: scripts/check-consistency.sh -v"
