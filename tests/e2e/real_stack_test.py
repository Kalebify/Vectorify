"""Start real ASP.NET Core and FastAPI; verify online -> offline -> recovered.
Requires a built Debug backend and Python requirements-dev installed.
Processes run on temporary loopback ports and are always cleaned up.
"""
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError

from smoke_test import read_json, verify

ROOT = Path(__file__).resolve().parents[2]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def start(command, cwd, env, log):
    return subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=log,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)


def stop(process):
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def ready(process, url):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Service exited: {process.returncode}")
        try:
            if read_json(url)["status"] == "ok":
                return
        except (URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(0.2)
    raise TimeoutError(url)


def main():
    python_port, api_port = free_port(), free_port()
    while api_port == python_port:
        api_port = free_port()
    python_url, api_url = f"http://127.0.0.1:{python_port}", f"http://127.0.0.1:{api_port}"
    origin = "http://localhost:5173"
    env = dict(os.environ, PythonEngine__BaseUrl=python_url, PythonEngine__TimeoutSeconds="5",
               Cors__AllowedOrigins=origin, ASPNETCORE_ENVIRONMENT="Development",
               ASPNETCORE_URLS=api_url, SERVICE_NAME="vectorify-integration-engine", SERVICE_VERSION="integration-1")
    engine_cmd = [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(python_port)]
    engine = api = None
    with tempfile.TemporaryFile(mode="w+b") as log:
        try:
            engine = start(engine_cmd, ROOT / "services/python-engine", env, log)
            ready(engine, python_url + "/health")
            api = start(["dotnet", str(ROOT / "backend/Vectorify.Api/bin/Debug/net10.0/Vectorify.Api.dll")], ROOT / "backend/Vectorify.Api", env, log)
            ready(api, api_url + "/health")
            verify(api_url, python_url, origin=origin)
            body = read_json(api_url + "/api/v1/system/health")
            assert body["python"]["service"] == "vectorify-integration-engine"
            assert body["python"]["version"] == "integration-1"
            stop(engine)
            verify(api_url, python_url, "unavailable", origin)
            engine = start(engine_cmd, ROOT / "services/python-engine", env, log)
            ready(engine, python_url + "/health")
            verify(api_url, python_url, origin=origin)
            print("OK: FastAPI real recuperado sin reiniciar ASP.NET Core.")
        except Exception:
            log.seek(0)
            print(log.read().decode(errors="replace"), file=sys.stderr)
            raise
        finally:
            stop(engine)
            stop(api)


if __name__ == "__main__":
    main()
