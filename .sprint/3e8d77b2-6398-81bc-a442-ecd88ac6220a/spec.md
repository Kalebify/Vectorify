# M3-S16 · E2E + Release Candidate MVP 3
URL: https://app.notion.com/p/3e8d77b2639881bca442ecd88ac6220a
Stack declarado (propiedad Área): Frontend, ASP.NET Core, Python, Vector, Laser, Infra.

> Lee primero `docs/ADR_EDITOR_MVP3.md`, `docs/estado.md`, `docs/EXPORT_FORMATOS.md`, los IMPL.md de S11–S15 en `.sprint/` y, del gate de MVP 1/2.2, `tests/e2e/full_pipeline_e2e_test.mjs`,
> `tests/e2e/fixtures/generate_fixtures.py`, `backend/Vectorify.Api.Tests/EndToEnd/PersistenceReleaseGateTests.cs` y el README (sección "Flujo E2E completo (M1-S11)").

## Requerimiento (transcripción del cuerpo de la tarjeta)
Objetivo: Cerrar MVP 3 como primera versión realmente utilizable de VECTORiZE mediante pruebas end-to-end, corrección de regresiones y checklist de release.
Criterio de aceptación: Import → Vectorize → Edit → Laser Check → Save → Reopen → Export funciona de extremo a extremo en el dataset acordado sin errores bloqueantes.

**Objetivo de producto.** MVP 3 debe ser una versión entregable y usable, no una colección de demos.
**Flujos E2E obligatorios.** Upload → preprocess/vectorize → palette/layers → Editor → selección/edición → Laser Check → Save → Reopen → Export.
**Dataset.** 1. Logo B/N. 2. Logo multicolor. 3. Ilustración 4–6 colores. 4. Texto. 5. Diseño con holes. 6. Diseño con floating pieces. 7. SVG importado si import está soportado. 8. Imagen con ruido/antialiasing.
**Validaciones.** No pérdida de color/layers; medidas mm; undo/redo; autosave; version restore; warnings; export SVG/DXF/PNG/layers.
**Calidad.** Tests automatizados críticos + checklist manual. Documentar bugs conocidos no bloqueantes y limitaciones.
**Release gate.** Cero defectos bloqueantes en el happy path; errores recuperables y mensajes comprensibles; README actualizado.
**Definition of Done.** Una persona puede completar un diseño real para láser desde la imagen hasta el archivo exportado sin editar manualmente el SVG fuera de VECTORiZE.

## Criterios de aceptación
1. Un E2E automatizado (HTTP contra la pila real) recorre, por cada imagen del dataset: upload → preprocess/threshold → paleta/capas → guardado v2 → edición persistida (`editor-save`, incluida una capa nueva) → reapertura (documento + versiones) → restore → comparación (colores/capas/mm sin pérdida).
2. Un recorrido automatizado del Workspace (jsdom) cubre el tramo cliente: abrir un documento del dataset → selección/edición → undo/redo → Laser Check → autosave → reapertura con lo guardado → export SVG/DXF/PNG/layers, comprobando coherencia entre lo editado y lo exportado.
3. El dataset incluye (ver "Ambigüedades") logo B/N, logo multicolor, ilustración de 4–6 colores, texto, diseño con holes, diseño con piezas flotantes y una imagen con ruido/antialiasing.
4. Checklist de release **manual** y documento de **bugs conocidos / limitaciones** (`docs/MVP3_RELEASE.md`); README actualizado con una sección de MVP 3 (editor, comandos, persistencia/versiones, Laser Check, export) y cómo correr el gate.
5. Cualquier defecto **bloqueante** del happy path que encuentren los E2E o el orquestador se corrige con un test rojo primero; los no bloqueantes se documentan.

## Referencias visuales / de marca
MISSING.

## Umbrales de calidad
Defaults del proyecto: `npm test`, `npm run build`, `npm run lint` sin warnings nuevos en lo tocado, `dotnet build`, `dotnet test` (Docker disponible), `pytest`.

## Decisiones del orquestador
1. **Pila real aislada**: el orquestador levantó un release candidate con `docker compose -p vectorify-s16-rc` (backend `http://localhost:5180`, frontend `http://localhost:5174`, Python `:8101`, Postgres `:5532`). **No uses ni toques** el proyecto `vectify` (puertos 5080/5173), que es del usuario. Los scripts E2E reciben `BACKEND_URL` (default `http://localhost:5080` como los de M1-S11) y no arrancan la pila.
2. **Alcance del E2E HTTP** (`tests/e2e/mvp3_release_e2e_test.mjs`, mismo estilo que `full_pipeline_e2e_test.mjs`): el export de S15 es del cliente, así que el HTTP cubre hasta restore; el export se cubre en el recorrido jsdom (criterio 2) y en el checklist manual.
3. **Dataset**: ampliar `generate_fixtures.py` (determinista, solo cv2/numpy, sin dependencias nuevas) con `multicolor.png`, `illustration.png` (5 colores), `floating.png` (piezas que quedan flotantes al cortar, p. ej. contra-formas de letras/anillos) y `antialias.png` (bordes suaves). Texto, holes y ruido ya existen (`text.png`, `holes.png`, `noise.png`); logo B/N: `logo.png`. **SVG importado**: no hay import de SVG en el producto (verifícalo con grep) ⇒ documentarlo como "no aplica" en `docs/MVP3_RELEASE.md`.
4. **Gate honesto**: el documento de release lista qué se verificó, cómo (comando, pila, fecha) y qué NO (navegador real, DXF en software de fabricación, rendimiento con documentos enormes). No declares "verificado" lo que solo corre en jsdom.
5. **No agregues features.** Si encuentras un defecto: arréglalo con un test rojo primero si es bloqueante en el happy path; si no lo es, documéntalo en bugs conocidos. Reporta cada hallazgo (qué, dónde, cómo reproducir, si lo arreglaste).
6. Backend/Python: solo tocar lo necesario para corregir un defecto real (con tests). `dotnet test` ya corre con Docker.

## Tests exigidos
- E2E HTTP contra `BACKEND_URL` (con la pila RC) para todo el dataset; reporte legible al final con tiempos y fallos; sale con código ≠ 0 si algo falla. Debe correr de verdad contra la pila RC y reportar el resultado real.
- Recorrido jsdom del Workspace (nuevo `*.release.test.tsx`) con documentos del dataset (holes, flotantes, multicapa/multicolor, texto), reusando los fixtures/harness de los tests de EditorShell existentes.
- Suites existentes verdes (S01–S15).

## DoD
Una persona puede completar un diseño real para láser desde la imagen hasta el archivo exportado sin editar manualmente el SVG fuera de VECTORiZE; el gate y sus límites están documentados.

## Ambigüedades detectadas
- "Cero defectos bloqueantes en el happy path" depende de un recorrido real en navegador: lo hace el orquestador sobre la pila RC (browser integrado) y lo registra en `docs/MVP3_RELEASE.md`.
- No hay criterio numérico de rendimiento ni de "dataset acordado" más allá de la lista: se usa la lista de la tarjeta.
- "SVG importado si import está soportado": ver decisión 3.
