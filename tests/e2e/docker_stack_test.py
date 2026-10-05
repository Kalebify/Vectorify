"""Build an isolated Compose stack and check health, CORS, outage and recovery.
Requires Docker Compose and Python 3. Does not automate a browser.
"""
import os
import subprocess
import time
import uuid
from urllib.request import urlopen

from real_stack_test import ROOT, free_port
from smoke_test import verify


def main():
    ports = set()
    while len(ports) < 4:
        ports.add(free_port())
    frontend_port, backend_port, python_port, postgres_port = ports
    frontend = f"http://localhost:{frontend_port}"
    backend = f"http://localhost:{backend_port}"
    python = f"http://localhost:{python_port}"
    # POSTGRES_PORT propio (desde M2.2-S01 la pila incluye Postgres): sin esto publicaría 5432 y chocaría con
    # cualquier Postgres/pila ya levantado en la máquina.
    env = dict(os.environ, FRONTEND_PORT=str(frontend_port), BACKEND_PORT=str(backend_port),
               PYTHON_PORT=str(python_port), POSTGRES_PORT=str(postgres_port), VITE_API_BASE_URL=backend,
               CORS_ALLOWED_ORIGINS=frontend, PYTHON_ENGINE_INTERNAL_URL="http://python-engine:8000",
               PYTHON_ENGINE_TIMEOUT_SECONDS="5")
    command = ["docker", "compose", "--project-name", "vectorify-check-" + uuid.uuid4().hex[:8]]

    def compose(*args):
        subprocess.run(command + list(args), cwd=ROOT, env=env, check=True)

    def wait_for(expected):
        deadline = time.monotonic() + 90
        last_error = None
        while time.monotonic() < deadline:
            try:
                verify(backend, python, expected, frontend)
                return
            except (OSError, AssertionError, ValueError, KeyError) as error:
                last_error = error
                time.sleep(1)
        raise RuntimeError(f"Stack did not reach {expected}: {last_error}")

    # Fail before any mutation if Docker is missing or unavailable.
    compose("version")
    try:
        compose("up", "--build", "--detach")
        wait_for("online")
        with urlopen(frontend, timeout=15) as response:
            assert response.status == 200
            assert 'id="root"' in response.read().decode(), "Frontend HTML missing"
        compose("stop", "python-engine")
        wait_for("unavailable")
        compose("start", "python-engine")
        wait_for("online")
        print("OK: Compose build, frontend HTTP, API, CORS y recuperación. UI pendiente de revisión visual.")
    finally:
        # -v: borra también los volúmenes de ESTE proyecto aislado (nombre aleatorio propio); sin él cada corrida
        # dejaba vectorify-check-*_vectorify_postgres_data/backend_data huérfanos desde que existe la persistencia.
        compose("down", "-v", "--remove-orphans")


if __name__ == "__main__":
    main()
