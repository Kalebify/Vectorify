#!/usr/bin/env bash
# Verifica en SOLO LECTURA que los Assets de la base y los archivos del storage de la pila Docker se correspondan.
#
# Uso:   scripts/check-consistency.sh [-p NOMBRE_PROYECTO_COMPOSE] [-v] [-d]
#          -v  verificar checksums (lee todos los archivos; detecta bytes alterados)
#          -d  BORRAR los archivos huérfanos con más de 10 minutos (nunca filas; hacelo con la API sin tráfico)
# Envuelve `dotnet Vectorify.Api.dll --check-consistency` dentro del contenedor del backend. Equivalente de
# scripts/check-consistency.ps1. Código de salida: 0 consistente, 1 hay inconsistencias, 2 no se pudo verificar.
set -uo pipefail

export MSYS_NO_PATHCONV=1

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
args=(--check-consistency)
while getopts "p:vdh" opt; do
  case "$opt" in
    p) PROJECT_NAME="$OPTARG" ;;
    v) args+=(--verify-checksums) ;;
    d) args+=(--delete-orphan-files) ;;
    *) sed -n '2,8p' "$0"; exit 1 ;;
  esac
done

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose=(docker compose)
[[ -n "$PROJECT_NAME" ]] && compose+=(-p "$PROJECT_NAME")

exec "${compose[@]}" exec -T backend dotnet Vectorify.Api.dll "${args[@]}"
