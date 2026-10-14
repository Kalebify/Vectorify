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

S13 (Autosave + Version History) mergeada en `main` (PR #60).

## Decisiones clave

- **Geometría pesada en Python/Shapely** (S04): el frontend manda anillos de polígonos, no paths SVG.
- **EditorCommand v1** (S12): descripción declarativa sin SVG; el parche `EditorEdit` sigue siendo la fuente de reversión. Ejecutor preparado para MVP 4 (IA).
- **Persistencia de geometría** (S13): `POST /api/v2/projects/{id}/document/editor-save` crea una `DocumentVersion` por guardado. `geometryDirty` ahora
  significa "difiere de lo último que el servidor confirmó" (`saveMark`/`markSaved`); el undo no se reinicia al guardar, solo al restaurar una versión.
  Con un proyecto ya guardado, SAVE es siempre un checkpoint del editor (el save clásico pisaría la geometría). Detalle en `docs/ADR_EDITOR_MVP3.md` (D5).

## Problemas abiertos

- **Docker Desktop no arranca** (WSL1 incompatible, 2026-10-14): `dotnet test` con Testcontainers no corre. Los 26 casos E2E nuevos de `editor-save`
  (en `VectorDocumentEndpointsTests`) compilan pero **no se han ejecutado**. Correrlos cuando vuelva Docker.
- `dotnet build` falló intermitentemente por lock de OneDrive (`CoreGenerateAssemblyInfo`) en sesiones anteriores; hoy compiló bien.
- El contrato de `editor-save` no lleva `baseVersion`: solo detecta escrituras simultáneas (409 por `xmin`), no "otra pestaña guardó antes".
- El listado de versiones no expone el nº de capas (el endpoint es de M2.2-S06 y el spec de S13 prohíbe tocarlo): el panel muestra el tamaño en mm.

## En curso

**S14 · Laser Checker integrado** — rama `sprint/3e8d77b2-m3-s14-laser-checker-editor`: implementado y verificado localmente; falta PR → merge → Notion.

## Siguiente paso

Cerrar S14 y seguir con S15 (export avanzado) y S16 (E2E + release candidate).
