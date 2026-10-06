# IMPL-fix-round-1.md — M2.2-S10 · ronda de corrección 1

## Defecto reportado por QA (comentario en Notion, tarjeta en Bloqueado)

`scripts/backup.ps1` terminó con "Get-FileHash no se reconoce" al generar `manifest.txt`, así que el ciclo
obligatorio backup → `down -v` → restore no pudo verificarse. El resto del E2E (guardado, reinicio,
restauración de versión, consistencia DB/storage) y las 32 pruebas .NET focalizadas pasaron.

## Causa

El script calculaba el SHA-256 del manifiesto con `Get-FileHash`, un cmdlet que solo existe desde
PowerShell 4 y que no está en todos los hosts. Un host sin él rompe el manifiesto.

## Honestidad sobre la reproducción

**No pude reproducir el fallo exacto en el equipo del orquestador**: aquí `Get-FileHash` existe y mis
simulaciones de un host sin el cmdlet (función sombra, comando privado) no lo ocultaron. Lo que sí se
demostró en rojo es el defecto de diseño que lo causa: el script depende de ese cmdlet. El nuevo test
`tests/scripts/test_backup_script_portability.py` falla contra el `backup.ps1` original (2 de 2 rojos:
detecta `Get-FileHash` en la línea 94 y la ausencia del helper) y pasa con el arreglo.

## Arreglo

- `scripts/backup.ps1`: nuevo helper `Get-Sha256Hex` con .NET puro
  (`System.Security.Cryptography.SHA256` sobre un `FileStream`), usado para el manifiesto. Es el único
  uso de `Get-FileHash` en `scripts/*.ps1` (revisados también `restore.ps1` y `check-consistency.ps1`:
  el resto de los cmdlets, p. ej. `ConvertFrom-Json`, existen desde PowerShell 3).
- `tests/scripts/test_backup_script_portability.py` (stdlib, sin Docker): (1) ningún `.ps1` depende de
  `Get-FileHash`; (2) el helper produce el mismo hash que `hashlib` sobre un binario de 1 MiB.
- `tests/README.md`: documentado el nuevo test y cómo correrlo.

## Verificación (corrida por el orquestador)

- `python -m unittest discover -s tests/scripts -v`: rojo (2 fallos) contra el script original, verde (2/2)
  con el arreglo.
- **E2E vivo completo repetido** (`docker_persistence_test.py --backup-cycle --shell powershell`): ciclo
  real backup → `down -v` → restore → reabrir idéntico byte a byte (4 capas, 4 SVG, original y
  thumbnail); verificador de consistencia "consistente" (9 assets / 9 archivos, checksums OK); sin
  volúmenes de prueba residuales.
- No se re-corrieron `dotnet test`, `npm test` ni `pytest`: esta ronda no toca código que esas suites
  cubran (solo `scripts/backup.ps1`, un test Python nuevo y documentación). La variante `--shell bash`
  tampoco se repitió: `backup.sh` usa `sha256sum` y no cambió.
