#!/usr/bin/env bash
# Pila AISLADA de pruebas de MVP 3.1 (M3.1-S10): `docker compose -p vectorify-s10` con puertos 32xxx. NUNCA toca el proyecto compose `vectify` del usuario
# (5080/5173/5432) ni sus volúmenes. Reproduce exactamente lo que usó el gate de docs/MVP31_RELEASE.md.
#
# Uso:  tests/e2e/mvp31_stack.sh up          # Authenticated + Mailpit + tiempos de sesión CORTOS (ver abajo) + límites de login/registro altos
#       tests/e2e/mvp31_stack.sh up-dev      # Development (sin login), conservando volúmenes si ya existen (para el escenario de datos legados)
#       tests/e2e/mvp31_stack.sh down        # down -v --rmi local: borra contenedores, volúmenes e imágenes de ESTE proyecto
#       tests/e2e/mvp31_stack.sh stop        # down SIN -v (conserva los volúmenes: Development -> Authenticated con los mismos datos)
#       tests/e2e/mvp31_stack.sh leftovers   # lista lo que queda de vectorify-s10-* (debe estar vacío tras `down`)
#       tests/e2e/mvp31_stack.sh env         # imprime las variables (para `eval` o para copiarlas)
#
# Tiempos de sesión de la pila de prueba (el E2E los lee de E2E_COOKIE_LIFETIME_SECONDS, etc.; ver tests/README.md):
#   Auth__Cookie__Lifetime=20 s · Auth__Cookie__RememberMeLifetime=45 s · Auth__Session__RevalidationInterval=3 s (ventana de revocación) · ClockSkew=5 s.
set -uo pipefail
export MSYS_NO_PATHCONV=1

PROJECT="${S10_PROJECT:-vectorify-s10}"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

common_env() {
  export BACKEND_PORT=32080 FRONTEND_PORT=32173 POSTGRES_PORT=32432 PYTHON_PORT=32001 MAILPIT_UI_PORT=32025 MAILPIT_SMTP_PORT=32125
  export VITE_API_BASE_URL=http://localhost:32080 API_ORIGIN=http://localhost:32080 CORS_ALLOWED_ORIGINS=http://localhost:32173
}

auth_env() {
  common_env
  export AUTH_MODE=Authenticated
  export AUTH_EMAIL_MODE=Smtp AUTH_EMAIL_SMTP_HOST=mailpit AUTH_EMAIL_SMTP_PORT=1025 AUTH_EMAIL_SMTP_SECURITY=None
  export AUTH_EMAIL_FROM_ADDRESS=no-reply@example.test AUTH_EMAIL_PUBLIC_BASE_URL=http://localhost:32173
  export AUTH_COOKIE_LIFETIME=00:00:20 AUTH_COOKIE_REMEMBER_ME_LIFETIME=00:00:45 AUTH_SESSION_REVALIDATION_INTERVAL=00:00:03 AUTH_SESSION_CLOCK_SKEW=00:00:05
  # El E2E registra decenas de cuentas desde UNA sola IP: se suben los topes de IP/dirección de login y registro (los límites reales se prueban en dotnet test).
  export AUTH_RATE_LIMIT_LOGIN_IP_PERMIT_LIMIT=100000 AUTH_RATE_LIMIT_LOGIN_ADDRESS_PERMIT_LIMIT=100000
  export AUTH_RATE_LIMIT_REGISTER_IP_PERMIT_LIMIT=100000 AUTH_RATE_LIMIT_REGISTER_ADDRESS_PERMIT_LIMIT=100000
  export AUTH_RATE_LIMIT_IP_PERMIT_LIMIT=100000
}

wait_http() {
  local url="$1" tries=${2:-90}
  for ((i = 0; i < tries; i++)); do
    if curl -fsS -m 5 -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 2
  done
  echo "Tiempo agotado esperando $url" >&2
  return 1
}

case "${1:-}" in
  up)
    auth_env
    docker compose -p "$PROJECT" --profile mail-sink up -d --build || exit 1
    wait_http http://127.0.0.1:32080/health && wait_http http://127.0.0.1:32173/ && wait_http http://127.0.0.1:32025/api/v1/info
    ;;
  up-dev)
    common_env
    docker compose -p "$PROJECT" up -d --build || exit 1
    wait_http http://127.0.0.1:32080/health && wait_http http://127.0.0.1:32173/
    ;;
  stop)
    common_env
    docker compose -p "$PROJECT" --profile mail-sink down
    ;;
  down)
    common_env
    docker compose -p "$PROJECT" --profile mail-sink down -v --rmi local
    ;;
  leftovers)
    echo "--- contenedores"; docker ps -a --format '{{.Names}}' | grep -E "^${PROJECT}[-_]" || true
    echo "--- volúmenes";    docker volume ls --format '{{.Name}}' | grep -E "^${PROJECT}_" || true
    echo "--- imágenes";     docker images --format '{{.Repository}}:{{.Tag}}' | grep -E "^${PROJECT}-(backend|frontend|python-engine|mailpit|postgres)" || true
    echo "--- redes";        docker network ls --format '{{.Name}}' | grep -E "^${PROJECT}_" || true
    ;;
  env)
    auth_env
    env | grep -E '^(BACKEND_PORT|FRONTEND_PORT|POSTGRES_PORT|PYTHON_PORT|MAILPIT_|VITE_API|API_ORIGIN|CORS_|AUTH_)' | sort
    ;;
  *)
    sed -n '2,13p' "$0"
    exit 2
    ;;
esac
