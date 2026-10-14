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

S13 (#60), S14 (#61) y S15 (#62) mergeadas en `main`.

## Decisiones clave

- **Geometría pesada en Python/Shapely** (S04): el frontend manda anillos de polígonos, no paths SVG.
- **EditorCommand v1** (S12): descripción declarativa sin SVG; el parche `EditorEdit` sigue siendo la fuente de reversión. Ejecutor preparado para MVP 4 (IA).
- **Persistencia de geometría** (S13): `POST /api/v2/projects/{id}/document/editor-save` crea una `DocumentVersion` por guardado. `geometryDirty` ahora
  significa "difiere de lo último que el servidor confirmó" (`saveMark`/`markSaved`); el undo no se reinicia al guardar, solo al restaurar una versión.
  Con un proyecto ya guardado, SAVE es siempre un checkpoint del editor (el save clásico pisaría la geometría). Detalle en `docs/ADR_EDITOR_MVP3.md` (D5).

## Problemas abiertos

- **Docker Desktop volvió** (2026-10-14): `dotnet test` completo corrió (1706 tests; los 26 E2E de `editor-save` de S13 pasan). En una corrida con la máquina saturada fallaron 8 por timeout de cliente HTTP; aislados, pasan.
- El contrato de `editor-save` no lleva `baseVersion`: solo detecta escrituras simultáneas (409 por `xmin`), no "otra pestaña guardó antes".
- El listado de versiones no expone el nº de capas (el endpoint es de M2.2-S06 y el spec de S13 prohíbe tocarlo): el panel muestra el tamaño en mm.

- **Export** (S15): en el cliente desde el documento en memoria, sin dependencias nuevas (SVG canónico; DXF R12 en mm; PNG; ZIP stored). El PNG y los demás formatos se generaron y comprobaron en un navegador real (una imagen, S16); la **importación de DXF/SVG en LightBurn/LibreCAD/AutoCAD no se ha verificado** (ver `docs/EXPORT_FORMATOS.md`).
- **Laser Check** (S14): en cliente; el modo `stencil` de S11 puede marcar el agujero de una "O" como isla flotante (falso Blocking).

## En curso

**S16 · E2E + Release Candidate** — rama `sprint/3e8d77b2-m3-s16-e2e-release-candidate`: gate implementado y verificado (E2E HTTP 10/10, recorrido jsdom, recorrido real en navegador); falta PR → merge → Notion. Detalle y bugs conocidos en `docs/MVP3_RELEASE.md`.

## Siguiente paso

Cerrar S16 (MVP 3 completo). Pendiente humano: probar los DXF/SVG exportados en el software de fabricación objetivo y decidir los bugs conocidos de `docs/MVP3_RELEASE.md`.
