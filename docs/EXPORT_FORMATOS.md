# Export avanzado del editor: SVG, DXF, PNG y layers (M3-S15)

Cómo sale un documento de VECTORiZE hacia fabricación y revisión, qué primitivas DXF se escriben (y cuáles NO), qué convenciones de escala y ejes se usan, y —con la
misma importancia— **qué se validó y qué no**. Decisiones de diseño en `docs/ADR_EDITOR_MVP3.md`, D8.

Código: `frontend/src/lib/editor/export/*` (módulos puros, sin DOM), `frontend/src/hooks/useExport.ts` y `frontend/src/components/editor/ExportDialog.tsx`.

## 1. Principios

- **SVG es el formato canónico.** DXF y PNG son adaptadores de exportación: nacen de la misma geometría en memoria y nunca se reimportan (DXF como formato interno está fuera de alcance).
- **Se exporta lo que el usuario ve**, aunque no esté guardado: el export lee el documento confirmado en memoria (capas efectivas, orden, visibilidad y operación), no la versión del servidor.
- **Sin dependencias nuevas** (npm/NuGet/pip). ZIP (método *stored* + CRC-32), DXF y PNG se escriben con código propio y APIs del navegador. Backend y Python sin cambios; el export clásico de M1-S10 (`ExportPanel`, solo SVG del pipeline guardado) no se toca.
- **Todo o nada**: si la generación falla no se descarga ningún archivo parcial; el error se muestra en el diálogo.

## 2. Qué se puede exportar

| Formato | Un archivo (`document`) | Un archivo por layer (`layers`) |
| --- | --- | --- |
| SVG | `proyecto_documento.svg` con las layers elegidas, un `<g>` por layer | un SVG por layer, mismo `viewBox` y tamaño |
| DXF | `proyecto_documento.dxf`, una capa DXF por layer | un DXF por layer, mismo origen y ejes |
| PNG | `proyecto_documento.png` con las layers elegidas (vista previa) | un PNG por layer, mismo tamaño |

Con **varios** archivos se empaqueta un ZIP `proyecto_layers.zip`; con una sola layer elegida se descarga el archivo directo.

**Layers por defecto**: las visibles y distintas de IGNORE. El usuario puede marcar cualquiera a mano (incluidas ocultas o ignoradas; el preflight lo avisa).

## 3. Preflight (antes de generar)

`buildExportPreflight(document, selection, options, laserReport)` es una función pura. El diálogo muestra:

- **Dimensiones**: tamaño del área de trabajo en mm, o «`W × H u (sin escala)`» si el documento no tiene escala física.
- **Layers**: todas, con operación (Corte / Grabado / Ignorada / Sin operación), nº de objetos, si entran y, si no, por qué (oculta, IGNORE, no seleccionada). Una layer incluida que está oculta, ignorada, sin operación o vacía lleva una nota.
- **Archivos** que se van a generar y el nombre de la descarga.
- **Avisos**: sin escala, layers sin operación incluidas, ocultas/ignoradas incluidas a mano, layers vacías y, para PNG, que es una vista previa.
- **Laser Check** (S14) restringido a lo que se exporta:
  - `Ready` / `Review` / `Blocking` salen del reporte vigente, contando solo los issues de las layers incluidas (un bloqueante de una layer que no se exporta se informa aparte y no cuenta).
  - **`No verificado`** si no hay reporte vigente (todavía corre o el documento cambió) o si algún check no se pudo correr (p. ej. las piezas flotantes, que dependen del servidor). **Nunca se muestra como OK.**
  - Con `Blocking`, el botón pasa a **«Exportar de todos modos»** y exige tildar una confirmación. La confirmación vale para ese conjunto de issues: si cambia la selección o el análisis, se pide de nuevo. No se bloquea del todo: es decisión del usuario.
- **No se puede exportar** (botón deshabilitado, con el motivo a la vista): sin layers elegidas, layers sin objetos, ancho de PNG inválido o fuera de tope, color de fondo inválido.

El Laser Check del diálogo es **el mismo análisis** del panel de S14 (misma instancia de `useLaserCheck`): abrir el export no duplica la petición de flotantes.

## 4. Nombres de archivo

`proyecto_layer_operación.ext`, deterministas y seguros (`fileNames.ts`):

- `proyecto` = nombre del proyecto sin extensión conocida (`Project.svg` → `project`); `operación` ∈ `cut | engrave | ignore | unassigned`.
- Cada parte: minúsculas, sin tildes (NFD; `ß æ œ ø đ ł` transliterados), todo lo que no sea `[a-z0-9.-]` pasa a `-` (el `_` queda reservado como separador), rachas colapsadas, bordes recortados, **máximo 40 caracteres por parte**, fallback (`proyecto`, `capa`) si queda vacía.
- Nombres reservados de Windows (`con prn aux nul com0-9 lpt0-9`, también con extensión): reciben `-x` en el primer tramo.
- Orden por `order` de la layer (desempate por `groupId`): el mismo documento y la misma selección dan siempre los mismos nombres.
- Colisiones (comparadas sin distinguir mayúsculas): la primera conserva el nombre, las siguientes `-2`, `-3`… sobre el nombre completo (`proyecto_rojo_cut-2.svg`).
- Otros nombres: `proyecto_documento.ext`, `proyecto_layers.zip`.

## 5. SVG

- `<?xml …?>` + `<svg xmlns="http://www.w3.org/2000/svg" width height viewBox>`; `viewBox` = el área de trabajo (`frameToViewBox`, en unidades de documento, **con su origen**: un documento recortado conserva `x y`).
- **Con escala**: `width`/`height` en `mm` (`data-units="mm"`, `data-mm-per-unit`). 1 unidad del `viewBox` = `mmPerUnit` mm.
- **Sin escala**: `width`/`height` **sin unidad** (= unidades del documento), `data-units="none"` y un `<desc>` que lo dice. No se inventan milímetros.
- Un `<g id="layer-N" data-layer-id data-name data-operation data-color>` por layer (con `<title>`), en orden de pintado. `N` es la posición de la layer en el documento (estable aunque la selección cambie).
- Cada objeto sale con **la misma serialización que el guardado** (`serializeEditablePaths`): `<path data-vid d fill [stroke stroke-width] [transform]>`. Los huecos son subpaths del mismo `d`. Reabrir el SVG con `parseEditableLayer` devuelve el mismo `id`, `d`, relleno, trazo y matriz (cubierto por tests, incluida una matriz con rotación y decimales largos).
- Por layer: el mismo `viewBox`, `width`, `height` y escala, con un solo `<g>`; los archivos se superponen exactamente.

## 6. DXF

**Versión**: ASCII, AutoCAD R12 (`$ACADVER = AC1009`) por compatibilidad. Líneas con `CRLF`; cada par «código de grupo / valor» en dos líneas, código alineado a 3 columnas, enteros a 6.

**Secciones**: `HEADER` (`$ACADVER`, `$INSUNITS`, `$EXTMIN`, `$EXTMAX`), `TABLES` (`LTYPE CONTINUOUS`; `LAYER`: la capa `0` y una por layer del editor, color 7, línea `CONTINUOUS`), `ENTITIES`, `EOF`.

**Unidades y ejes**

- Con escala: **milímetros** (`$INSUNITS = 4`). Las coordenadas son `unidades × mmPerUnit`.
- Sin escala: se escriben las unidades del documento tal cual y `$INSUNITS = 0` (sin unidades); el preflight lo avisa. Al importar hay que indicar la escala a mano.
- **Origen**: la esquina **inferior-izquierda del área de trabajo** (no del lienzo original). **Y invertido**: SVG tiene Y hacia abajo y DXF hacia arriba, así que `y' = (marco.y + marco.alto − y) · mmPerUnit` y `x' = (x − marco.x) · mmPerUnit`. Los objetos dentro del marco quedan en coordenadas ≥ 0.
- `$INSUNITS` **no existe en el formato R12 estricto** (se introdujo después); se escribe porque la decisión del proyecto fija DXF en mm y las herramientas modernas lo leen; un lector R12 estricto lo ignora. Si una herramienta no respeta las unidades, ajustar la escala en la importación.

**Primitivas soportadas** (lo único que se escribe)

| Entidad | Uso |
| --- | --- |
| `POLYLINE` (`66 = 1`, elevación 0, flag `70`: `1` = cerrada, `0` = abierta) | un subpath del path (contorno, hueco o línea) |
| `VERTEX` | cada punto de la polilínea (X, Y; Z = 0) |
| `SEQEND` | cierra la polilínea |

**NO soportadas / no se escriben**

- `LWPOLYLINE` (no existe en R12), `LINE`, `ARC`, `CIRCLE`, `ELLIPSE`, `SPLINE` y arcos por *bulge*: **todas las curvas se aplanan a segmentos rectos**.
- Texto (`TEXT`/`MTEXT`), bloques (`BLOCK`/`INSERT`), cotas, `HATCH`/relleno, imágenes, sólidos 3D.
- Color, grosor de línea y relleno del objeto: **solo geometría** (todo en color 7 / `CONTINUOUS`). Una línea con trazo se exporta como su polilínea, sin el ancho del trazo.
- Z siempre 0; no hay extrusión ni capas 3D.

**Geometría**

- **Curvas**: Bézier cúbicas (y los arcos/cuadráticas, que el editor ya normaliza a cúbicas) se aplanan con un error de flecha ≤ `DXF_FLATNESS_MM` = **0,01 mm** (10 µm), medido en el espacio del documento tras aplicar el `transform` del objeto. Tope de 2 048 segmentos por curva. (Es la tolerancia por defecto del servicio de geometría de S04.) Las curvas dejan de ser curvas: reimportar el DXF no devuelve nodos Bézier.
- **Transform**: la matriz de cada objeto se aplica a todos sus puntos. Un objeto con una matriz no finita se omite y se avisa.
- **Huecos**: DXF no tiene relleno ni regla de relleno. Cada subpath es una `POLYLINE` independiente: el contorno exterior y cada hueco son polilíneas cerradas separadas. La geometría de los huecos se conserva; el significado «esto es un hueco» no (lo infiere la herramienta de destino por anidamiento).
- **Abierto/cerrado**: solo las que cierran con `Z` llevan el flag de cerrado; las demás quedan abiertas (un path con relleno que no cierra queda abierto: el Laser Check lo reporta como *path abierto*). En un contorno cerrado se omite el último vértice si repite al primero.
- Se descartan vértices consecutivos repetidos; un «cerrado» de 2 vértices se escribe como línea abierta; un `M` suelto no genera nada. Un path con error de sintaxis se exporta hasta donde se puede leer (como lo dibuja el editor) y se avisa.
- Coordenadas con hasta 6 decimales (1 nm en mm).
- **Capas DXF**: nombre de la layer saneado a `[A-Z0-9_$-]`, máximo 31 caracteres, únicas (`-2`, `-3`…), nunca vacío ni `0`. Sin la operación en el nombre.

## 7. PNG

- Vista previa, **no** archivo de fabricación (no conserva la escala).
- Ancho configurable en px (default **1024**, mínimo **16**); el alto sale de la relación de aspecto del área de trabajo. Topes: **8 192 px por lado y 16 megapíxeles**; fuera de tope se rechaza con un mensaje que dice el ancho máximo que sí se admite para ese documento (no se recorta en silencio).
- Fondo **transparente** o **de color** (`#rgb`/`#rrggbb`, blanco por defecto).
- Se rasteriza el SVG exportado (con `width`/`height` en px y el mismo `viewBox`) en un `<canvas>` detrás de la interfaz `Rasterizer = (svg, width, height, background | null) => Promise<Uint8Array>`; la lógica se prueba con un doble. Lo que devuelve se valida (firma PNG) antes de entregarlo.

## 8. ZIP

Escritor propio (`zip.ts`): método 0 (*stored*), CRC-32 (IEEE), nombres UTF-8 (flag de bit 11), local headers + central directory + EOCD, **sin ZIP64** (hasta 65 535 archivos y 4 GiB; fuera de eso se lanza un error en vez de escribir un ZIP corrupto). La fecha es la mínima de DOS (1980-01-01) salvo que se pase otra: mismo contenido ⇒ mismos bytes. Nombres de entrada validados (sin `..`, rutas absolutas, `\` ni caracteres de control; sin repetidos).

## 9. Constantes (ajustables, en el código)

| Constante | Valor | Dónde |
| --- | --- | --- |
| `DXF_FLATNESS_MM` | 0,01 mm | `dxfExport.ts` |
| `DXF_MAX_CURVE_STEPS` | 2 048 | `dxfExport.ts` |
| Decimales de coordenadas DXF | 6 | `dxfExport.ts` |
| `PNG_DEFAULT_WIDTH` / `PNG_MIN_SIDE` | 1 024 / 16 px | `pngExport.ts` |
| `PNG_MAX_SIDE` / `PNG_MAX_PIXELS` | 8 192 px / 16 000 000 | `pngExport.ts` |
| `PNG_DEFAULT_BACKGROUND` | `#ffffff` | `pngExport.ts` |
| `MAX_NAME_PART_LENGTH` | 40 | `fileNames.ts` |
| Largo máximo de capa DXF | 31 | `fileNames.ts` |
| `MAX_PREFLIGHT_ISSUES_SHOWN` | 8 (presentación; el preflight conserva todos) | `exportPlan.ts` |

## 10. Qué se validó y qué NO

**Validado (automático, en la suite del frontend):**

- Escala mm del SVG y del DXF (`$INSUNITS`, `width`/`height`, factor, marco con origen distinto de 0), Y invertido, coordenadas en mm, `transform` aplicado (traslación y rotación), cerrado vs. abierto, huecos como polilíneas adicionales, curvas aplanadas **dentro de la tolerancia** (medido contra la curva exacta y contra un círculo), nombres de capa DXF, determinismo.
- **DXF**: estructura leída con un **parser mínimo propio del test** (`src/test/exportReaders.ts`: secciones balanceadas, EOF, pares código/valor, `POLYLINE → VERTEX* → SEQEND`, ninguna otra entidad). Es independiente del escritor, pero **no es un lector de CAD real**.
- **SVG**: reapertura con el parser del editor (`parseEditableLayerStrict`) con la misma geometría, por documento y por layer; documento bien formado con `DOMParser`.
- **ZIP**: lector mínimo en el test (EOCD → central directory → local header, CRC con una implementación de referencia bit a bit), vectores CRC-32 conocidos, nombres UTF-8, varios archivos, binarios, vacíos.
- **Nombres**: saneado, tildes, reservados de Windows, truncado, colisiones, determinismo.
- **PNG**: tamaño pedido, relación de aspecto, topes, fondo transparente vs. opaco, errores, **con un doble de rasterizado**.
- **Preflight y diálogo**: selección parcial, ocultas/IGNORE, sin escala, Laser Check Blocking / No verificado, confirmación, foco, Escape, Tab atrapado, `aria-live`, error sin descarga, cancelación; integración en `EditorShell`.
- **Una verificación manual puntual** (no automatizada, hecha una vez al implementar): un ZIP generado con el código real se abrió con Info-ZIP `unzip -t` (CRC OK en cada entrada), con `System.IO.Compression.ZipFile` de .NET y con `tar.exe` de Windows, y `Expand-Archive` extrajo los archivos con los tamaños esperados.

**NO validado (no se declara compatible):**

- **La importación de los DXF en LightBurn, LibreCAD, AutoCAD, Inkscape u otro visor/CAM real.** En el entorno de desarrollo no hay ninguno. Que el parser de test lea el archivo y que la estructura sea la de R12 **no garantiza** que cada herramienta lo abra igual (unidades, orientación, polilíneas cerradas vs. abiertas, `$INSUNITS` en un archivo R12, capas). Antes de usarlo en una pieza real hay que abrirlo en la herramienta objetivo y medir una cota conocida (ver 11).
- **El rasterizado real del PNG en un navegador** (`rasterizeWithCanvas`: `Image` + `<canvas>` + `toBlob`): jsdom no decodifica SVG, así que solo está probado con el doble. No se midió la fidelidad respecto del canvas del editor ni el comportamiento en cada navegador (Firefox exige `width`/`height` explícitos —el SVG de rasterizado los lleva—, Safari tiene límites de canvas propios).
- **La descarga real** (`Blob` + `<a download>`): solo se probó con el *seam* inyectado.
- **Rendimiento con documentos muy grandes**: el trabajo se hace por layer cediendo al *event loop* entre layers, pero una sola layer con decenas de miles de objetos se genera de una vez (no se midió). Se probó con 2 000 objetos con curvas.
- Importar el SVG exportado en Inkscape/Illustrator/LightBurn, y el comportamiento del atributo `width="…mm"` en cada uno.

## 11. Cómo validar a mano un DXF en la herramienta objetivo

1. Exportar DXF de un documento con una pieza de medida conocida (p. ej. un rectángulo de 100 × 50 mm con un hueco).
2. Importar en LightBurn / LibreCAD / AutoCAD indicando milímetros.
3. Medir el ancho y alto de la pieza y la posición del hueco; comprobar que el origen está abajo a la izquierda y que la pieza no está espejada.
4. Comprobar que cada layer del editor es una capa y que los contornos cerrados se importan como formas cerradas.
5. Anotar el resultado (herramienta y versión) en esta sección; hasta entonces la compatibilidad queda **sin verificar**.
