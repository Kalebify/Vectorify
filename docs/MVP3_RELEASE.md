# MVP 3 — Release candidate (M3-S16)

Criterio de aceptación de la tarjeta: **Import → Vectorize → Edit → Laser Check → Save → Reopen → Export** de punta a punta sobre el dataset acordado, sin errores bloqueantes
en el happy path. Este documento dice qué se verificó, cómo, cuándo y qué **no**; lista el checklist manual, los bugs conocidos no bloqueantes y las limitaciones.

Fecha de las corridas automáticas: **2026-10-14**. Pila: release candidate aislada (`docker compose -p vectorify-s16-rc`, construida desde `main` con S01–S15): backend
`http://localhost:5180`, frontend `:5174`, Python `:8101`, Postgres `:5532`. No se usó la pila de desarrollo (`:5080`/`:5173`).

## Dataset

Generado de forma determinista con OpenCV + NumPy (sin dependencias nuevas):
`services/python-engine/.venv/Scripts/python.exe tests/e2e/fixtures/generate_fixtures.py` (los seis PNG anteriores no cambian byte a byte).

| # | Pedido de la tarjeta | Fixture | Detalle |
|---|---|---|---|
| 1 | Logo B/N | `logo.png` (+ `silhouette.png`, `problematic.png`) | anillo + estrella; contorno orgánico; dos círculos congruentes |
| 2 | Logo multicolor | `multicolor.png` | círculo rojo, cuadrado azul y triángulo verde sobre blanco |
| 3 | Ilustración 4–6 colores | `illustration.png` | sol, casa, árbol y estanque: 5 colores + fondo |
| 4 | Texto | `text.png` | «VECTIFY» en negro |
| 5 | Diseño con holes | `holes.png` | dona (path con subpath de sentido opuesto) |
| 6 | Piezas flotantes | `floating.png` | dos anillos (uno con disco concéntrico) y un marco: sus contra-formas se caen al cortar |
| 7 | SVG importado | — | **No aplica**: el producto no importa SVG. La subida solo acepta PNG/JPEG/WEBP (`UploadOptions.AllowedContentTypes`, `Dropzone` `accept=`); el `image/svg+xml` de `AssetOptions` es para los SVG de capa que genera el propio sistema, no una importación de usuario. |
| 8 | Ruido / antialiasing | `noise.png`, `antialias.png` | ruido gaussiano fuerte; círculo y texto con bordes suaves (supersampling 4x) |

## Matriz de verificación

| Qué | Cómo | Cuándo / dónde | Resultado |
|---|---|---|---|
| Pipeline HTTP completo por imagen: upload → preview/threshold/vectorize → paleta (detect/confirm) → capas → operaciones + mm → `workspaces/save` → GET document → `editor-save` (SVG de capas editados + capa nueva, replay idempotente) → reapertura (document + `/versions`) → AUTOSAVE (quita la capa nueva, renombra) → restore de v2 y de v1 → comparación byte a byte de SVG, colores, capas y mm | `BACKEND_URL=http://localhost:5180 node tests/e2e/mvp3_release_e2e_test.mjs` | 2026-10-14, pila RC | **10/10 imágenes OK** (ver detalle abajo) |
| Errores recuperables del `editor-save`: viewBox inválido → 400 `invalid_parameters` con mensaje y sin crear versión; proyecto inexistente → 404 con mensaje | mismo script | ídem | OK en las 10 imágenes |
| Piezas flotantes (Laser Check de S14/S11) contra el motor real (Shapely) sobre las capas CUT guardadas | mismo script (`POST /api/v2/geometry/floating`, modo plantilla) | ídem | OK: `holes.png` y `floating.png` ≥ 1 isla, `problematic.png` 0 |
| Recorrido del Workspace (jsdom): abrir documento del dataset (holes, flotantes, multicolor con fondo IGNORE, texto con `transform`) → seleccionar (medida en mm del Inspector) → editar (flechas, un comando) → undo / redo exactos → Laser Check sobre lo editado → autosave (3 s, `AUTOSAVE`) → reabrir con lo guardado (shell nuevo) → export SVG / DXF / PNG / layers; lo editado, lo autoguardado, lo reabierto y lo exportado son la misma geometría (`d` + desplazamiento), con los mismos colores | `cd frontend && npm test -- --run src/components/editor/EditorShell.release.test.tsx` | 2026-10-14, jsdom (sin navegador) | **4/4 OK** (holes, flotantes, multicolor, texto), ~20 s |
| Suites existentes (S01–S15) | `npm test -- --run`, `npm run build`, `npm run lint` | 2026-10-14 | `npm test`: **137 archivos / 3 260 tests OK**; `npm run build` OK; `npm run lint`: 0 errores, solo advertencias previas (`App.tsx`, `ProjectsDashboard.tsx`, `spike-editor-engine/`), ninguna en lo tocado por S16 |

Tiempos del E2E HTTP en la pila RC (10 imágenes, 17 pasos cada una): 400–770 ms por imagen, ≈ 6,7 s en total; el paso más lento es la detección de paleta (60–115 ms) y el guardado/reapertura/restore tardan 10–85 ms. `dotnet test` y `pytest` no se corrieron en S16 porque no se tocó backend ni Python.

### Qué NO se verificó (límites del gate)

- **Navegador real, cobertura parcial.** El recorrido jsdom usa Konva sobre jsdom y un rasterizador/descarga inyectados; que pase ahí no prueba el navegador. El apartado «Recorrido manual en navegador» sí lo hizo en un navegador real, **pero solo con `holes.png`** (una imagen, un navegador, sin dibujar con el mouse sobre el canvas ni arrastrar). Las otras imágenes del dataset no se recorrieron en la UI real; sí por HTTP.
- **DXF en software de fabricación** (LightBurn, LibreCAD, AutoCAD): solo se valida con un lector DXF propio y estricto. Ver `docs/EXPORT_FORMATOS.md`, «Qué NO se validó».
- **PNG real**: verificado en un navegador real con `holes.png` (1024 px opaco y 300 px transparente, decodificados y con píxeles comprobados). Otros navegadores, imágenes grandes y los límites de `<canvas>` de cada navegador no se ejercitaron.
- **Rendimiento con documentos enormes** (≥ 5 000 paths; ADR D6): solo hay pruebas de rendimiento en jsdom (`VectorCanvas.performance.test.tsx`, `performance.test.ts`); no se midió en navegador ni con imágenes grandes reales. El dataset es de 200–300 px.
- **Persistencia tras reinicio de contenedores en S16**: no se repitió. Está cubierta por el gate de MVP 2.2 (`PersistenceReleaseGateTests`, `tests/e2e/docker_persistence_test.py`); S16 no lo reejecutó.
- **Export desde el servidor / import de SVG / multiusuario simultáneo**: no existen en el producto.
- **Mensajes de error de la UI ante fallos de red reales** (backend caído a mitad de un autosave): cubiertos por tests unitarios de `useGeometrySave`, no por un corte real.
- **Los E2E HTTP no recorren el export** (decisión de la tarjeta: el export de S15 es del cliente).

## Checklist de release manual

Hacer en un navegador real contra la pila RC (o una pila limpia) con al menos `logo.png`, `multicolor.png`, `floating.png` y `text.png`. Marcar cada ítem y anotar la fecha y quién lo hizo.

**Importar y vectorizar**
- [ ] Subir la imagen **haciendo click/arrastrando en la UI** (no por HTTP). Un formato no soportado (p. ej. un `.svg`) muestra un mensaje comprensible y no rompe la pantalla.
- [ ] Preprocesar (contraste/brillo/denoise) y aplicar threshold: la vista previa cambia y las métricas son coherentes.
- [ ] Detectar la paleta, fusionar/excluir colores, confirmar. Con la ilustración salen 5 colores + fondo.
- [ ] Generar capas: una por color; el fondo queda como capa propia.
- [ ] Asignar operación (Corte / Grabado / Ignorar) y fijar el ancho en mm.

**Editor**
- [ ] Guardar (primer guardado crea el proyecto) y entrar al Workspace desde «Mis proyectos».
- [ ] Seleccionar un objeto (click, Shift, marquee), mover, escalar, rotar; el Inspector muestra mm correctos.
- [ ] Editar con al menos tres herramientas distintas (p. ej. Draw, Offset, Cut/Booleanas) y ver el resultado en el canvas.
- [ ] Deshacer / rehacer con los botones y con Ctrl+Z / Ctrl+Shift+Z; abrir el panel Historial y saltar a una entrada.
- [ ] Capa nueva con un color, dibujar en ella.
- [ ] Capa bloqueada u oculta: no se edita ni se selecciona.

**Laser Check**
- [ ] Abrir Laser Check: estado Ready / Review / Blocking coherente con el diseño. Con `floating.png` o `holes.png` aparecen piezas flotantes (ver bug conocido #1).
- [ ] Click en un issue: selecciona el objeto, centra la vista y lo resalta.
- [ ] Conectar una pieza flotante con un bridge (herramienta Flotantes) y volver a analizar.

**Guardar y reabrir**
- [ ] Esperar el autosave (≈ 3 s tras editar): el indicador pasa a «Geometría guardada» y desaparece «Cambios de geometría sin guardar».
- [ ] Recargar la página: aparece el aviso `beforeunload` solo si hay geometría sin guardar.
- [ ] Reabrir el proyecto desde «Mis proyectos»: la geometría, los colores, los nombres de capa y las medidas son las editadas.
- [ ] Versiones: ver la lista (origen y fecha), restaurar una anterior (crea una versión nueva) y comprobar que el documento vuelve a ese estado.

**Exportar**
- [ ] Export SVG: abrirlo en Inkscape (o similar); medidas en mm correctas, una `<g>` por layer, colores intactos.
- [ ] Export DXF: abrirlo en LightBurn / LibreCAD; unidades en mm, huecos presentes, orientación Y correcta.
- [ ] Export PNG: tamaño pedido, fondo transparente u opaco, se ve igual que el editor.
- [ ] Export de layers (un archivo por layer en ZIP): los nombres `proyecto_layer_operación.ext`, el ZIP abre en el sistema operativo.
- [ ] Export con Laser Check en Blocking: pide confirmación explícita y solo entonces exporta.
- [ ] La layer oculta y la IGNORE no se exportan por defecto y el diálogo lo explica.

**Errores recuperables**
- [ ] Apagar el backend (o cortar la red) durante un guardado: el editor muestra un error legible, no pierde la geometría y permite reintentar.
- [ ] Servicio de geometría caído (booleana / offset): el mensaje es comprensible y el documento no cambia.
- [ ] Dos pestañas guardando a la vez: el conflicto (409) ofrece «Recargar documento» / «Reintentar».

## Defectos bloqueantes hallados por el gate y corregidos

| # | Qué pasaba | Cómo se encontró | Corrección |
|---|---|---|---|
| A | **La operación de fabricación elegida en la sesión (Corte / Grabado / Ignorar / sin asignar) no llegaba al Laser Check, al export ni al `editor-save`.** El editor guarda la operación vigente en `useManufacturingOperations`, pero las capas que consumen el guardado, el Laser Check (S14), el export (S15) y el análisis de flotantes (S11) salían del documento cargado, con la operación del momento de abrirlo. Consecuencias: el Laser Check analizaba/ignoraba capas equivocadas, el nombre `proyecto_layer_operación` del export salía con la operación vieja y **el autosave devolvía al servidor la operación anterior** (pisando un cambio que el PATCH ya había persistido). | Recorrido real en navegador: tras cambiar operaciones, el Laser Check decía «Ignoradas por su operación: Color 1, Color 2» con Color 2 en Corte; el servidor sí tenía Corte. Ningún test (jsdom ni HTTP) lo veía: ninguno cambia operaciones dentro de la sesión y luego usa estos consumidores. | `EditorShell.tsx`: `serverLayers` aplica el overlay de `useManufacturingOperations` (misma referencia si no hay diferencias). 3 tests rojos primero en `EditorShell.history.test.tsx` («operación de fabricación cambiada en la sesión»). Verificado de nuevo en la pila RC reconstruida. |

## Bugs conocidos no bloqueantes

| # | Qué pasa | Dónde se vio | Impacto / workaround |
|---|---|---|---|
| 1 | **Falso Blocking por «pieza flotante» en contra-formas legítimas.** El Laser Check usa el modo `stencil`: el hueco de una dona/O/A es material rodeado por corte y se reporta como isla flotante. | E2E real: `holes.png` → 1 flotante; `logo.png` (anillo + estrella) → 1; `antialias.png` («Ag») → 2. Ya anotado en `docs/estado.md`. | Si el diseño es un *relleno* (no una plantilla), el aviso no aplica. El export con Blocking se permite con confirmación explícita. |
| 2 | **Paleta con los parámetros por defecto sobre imágenes con antialiasing/ruido devuelve decenas de grupos** (una capa por tono del borde). | `antialias.png` → 10 grupos; `text.png` → 11; `noise.png` → 17. | Acotar «máximo de colores» (con `maxColors=3`: 2 colores reales + fondo) o subir el umbral de grupo diminuto (`tinyAreaRatio=0.01` deja `text.png` en 1 color). El E2E usa esos parámetros para esos fixtures. |
| 3 | El fondo detectado (excluido) igual se vectoriza como capa propia (`Color 1`, blanco, cubre todo el marco). | `GET document` de cualquier imagen. | Asignarle la operación Ignorar (el E2E lo hace) para que no entre al export ni al Laser Check. |
| 4 | El servicio `POST /api/v2/geometry/floating` responde 400 si un subject trae un anillo con menos de 3 vértices. VTracer emite esos subpaths con imágenes ruidosas. | `noise.png` (script E2E de S16 tuvo que filtrarlos). | No afecta al editor: `planFloating` descarta esas geometrías antes de llamar al servicio. |
| 5 | El historial de undo/redo es de sesión: recargar o reabrir lo pierde. | Recorrido jsdom (tras reabrir el botón Deshacer queda deshabilitado). | Las versiones guardadas (autosave / manual) sí persisten y se pueden restaurar. |
| 6 | `editor-save` no lleva `baseVersion`: dos pestañas guardando una tras otra no chocan (gana la última); solo se detectan dos escrituras simultáneas (409 por `xmin`). | `docs/estado.md`. | Evitar editar el mismo proyecto en dos pestañas. |
| 7 | El listado de versiones no expone el número de capas ni el de objetos (solo origen, fecha y mm). | `VersionHistoryPanel`. | Informativo. |
| 8 | Las booleanas, offset, cortes y bridges devuelven **polilíneas** aplanadas (se pierden los Bézier de los objetos tocados). | ADR D4. | Esperado; los objetos no afectados conservan sus curvas. |
| 9 | **El indicador del header vuelve a «Sin cambios desde la última apertura» unos segundos después de un autosave**, aunque sí hubo cambios (ya guardados). | Recorrido real en navegador (S16). | Cosmético: el estado «Geometría guardada» se ve ~4 s y luego pasa a ese texto; el historial de versiones muestra lo guardado. |

## Limitaciones del MVP 3

- No hay importación de SVG (ni de DXF): el punto de entrada es una imagen raster (PNG/JPEG/WEBP).
- El export (SVG, DXF, PNG, ZIP) se genera **en el cliente** sobre el documento en memoria; no hay export desde el servidor. ZIP *stored* sin ZIP64 (error explícito al superar el límite). PNG máximo 8 192 px por lado y 16 MP.
- DXF R12 (`POLYLINE`) en mm: sin color, relleno ni curvas nativas (aplanadas a ≤ 0,01 mm).
- Laser Check: sin correcciones automáticas ni exportación del reporte; el detalle mínimo se mide con el casco convexo de cada subforma (un estrechamiento cóncavo dentro de una forma grande no se detecta); autointersección con presupuesto de comparaciones (si se agota, queda «no verificada», nunca «OK»).
- Sin compensación automática de kerf ni de material.
- Sin escala física (documento sin ancho en mm) las herramientas operan en unidades del documento y lo avisan.
- Dataset de prueba de 200–300 px: el comportamiento con imágenes de varios megapíxeles o más de 5 000 paths no está medido en navegador.

## Cómo correr el gate

```bash
# 0) Dataset (opcional, ya está versionado; determinista)
services/python-engine/.venv/Scripts/python.exe tests/e2e/fixtures/generate_fixtures.py

# 1) E2E HTTP contra una pila YA arriba (no la levanta). Sale con código != 0 si algo falla.
BACKEND_URL=http://localhost:5180 node tests/e2e/mvp3_release_e2e_test.mjs
#   E2E_ONLY=holes.png,logo.png acota el dataset.

# 2) Frontend: recorrido jsdom + suites existentes, build y lint
cd frontend && npm test -- --run && npm run build && npm run lint

# 3) Backend y motor Python (dotnet test necesita Docker por Testcontainers)
dotnet test backend/Vectorify.sln
services/python-engine/.venv/Scripts/python.exe -m pytest -q services/python-engine
```

Pila RC aislada (proyecto Compose propio; no usar `down -v` ni tocar otros proyectos):

```bash
BACKEND_PORT=5180 FRONTEND_PORT=5174 PYTHON_PORT=8101 POSTGRES_PORT=5532 \
VITE_API_BASE_URL=http://localhost:5180 CORS_ALLOWED_ORIGINS=http://localhost:5174,http://127.0.0.1:5174 \
docker compose -p vectorify-s16-rc up -d --build
```

## Recorrido manual en navegador

Pila: release candidate aislada (`docker compose -p vectorify-s16-rc`), construida desde `main` tras S15; frontend `http://localhost:5174`, backend `:5180`. Navegador: el integrado de Claude (Chromium), viewport 1440×900. Imagen: `tests/e2e/fixtures/holes.png` (240×240 px, 1 forma negra con un hueco). Acciones por la UI real; los eventos de teclado y el volcado de blobs se hicieron con JavaScript de inspección (el navegador integrado no puede abrir el selector de archivos ni guardar descargas).

| Paso | Resultado | Observación |
|---|---|---|
| Subir imagen (input de archivo) | OK | 240 × 240 px, proyecto creado |
| Detectar y confirmar paleta, generar capas | OK | 2 capas (blanco de fondo y negro) |
| Abrir el Workspace, asignar operaciones | OK | Primer cambio crea el proyecto guardado (autosave de staging); URL gana `savedProjectId` |
| Laser Check (tras reabrir) | OK | Blocking: 1 pieza flotante (isla del hueco, 4587 mm²) con análisis de servidor real |
| Click en el issue | OK | Selecciona el objeto; la barra de estado muestra 240 × 240 mm |
| Editar (borrar el objeto) + autosave | OK | "Cambios de geometría sin guardar" → "Geometría guardada" a los ~3 s → versión 5 `AUTOSAVE` en el servidor |
| Deshacer | OK | Vuelve a ensuciar y autoguarda la versión 6; la versión "(actual)" del panel es la correcta |
| Versiones → Restaurar v5 | OK | Versión 7 `RESTORE`, recarga y el documento queda con la geometría de v5 (Color 2 sin paths) |
| Versiones → Restaurar v4 | OK | Versión 8 con la forma recuperada |
| Reabrir (recargar la URL) | OK | Operaciones y geometría persistidas; sin pérdida |
| Export SVG | OK | `holes_documento.svg`, `width/height` en mm, un `<g data-operation="cut">` por layer |
| Export DXF | OK | `holes_documento.dxf`, AC1009, `$INSUNITS` 4, 2 polilíneas (contorno + hueco) |
| Export PNG | OK | 1024×1024 válido (firma PNG), fondo blanco, forma negra y hueco blanco; 300 px con fondo transparente: esquina con alfa 0 (62 % transparente) |
| Export por layer | OK | `holes_layers.zip` con `holes_color-1_ignore.svg` y `holes_color-2_cut.svg` |
| Preflight de export | OK | Dimensiones, layers incluidos/excluidos con motivo, Blocking exige confirmación |

Defectos hallados:

1. **BLOQUEANTE, corregido en esta tarjeta**: la operación de fabricación elegida en la sesión no llegaba al Laser Check, al export ni al `editor-save` (el autosave devolvía al servidor la operación vieja). `serverLayers` no aplicaba el overlay de `useManufacturingOperations`. Corregido en `EditorShell.tsx` con tests rojos primero (3).
2. No bloqueante: el indicador del header vuelve a "Sin cambios desde la última apertura" unos segundos después de un autosave, lo que no describe que sí hubo cambios (ya guardados).
3. No bloqueante / diseño: el Laser Check usa el modo `stencil` de S11; en un diseño con huecos (como `holes.png`) cada hueco se reporta como pieza flotante y el estado queda Blocking. Se puede exportar igual con confirmación. No hay selector `stencil`/`parts` en el Laser Check.

No verificado en este recorrido: importación de los DXF/SVG en software de fabricación, otros navegadores, dispositivos táctiles, documentos grandes.
