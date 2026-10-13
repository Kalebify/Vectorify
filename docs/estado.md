# Estado del proyecto — 2026-10-14

## Qué se hizo (MVP 3)

S01–S12 mergeados en `main`:

| # | Tarjeta | PR |
|---|---------|-----|
| S01 | Undo/Redo base + snapshots before/after | #44 |
| S02 | Frame crop/rotate/flip | #45 |
| S03 | Capas isNew + metadata de capa | #46 |
| S04 | Servicio de geometría Python + booleanas base | #47 |
| S05 | Path tool | #48 |
| S06 | Clipboard | #49 |
| S07 | Color fill + recolor | #50 |
| S08 | Operaciones booleanas completas | #51 |
| S09 | Offset interior/exterior (Shapely) | #56 |
| S10 | Cut/Split (dividir + ranura) | #57 |
| S11 | Bridges + piezas flotantes | #58 |
| S12 | EditorCommand v1 + HistoryPanel + ejecutor IA | #59 |

2911 tests frontend verdes. Backend y Python sin regresiones.

## Decisiones clave

- **Geometría pesada en Python/Shapely** (S04): el frontend manda anillos de polígonos, no paths SVG.
- **EditorCommand v1** (S12): descripción declarativa sin SVG; el parche `EditorEdit` sigue siendo la fuente de reversión. Ejecutor preparado para MVP 4 (IA).
- **Persistencia diferida a S13**: hasta S13, la geometría vive solo en memoria. `geometryDirty` avisa al cerrar.
- **dotnet build falla por lock de OneDrive/MSBuild** (pre-existente, no de código). S12 y posteriores son frontend-only o se documentan si afecta al backend.

## Problemas abiertos

- `dotnet build` falla intermitentemente por lock de OneDrive (`CoreGenerateAssemblyInfo`). No bloquea el sprint; se documenta en cada IMPL.md.
- Docker Desktop puede no arrancar (WSL1 incompatible): `dotnet test` con Testcontainers falla en ese caso.

## En curso

**S13 · Autosave + Version History** — rama `sprint/3e8d77b2-m3-s13-autosave-version-history`
- Spec congelado, Notion en "Doing".
- Agente implementador activo; ya escribió los contratos del endpoint `editor-save` en el backend.
- Falta: servicio, endpoint, `useGeometrySave`, `VersionHistoryPanel`, tests, verificación final.

## Siguiente paso

Retomar S13: verificar árbol (`git status`), correr `npm test`, completar implementación si el agente no terminó, luego verificar → commit → PR → merge → Notion Done → S14 (Laser Checker).
