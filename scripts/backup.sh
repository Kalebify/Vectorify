#!/usr/bin/env bash
# Respalda la pila Docker Compose de Vectorify (dev/staging): Postgres + volumen App_Data.
#
# Uso:   scripts/backup.sh [-o CARPETA_DESTINO] [-p NOMBRE_PROYECTO_COMPOSE]
# Genera <destino>/vectorify-backup-<fecha>/ con db.dump (pg_dump -Fc), backend_data.tar.gz (volumen
# vectorify_backend_data = /app/App_Data) y manifest.txt (conteos y SHA-256). NO destructivo: solo lee y nunca pisa un
# respaldo anterior. Requiere Postgres corriendo. Equivalente de scripts/backup.ps1 (ver docs/BACKUP_RESTORE.md).
# El dump va ANTES que el tar a propósito: un archivo guardado entre medio queda como huérfano inofensivo, nunca como
# fila sin archivo. Si la pila usa puertos/variables propios (POSTGRES_PORT, BACKEND_PORT...), exportalos al correr.
set -euo pipefail

# Git Bash/MSYS (Windows) reescribe argumentos que parecen rutas (/tmp/...) y rompe `docker cp`/`docker exec`.
export MSYS_NO_PATHCONV=1

OUT_DIR="$(pwd)/backups"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
while getopts "o:p:h" opt; do
  case "$opt" in
    o) OUT_DIR="$OPTARG" ;;
    p) PROJECT_NAME="$OPTARG" ;;
    *) sed -n '2,10p' "$0"; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
compose=(docker compose)
[[ -n "$PROJECT_NAME" ]] && compose+=(-p "$PROJECT_NAME")

postgres_container="$("${compose[@]}" ps --status running -q postgres | head -n1)"
if [[ -z "$postgres_container" ]]; then
  echo "Postgres no está corriendo en el proyecto compose '${PROJECT_NAME}'. Levantá la pila (docker compose up -d) y reintentá." >&2
  exit 1
fi
resolved_project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$postgres_container")"
image="$(docker inspect -f '{{ .Config.Image }}' "$postgres_container")"
volume="$(docker volume ls -q --filter "label=com.docker.compose.project=$resolved_project" --filter 'label=com.docker.compose.volume=vectorify_backend_data' | head -n1)"
if [[ -z "$volume" ]]; then
  echo "No se encontró el volumen vectorify_backend_data del proyecto '$resolved_project'." >&2
  exit 1
fi

stamp="$(date +%Y%m%d-%H%M%S)"
target="$OUT_DIR/vectorify-backup-$stamp"
if [[ -e "$target" ]]; then
  echo "Ya existe $target; no se pisan respaldos. Reintentá en un segundo." >&2
  exit 1
fi
mkdir -p "$target"
target="$(cd "$target" && { pwd -W 2>/dev/null || pwd; })"  # pwd -W: ruta Windows en Git Bash (docker.exe no entiende /tmp/...)

helper=""
cleanup() { [[ -n "$helper" ]] && docker rm -f "$helper" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Proyecto compose : $resolved_project"
echo "Volumen de datos : $volume"
echo "Destino          : $target"

echo "1/3 pg_dump (Postgres)..."
"${compose[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/vectorify.dump'
"${compose[@]}" cp postgres:/tmp/vectorify.dump "$target/db.dump"
"${compose[@]}" exec -T postgres rm -f /tmp/vectorify.dump

echo "2/3 tar del volumen App_Data..."
helper="vectorify-backup-helper-$RANDOM$RANDOM"
docker create --name "$helper" -v "$volume:/data:ro" --entrypoint tar "$image" czf /tmp/backend_data.tar.gz -C /data . >/dev/null
docker start -a "$helper" >/dev/null
docker cp "$helper:/tmp/backend_data.tar.gz" "$target/backend_data.tar.gz"

echo "3/3 manifiesto..."
counts="$("${compose[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<'SQL'
SELECT 'projects=' || (SELECT count(*) FROM projects) || ' assets=' || (SELECT count(*) FROM assets) || ' document_versions=' || (SELECT count(*) FROM document_versions) || ' layers=' || (SELECT count(*) FROM layers) || ' migrations=' || (SELECT count(*) FROM "__EFMigrationsHistory");
SQL
)"
pg_version="$("${compose[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SHOW server_version"' | tr -d '\r')"
{
  echo "vectorify-backup creado: $(date -Iseconds)"
  echo "compose_project: $resolved_project"
  echo "postgres_version: $pg_version"
  echo "conteos: $(echo "$counts" | tr -d '\r')"
  echo "sha256:"
  for name in db.dump backend_data.tar.gz; do
    printf '%s  %s  %s bytes\n' "$(sha256sum "$target/$name" | cut -d' ' -f1)" "$name" "$(wc -c < "$target/$name" | tr -d ' ')"
  done
} > "$target/manifest.txt"

echo
echo "Respaldo completo: $target"
sed 's/^/  /' "$target/manifest.txt"
