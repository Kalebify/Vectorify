"""E2E vivo de persistencia contra la pila Docker REAL (M2.2-S10): reinicio real y backup/restore.

Levanta un proyecto Compose AISLADO (nombre y puertos propios, no toca la pila del desarrollador) y recorre:
  up --build -> crear/guardar un proyecto por HTTP (upload -> paleta -> capas -> mm -> operaciones -> Save)
  -> `docker compose down` (SIN -v: conserva los volúmenes) -> `up` -> el proyecto sigue en GET /api/v2/projects y
  GET /document + cada SVG + original + thumbnail devuelven los MISMOS bytes -> editar (PATCH), autoguardar
  (idempotencyKey + replay), versiones, restaurar V1 -> verificador de consistencia dentro del contenedor.
Con --backup-cycle añade el ciclo REAL de scripts/backup.* -> `down -v` (destruye los volúmenes de ESE proyecto)
-> scripts/restore.* -> el proyecto se reabre idéntico.

Requiere Docker Compose y acceso a las imágenes/paquetes durante el build; usa solo la biblioteca estándar de
Python 3. NO automatiza un navegador. Fuera de la suite por defecto (tarda minutos): correr a mano.

    python tests/e2e/docker_persistence_test.py [--backup-cycle] [--shell powershell|bash] [--project-name NOMBRE]

Seguridad: el único `down -v` que ejecuta es sobre el proyecto Compose que ELLA misma creó (nombre
vectorify-s10-e2e-<hex> salvo --project-name); nunca usa `docker system prune` ni `volume prune`.
"""
import argparse
import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import time
import uuid
import zlib
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from real_stack_test import ROOT, free_port


# ----------------------------------------------------------------------------- imagen de prueba (PNG sin dependencias)

def solid_png(width, height, rectangles):
    """PNG RGB: fondo blanco con rectángulos de color sólido [(x0, y0, x1, y1, (r, g, b)), ...]."""
    rows = []
    for y in range(height):
        row = bytearray(b"\x00")  # filtro 0
        for x in range(width):
            color = (255, 255, 255)
            for x0, y0, x1, y1, rgb in rectangles:
                if x0 <= x < x1 and y0 <= y < y1:
                    color = rgb
            row += bytes(color)
        rows.append(bytes(row))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


TEST_IMAGE = solid_png(240, 160, [
    (20, 30, 90, 110, (255, 0, 0)),
    (100, 30, 170, 110, (0, 200, 0)),
    (180, 60, 225, 140, (0, 0, 255)),
])


# ----------------------------------------------------------------------------- cliente HTTP mínimo

class Api:
    def __init__(self, base):
        self.base = base.rstrip("/")

    def raw(self, method, path, body=None, headers=None, timeout=120):
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        request = Request(self.base + path, data=data, method=method, headers=headers or {})
        if isinstance(body, (dict, list)):
            request.add_header("Content-Type", "application/json")
        try:
            with urlopen(request, timeout=timeout) as response:
                return response.status, response.read()
        except HTTPError as error:
            return error.code, error.read()

    def json(self, method, path, body=None, expect=(200, 201)):
        status, payload = self.raw(method, path, body)
        assert status in expect, f"{method} {path} -> HTTP {status}: {payload[:300]!r}"
        return json.loads(payload) if payload else None

    def bytes(self, path):
        status, payload = self.raw("GET", path)
        return payload if status == 200 else None


def multipart_png(png):
    boundary = "----vectorify" + uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"tres-colores.png\"\r\n"
            f"Content-Type: image/png\r\n\r\n").encode() + png + f"\r\n--{boundary}--\r\n".encode()
    return body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def sha(payload):
    return None if payload is None else f"{len(payload)} bytes sha256 {hashlib.sha256(payload).hexdigest()[:12]}"


# ----------------------------------------------------------------------------- flujo de producto

def create_and_save(api):
    """upload -> detect -> confirm -> layers -> mm -> operaciones -> Save. Devuelve ids del proyecto v2 y del triple clásico."""
    body, headers = multipart_png(TEST_IMAGE)
    status, payload = api.raw("POST", "/api/v1/projects", body, headers)
    assert status == 201, f"upload -> HTTP {status}: {payload[:300]!r}"
    upload = json.loads(payload)
    root = f"/api/v1/projects/{upload['projectId']}/images/{upload['imageId']}"

    palette = api.json("POST", f"{root}/color-palette/detect", {})
    print(f"  paleta detectada: {[g['colorHex'] for g in palette['groups']]}")
    api.json("POST", f"{root}/color-palette/{palette['paletteId']}/confirm")
    layer_set = api.json("POST", f"{root}/color-palette/{palette['paletteId']}/layers")
    layers = layer_set["layers"]
    assert len(layers) >= 2, f"se esperaban al menos 2 capas, hay {len(layers)}"

    dimension = api.json("POST", f"{root}/dimensions/apply",
                         {"sourceKind": "vector", "sourceId": layers[0]["vectorId"], "widthMm": 100, "heightMm": None, "lockAspectRatio": True})
    for layer, operation in zip(layers, ["cut", "engrave", "ignore"] * 3):
        api.json("POST", f"{root}/color-palette/{palette['paletteId']}/layers/{layer['groupId']}/operation", {"operation": operation})

    save = api.json("POST", "/api/v2/workspaces/save", {
        "projectId": None, "name": "E2E persistencia", "classicProjectId": upload["projectId"], "imageId": upload["imageId"],
        "paletteId": palette["paletteId"], "paletteVersion": palette["version"], "dimensionId": dimension["dimensionId"],
        "idempotencyKey": uuid.uuid4().hex}, expect=(201,))
    return {"project": save["projectId"], "classic": upload["projectId"], "image": upload["imageId"],
            "palette": palette["paletteId"], "paletteVersion": palette["version"], "dimension": dimension["dimensionId"]}


def snapshot(api, ids, version=None):
    """Todo lo que el usuario ve al reabrir, a nivel de valores (documento) y de bytes (SVG, original, thumbnail)."""
    path = f"/api/v2/projects/{ids['project']}/" + ("document" if version is None else f"versions/{version}")
    document = api.json("GET", path)
    listing = api.json("GET", "/api/v2/projects")
    item = next((i for i in listing["items"] if i["id"] == ids["project"]), None)
    versions = api.json("GET", f"/api/v2/projects/{ids['project']}/versions")
    layers = [{k: layer[k] for k in ("id", "name", "order", "visible", "locked", "manufacturingOperation", "colorHex", "coverage", "isBackground", "pathCount")}
              for layer in document["layers"]]
    return {
        "versionNumber": document["versionNumber"],
        "widthMm": document["widthMm"], "heightMm": document["heightMm"], "viewBox": document["viewBox"], "schemaVersion": document["schemaVersion"],
        "layers": layers,
        "svgs": {layer["id"]: sha(api.bytes(layer["svgUrl"])) for layer in document["layers"]},
        "original": sha(api.bytes(f"/api/v1/projects/{ids['classic']}/images/{ids['image']}/original")),
        "thumbnail": sha(api.bytes(item["thumbnailUrl"])) if item and item["thumbnailUrl"] else None,
        "listed": None if item is None else {"name": item["name"], "layerCount": item["layerCount"]},
        "versions": [v["versionNumber"] for v in versions],
    }


def assert_same(stage, expected, actual, ignore=()):
    diffs = []
    for key in expected:
        if key in ignore:
            continue
        if expected[key] != actual.get(key):
            diffs.append(f" - {key}: antes {expected[key]!r}, ahora {actual.get(key)!r}")
    assert not diffs, f"PÉRDIDA O CAMBIO SILENCIOSO en «{stage}»:\n" + "\n".join(diffs)
    for svg_id, value in expected["svgs"].items():
        assert value is not None, f"{stage}: el SVG de la capa {svg_id} no se pudo descargar antes de comparar"
    print(f"  OK {stage}: {len(expected['layers'])} capas, {len(expected['svgs'])} SVG, original y thumbnail idénticos byte a byte.")


# ----------------------------------------------------------------------------- orquestación Docker

class Stack:
    def __init__(self, name):
        ports = set()
        while len(ports) < 4:
            ports.add(free_port())
        frontend, backend, python, postgres = ports
        self.name = name
        self.backend_url = f"http://localhost:{backend}"
        self.env = dict(os.environ, FRONTEND_PORT=str(frontend), BACKEND_PORT=str(backend), PYTHON_PORT=str(python),
                        POSTGRES_PORT=str(postgres), VITE_API_BASE_URL=self.backend_url, CORS_ALLOWED_ORIGINS=f"http://localhost:{frontend}",
                        PYTHON_ENGINE_INTERNAL_URL="http://python-engine:8000", PYTHON_ENGINE_TIMEOUT_SECONDS="5",
                        COMPOSE_PROJECT_NAME=name)
        self.command = ["docker", "compose", "--project-name", name]
        self.api = Api(self.backend_url)

    def compose(self, *args, check=True, capture=False):
        result = subprocess.run(self.command + list(args), cwd=ROOT, env=self.env, check=check,
                                capture_output=capture, text=True, encoding="utf-8", errors="replace")
        return result

    def container_id(self, service):
        return self.compose("ps", "-q", service, capture=True).stdout.strip()

    def volumes(self):
        out = subprocess.run(["docker", "volume", "ls", "-q", "--filter", f"label=com.docker.compose.project={self.name}"],
                             capture_output=True, text=True, check=True, encoding="utf-8").stdout.split()
        return sorted(out)

    def wait_online(self, timeout=150):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            try:
                status, payload = self.api.raw("GET", "/api/v1/system/health", timeout=10)
                body = json.loads(payload)
                if status == 200 and body["status"] == "online" and body["database"]["status"] == "online":
                    return body
                last = body
            except (OSError, URLError, ValueError, KeyError) as error:
                last = error
            time.sleep(1)
        raise RuntimeError(f"La pila no llegó a 'online' en {timeout}s: {last}")

    def run_script(self, shell, name, *args):
        scripts = ROOT / "scripts"
        if shell == "powershell":
            command = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(scripts / f"{name}.ps1")] + list(args)
        else:
            command = ["bash", str(scripts / f"{name}.sh")] + list(args)
        print("  $ " + " ".join(command))
        return subprocess.run(command, cwd=ROOT, env=self.env, capture_output=True, text=True, encoding="utf-8", errors="replace")

    def consistency_check(self):
        result = self.compose("exec", "-T", "backend", "dotnet", "Vectorify.Api.dll", "--check-consistency", "--verify-checksums",
                              check=False, capture=True)
        print("  " + result.stdout.strip().replace("\n", "\n  "))
        assert result.returncode == 0, f"el verificador de consistencia devolvió {result.returncode}: {result.stderr[-300:]}"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--backup-cycle", action="store_true", help="añade backup -> down -v -> restore -> reabrir")
    parser.add_argument("--shell", choices=["powershell", "bash"], default="powershell" if os.name == "nt" else "bash",
                        help="qué variante de scripts/backup|restore usar en --backup-cycle")
    parser.add_argument("--project-name", default="vectorify-s10-e2e-" + uuid.uuid4().hex[:6])
    args = parser.parse_args()
    assert re.fullmatch(r"[a-z0-9][a-z0-9_-]*", args.project_name), "nombre de proyecto compose inválido"

    stack = Stack(args.project_name)
    api = stack.api
    print(f"Proyecto Compose aislado: {stack.name} (backend {stack.backend_url})")
    stack.compose("version")  # falla ANTES de mutar nada si Docker no está disponible
    try:
        print("[1/6] docker compose up --build -d")
        stack.compose("up", "--build", "--detach")
        stack.wait_online()

        print("[2/6] crear y guardar un proyecto por HTTP")
        ids = create_and_save(api)
        saved = snapshot(api, ids)
        assert saved["versionNumber"] == 1 and saved["versions"] == [1]
        assert saved["widthMm"] == 100, saved["widthMm"]
        assert {l["manufacturingOperation"] for l in saved["layers"]} >= {"cut", "engrave"}
        assert saved["thumbnail"] is not None, "el primer Save debe haber generado el thumbnail"
        print(f"  proyecto {ids['project']} guardado: V1, {len(saved['layers'])} capas, {saved['widthMm']} x {saved['heightMm']} mm")

        print("[3/6] docker compose down (SIN -v) -> up: reinicio real conservando volúmenes")
        before_ids = {s: stack.container_id(s) for s in ("backend", "postgres")}
        volumes_before = stack.volumes()
        assert len(volumes_before) == 2, volumes_before
        stack.compose("down", "--remove-orphans")
        assert stack.container_id("backend") == "" and stack.container_id("postgres") == "", "los contenedores deberían haber desaparecido"
        assert stack.volumes() == volumes_before, "`down` sin -v NO debe borrar volúmenes"
        stack.compose("up", "--detach")
        stack.wait_online()
        after_ids = {s: stack.container_id(s) for s in ("backend", "postgres")}
        assert all(before_ids[s] != after_ids[s] for s in before_ids), "los contenedores no se recrearon: no hubo reinicio real"
        reopened = snapshot(api, ids)
        assert_same("Open tras down/up (volúmenes conservados)", saved, reopened)

        print("[4/6] editar (PATCH), autoguardar (idempotencyKey + replay), versiones, restaurar V1")
        layer0, layer1 = saved["layers"][0]["id"], saved["layers"][1]["id"]
        api.json("PATCH", f"/api/v2/projects/{ids['project']}/layers/{layer0}",
                 {"name": "Contorno exterior", "order": 5, "visible": False, "locked": True, "manufacturingOperation": "engrave"})
        key = uuid.uuid4().hex
        save_body = {"projectId": ids["project"], "name": None, "classicProjectId": ids["classic"], "imageId": ids["image"],
                     "paletteId": ids["palette"], "paletteVersion": ids["paletteVersion"], "dimensionId": ids["dimension"], "idempotencyKey": key}
        first = api.json("POST", "/api/v2/workspaces/save", save_body, expect=(200,))
        replay = api.json("POST", "/api/v2/workspaces/save", save_body, expect=(200,))
        assert first["versionNumber"] == replay["versionNumber"] == 3, (first, replay)
        edited = snapshot(api, ids)
        assert edited["versions"] == [3, 2, 1], edited["versions"]
        patched = next(l for l in edited["layers"] if l["id"] == layer0)
        assert (patched["name"], patched["visible"], patched["locked"], patched["manufacturingOperation"]) == ("Contorno exterior", False, True, "engrave"), patched
        assert edited["svgs"] == saved["svgs"], "editar/autoguardar no debe alterar los bytes de ningún SVG"
        restored = api.json("POST", f"/api/v2/projects/{ids['project']}/versions/1/restore", expect=(200,))
        assert restored["versionNumber"] == 4, restored
        after_restore = snapshot(api, ids)
        assert_same("Restore de V1", saved, after_restore, ignore=("versionNumber", "versions"))
        assert after_restore["versionNumber"] == 4 and after_restore["versions"] == [4, 3, 2, 1], after_restore["versions"]
        assert_same("V1 histórica intacta", saved, snapshot(api, ids, version=1), ignore=("versions",))

        print("[5/6] verificador de consistencia DB <-> storage dentro del contenedor")
        stack.consistency_check()

        if args.backup_cycle:
            print(f"[6/6] ciclo REAL de backup -> down -v -> restore ({args.shell})")
            backup_root = tempfile.mkdtemp(prefix="vectorify-s10-backups-")
            backup_args = ["-OutDir", backup_root, "-ProjectName", stack.name] if args.shell == "powershell" else ["-o", backup_root, "-p", stack.name]
            result = stack.run_script(args.shell, "backup", *backup_args)
            print(result.stdout)
            assert result.returncode == 0, f"backup falló ({result.returncode}): {result.stderr[-600:]}"
            backup_dir = max(Path(backup_root).glob("vectorify-backup-*"), key=lambda p: p.name)
            assert (backup_dir / "db.dump").stat().st_size > 0 and (backup_dir / "backend_data.tar.gz").stat().st_size > 0

            # Seguridad: este `down -v` borra los volúmenes SOLO del proyecto Compose creado por este mismo script.
            stack.compose("down", "-v", "--remove-orphans")
            assert stack.volumes() == [], f"`down -v` debía destruir los volúmenes: {stack.volumes()}"
            print("  volúmenes destruidos; restaurando...")

            restore_args = (["-BackupDir", str(backup_dir), "-ProjectName", stack.name, "-Force"] if args.shell == "powershell"
                            else ["-b", str(backup_dir), "-p", stack.name, "-f"])
            result = stack.run_script(args.shell, "restore", *restore_args)
            print(result.stdout)
            assert result.returncode == 0, f"restore falló ({result.returncode}): {result.stderr[-600:]}"
            stack.wait_online()
            recovered = snapshot(api, ids)
            assert_same("Reabrir tras backup -> down -v -> restore", after_restore, recovered)
            stack.consistency_check()
        else:
            print("[6/6] (omitido) ciclo de backup/restore: usar --backup-cycle")

        print("OK: persistencia verificada contra la pila Docker real (reinicio con volúmenes"
              + (" + backup/restore tras destruirlos)." if args.backup_cycle else ")."))
    finally:
        # Limpieza: solo el proyecto Compose propio, volúmenes incluidos.
        stack.compose("down", "-v", "--remove-orphans", check=False)


if __name__ == "__main__":
    main()
