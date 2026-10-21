#!/usr/bin/env bash
# Reasigna los datos LEGADOS (proyectos del usuario de desarrollo y registros clásicos sin dueño) a UNA cuenta real existente (M3.1-S10, ADR P10).
#
# Uso:   scripts/reassign-legacy-data.sh -e correo@ejemplo.com [-p NOMBRE_PROYECTO_COMPOSE] [-a] [-y]
#          -e  correo de la cuenta DESTINO (debe estar registrada y haber iniciado sesión al menos una vez)
#          -a  APLICAR. Sin -a es un DRY-RUN: solo informa qué cambiaría y no escribe nada (puede correr con la API arriba)
#          -y  no pedir la confirmación interactiva al aplicar
# Envuelve `dotnet Vectorify.Api.dll --reassign-legacy-data` (ver backend/Vectorify.Api/Maintenance/ReassignLegacyDataCommand.cs). Con -a:
#   1) pide confirmar que hay COPIA DE SEGURIDAD (scripts/backup.sh) — nada se aplica sin ella;
#   2) PARA el backend (guarda los registros clásicos en memoria; si siguiera arriba, los vería con el dueño anterior);
#   3) corre el comando en un contenedor efímero con los mismos volúmenes y la misma base; 4) vuelve a ARRANCAR el backend.
# Es idempotente. Código de salida: 0 correcto, 1 aplicado a medias (repetir), 2 no se pudo. NUNCA la ejecute contra datos reales sin decidir a quién se asignan:
# el destino es una decisión de producto (docs/MVP31_RELEASE.md). Equivalente de scripts/reassign-legacy-data.ps1.
set -uo pipefail

export MSYS_NO_PATHCONV=1

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
TARGET=""
APPLY=0
YES=0
while getopts "e:p:ayh" opt; do
  case "$opt" in
    e) TARGET="$OPTARG" ;;
    p) PROJECT_NAME="$OPTARG" ;;
    a) APPLY=1 ;;
    y) YES=1 ;;
    *) sed -n '2,13p' "$0"; exit 2 ;;
  esac
done
if [[ -z "$TARGET" ]]; then
  echo "Falta -e <correo de la cuenta destino>." >&2
  sed -n '2,13p' "$0" >&2
  exit 2
fi

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose=(docker compose)
[[ -n "$PROJECT_NAME" ]] && compose+=(-p "$PROJECT_NAME")

if [[ $APPLY -eq 0 ]]; then
  exec "${compose[@]}" exec -T backend dotnet Vectorify.Api.dll --reassign-legacy-data "--target-email=$TARGET"
fi

echo "Se van a REASIGNAR datos legados a la cuenta indicada en el proyecto compose '${PROJECT_NAME:-<por defecto>}'."
echo "Antes: 1) ¿hiciste una COPIA DE SEGURIDAD (scripts/backup.sh)? 2) ¿corriste primero el DRY-RUN (sin -a) y revisaste la lista?"
if [[ $YES -eq 0 ]]; then
  read -r -p 'Escribí SI para continuar: ' answer
  if [[ "$answer" != "SI" ]]; then
    echo "Cancelado: no se cambió nada."
    exit 2
  fi
fi

restart_backend() { echo "Arrancando el backend..."; "${compose[@]}" start backend >/dev/null; }
echo "Parando el backend (sus registros clásicos en memoria quedarían obsoletos)..."
"${compose[@]}" stop backend >/dev/null || { echo "No se pudo parar el backend." >&2; exit 2; }
trap restart_backend EXIT

"${compose[@]}" run --rm --no-deps -T backend dotnet Vectorify.Api.dll --reassign-legacy-data "--target-email=$TARGET" --apply
code=$?
exit $code
