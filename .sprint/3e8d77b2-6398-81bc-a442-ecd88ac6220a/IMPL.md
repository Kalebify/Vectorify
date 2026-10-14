# IMPL.md — M3-S16 · E2E + Release Candidate MVP 3

## Resumen
Gate de release de MVP 3: dataset ampliado, un **E2E HTTP** contra la pila real (imagen → paleta/capas → guardado → edición persistida → reapertura → versiones →
restore), un **recorrido del Workspace en jsdom** hasta el export, un **recorrido manual en un navegador real** sobre una pila de release candidate aislada,
README y `docs/MVP3_RELEASE.md` (matriz de verificación, checklist, bugs conocidos, límites). El gate encontró **un defecto bloqueante**, corregido aquí.
Spec: `spec.md`.

## Decisiones
- **Pila RC aislada**: `docker compose -p vectorify-s16-rc` (backend `:5180`, frontend `:5174`, Python `:8101`, Postgres `:5532`), construida desde `main` tras S15.
  No se tocó la pila de desarrollo (`:5080`/`:5173`). Los scripts E2E reciben `BACKEND_URL` y no levantan la pila.
- **Tres niveles de verificación, dicho cada uno por lo que cubre**: E2E HTTP (servidor real: Python, Postgres, storage), jsdom (lógica del cliente: Konva sobre jsdom,
  descarga y rasterizado inyectados) y navegador real (recorrido manual con una sola imagen, `holes.png`). El export no está en el E2E HTTP porque es del cliente (S15).
- **Dataset** (determinista, solo cv2/numpy): se añaden `multicolor.png`, `illustration.png` (5 colores), `floating.png` y `antialias.png`; los seis PNG anteriores no cambian
  byte a byte. «SVG importado» **no aplica**: el producto no importa SVG (la subida solo acepta PNG/JPEG/WEBP).
- **Sin features nuevas**: un solo cambio de producto, la corrección del defecto A.

## Defecto bloqueante hallado y corregido (A)
La operación de fabricación elegida en la sesión (Corte/Grabado/Ignorar/sin asignar) **no llegaba** al Laser Check (S14), al export (S15), al análisis de flotantes (S11) ni
al `editor-save` (S13). El editor guarda la operación vigente en `useManufacturingOperations`; las capas que consumían esos módulos salían del documento cargado. Peor aún,
**el autosave devolvía al servidor la operación anterior**, pisando un cambio que el PATCH ya había persistido.
- Lo encontró el recorrido real en navegador (el Laser Check decía que ambas capas se ignoraban con Color 2 en Corte; el servidor sí tenía Corte). Ningún test existente lo veía:
  ninguno cambia operaciones dentro de la sesión y luego usa esos consumidores.
- Corrección en `EditorShell.tsx`: `serverLayers` aplica el overlay `manufacturingOperations[g]?.operation ?? layer.manufacturingOperation` (misma referencia si no
  hay diferencias). 3 tests rojos primero (`EditorShell.history.test.tsx`, «operación de fabricación cambiada en la sesión»): el `editor-save` lleva la operación elegida,
  «sin asignar» viaja como `null` y el Laser Check respeta «Ignorar».
- Verificado de nuevo en la pila RC reconstruida: Color 2 → Grabado, el Laser Check la analiza como Grabado (sin flotantes, estado Ready) y SAVE persiste `engrave` (v10) sin revertirlo.

## Entregado
- `tests/e2e/fixtures/generate_fixtures.py` + 4 PNG; `tests/e2e/mvp3_release_e2e_test.mjs` (10 imágenes × 17 pasos; exit ≠ 0 si algo falla);
  `frontend/src/components/editor/EditorShell.release.test.tsx` (4 documentos: holes, flotantes, multicolor con fondo IGNORE, texto con `transform`);
  `docs/MVP3_RELEASE.md`; sección «MVP 3» en `README.md`; la corrección y sus tests.

## Resultados
- **Backend** (`dotnet test` completo, Docker disponible): 1706 tests; en la corrida larga fallaron 8 con `TaskCanceledException` (timeout del cliente HTTP, con la máquina
  saturada por builds de Docker, vitest y el E2E en paralelo); reejecutados aislados, 8/8 verdes. **Los 26 casos E2E de `editor-save` de S13 pasan por primera vez.**
- **E2E HTTP** contra la pila RC: 10/10 imágenes (corrido por el implementador y de nuevo por el orquestador).
- **Recorrido real en navegador**: ver la tabla en `docs/MVP3_RELEASE.md`. Subir, paleta/capas, Workspace, Laser Check (con flotantes del servidor real), edición + autosave, undo,
  versiones + restore, reapertura y export SVG/DXF/PNG (opaco y transparente)/ZIP por layer.
- **Python**: sin cambios (`pytest` 931 verdes en la última corrida).

## No verificado
Importación de DXF/SVG en LightBurn/LibreCAD/AutoCAD; otros navegadores y dispositivos táctiles; las otras 9 imágenes del dataset en la UI real (solo por HTTP/jsdom); dibujar o
arrastrar con el mouse sobre el canvas real (los eventos de teclado y la inspección se hicieron con JavaScript); rendimiento con imágenes grandes o > 5 000 paths.

## Bugs conocidos (no bloqueantes)
En `docs/MVP3_RELEASE.md`. Los más visibles: falso Blocking por contra-formas (modo `stencil`), paleta por defecto sobre imágenes con ruido/antialiasing, y el texto del header tras un
autosave.
