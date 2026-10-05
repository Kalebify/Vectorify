"""Portabilidad de scripts/*.ps1 (M2.2-S10, ronda de fix 1).

Contexto: el QA de M2.2-S10 corrió `scripts/backup.ps1` en un host de PowerShell sin `Get-FileHash` (cmdlet que
solo existe desde PowerShell 4) y el manifiesto falló con "Get-FileHash no se reconoce", dejando sin verificar el
ciclo backup -> `down -v` -> restore. Estas pruebas NO necesitan Docker:

1. ningún script .ps1 puede depender de `Get-FileHash` (el SHA-256 se calcula con .NET puro);
2. el helper `Get-Sha256Hex` de backup.ps1 produce el MISMO hash que hashlib sobre un archivo real
   (se salta si no hay PowerShell en el equipo).

Ejecutar desde la raíz del repo:  python -m unittest discover -s tests/scripts -v
"""
import hashlib
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"


def _code_lines(path: Path):
    """Líneas del script sin comentarios de línea completa (los comentarios pueden mencionar Get-FileHash)."""
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.lstrip().startswith("#"):
            yield number, line


class BackupScriptPortabilityTests(unittest.TestCase):
    def test_no_powershell_script_depends_on_get_filehash(self):
        offenders = [
            f"{script.name}:{number}: {line.strip()}"
            for script in sorted(SCRIPTS_DIR.glob("*.ps1"))
            for number, line in _code_lines(script)
            if re.search(r"\bGet-FileHash\b", line)
        ]
        self.assertEqual([], offenders, "Get-FileHash no existe en todos los hosts de PowerShell: usar .NET (SHA256).")

    def test_sha256_helper_matches_hashlib(self):
        powershell = shutil.which("powershell") or shutil.which("pwsh")
        if powershell is None:
            self.skipTest("PowerShell no disponible en este equipo")

        source = (SCRIPTS_DIR / "backup.ps1").read_text(encoding="utf-8")
        match = re.search(r"^function Get-Sha256Hex \{.*?^\}", source, flags=re.DOTALL | re.MULTILINE)
        self.assertIsNotNone(match, "backup.ps1 debe definir la función Get-Sha256Hex")

        with tempfile.TemporaryDirectory() as tmp:
            payload = bytes(range(256)) * 4096  # 1 MiB binario: detecta lecturas truncadas o conversiones de texto
            data_file = Path(tmp) / "datos.bin"
            data_file.write_bytes(payload)
            probe = Path(tmp) / "probe.ps1"
            probe.write_text(f"{match.group(0)}\nWrite-Output (Get-Sha256Hex '{data_file}')\n", encoding="utf-8")

            result = subprocess.run(
                [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(probe)],
                capture_output=True, text=True, timeout=60,
            )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(hashlib.sha256(payload).hexdigest(), result.stdout.strip())


if __name__ == "__main__":
    unittest.main()
