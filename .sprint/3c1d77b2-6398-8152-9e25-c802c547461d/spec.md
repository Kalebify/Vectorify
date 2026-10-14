# M3-S15 · Export avanzado SVG / DXF / PNG / Layers
URL: https://app.notion.com/p/3c1d77b2639881529e25c802c547461d
Stack declarado (propiedad Área): ASP.NET Core, Vector, Laser. **Ver decisión 1: se implementa en el cliente (React/TS); desviación declarada.**

> Lee primero `docs/ADR_EDITOR_MVP3.md` (D5/S13, D7/S14), `.sprint/3e8d77b2-6398-81b7-a1fc-e0ba5f9cd524/IMPL.md` (Laser Check) y el export clásico de M1-S10
> (`backend/Vectorify.Api/Export/*`, `frontend/src/components/export/ExportPanel.tsx`: solo sirve SVG del pipeline v1 guardado; NO se modifica).
> Antes de escribir código lee: `frontend/src/lib/editor/objects.ts` (`serializeEditableLayer`, `parseEditableLayer*`), `frame.ts` (`serializeFrame`, `frameToViewBox`),
> `units.ts` (`mmPerUnit`, `toMm`, `unitScale`), `pathGeometry.ts`/`geometry.ts` (aplanado de curvas), `lib/editor/laserCheck.ts` + `hooks/useLaserCheck.ts` (reporte para el preflight),
> `components/editor/EditorHeader.tsx` (botón EXPORT hoy deshabilitado), `EditorShell.tsx` (cómo se cablean paneles/diálogos; `mmFactor`, `committedLayers`, `committedObjectsByLayer`, `committedFrame`),
> y `components/editor/VersionHistoryPanel.tsx`/`LaserCheckPanel.tsx` (patrón de panel accesible, aria-live, Escape, foco).

## Requerimiento (transcripción del cuerpo de la tarjeta)
Objetivo: Exportar el documento editado en formatos útiles para fabricación y revisión manteniendo SVG como formato canónico.
Criterio de aceptación: SVG y DXF conservan escala mm y geometría; PNG genera preview correcto; se pueden exportar layers seleccionados o separados con nombres deterministas.

**Regla.** SVG continúa siendo el formato canónico interno. DXF/PNG son adaptadores de exportación.
**Export.** SVG completo. DXF en mm. PNG de preview con tamaño configurable. Layers seleccionados. Export individual por Layer, preferentemente empaquetado cuando sean múltiples archivos.
**Preflight.** Antes de exportar mostrar dimensiones, layers incluidos, operación CUT/ENGRAVE/IGNORE y warnings bloqueantes del Laser Checker.
**Naming.** Nombres seguros y deterministas: project_layer_operation.ext.
**DXF.** Documentar primitivas soportadas y validar importación en herramienta/visor objetivo.
**Tests.** Escala, holes, layers, nombres, export parcial, PNG transparente y reapertura de SVG.
**Definition of Done.** El usuario puede salir de VECTORiZE con archivos coherentes con lo que ve en el editor y aptos para continuar el flujo de fabricación.
**Fuera de alcance.** Usar DXF como formato interno.

## Criterios de aceptación
1. El botón EXPORT del editor abre un diálogo de export con **preflight**: dimensiones (mm, o aviso "sin escala"), layers incluidos con su operación (CUT / ENGRAVE / IGNORE / sin asignar) y los issues bloqueantes del Laser Check.
2. Formatos: **SVG** completo, **DXF** en mm, **PNG** con tamaño configurable (y fondo transparente u opaco), y **layers individuales** (un archivo por layer) empaquetados en **ZIP** cuando son varios archivos.
3. Se pueden elegir los layers a exportar (selección parcial); por defecto: visibles y distintos de IGNORE.
4. SVG y DXF conservan la escala mm y la geometría (huecos incluidos); un SVG exportado se puede reabrir con el parser del editor y da la misma geometría.
5. Nombres seguros y deterministas `proyecto_layer_operación.ext`.
6. Lo exportado es **lo que el usuario ve en el editor**, aunque no esté guardado.
7. Documentación de las primitivas DXF soportadas y de cómo se validó (`docs/EXPORT_FORMATOS.md`).

## Referencias visuales / de marca
MISSING (seguir el lenguaje visual de los paneles/diálogos del editor y `editor.css`).

## Umbrales de calidad
Defaults del proyecto: `npm test`, `npm run build`, `npm run lint` sin warnings nuevos en lo tocado, `dotnet build`, `pytest` sin regresiones.

## Decisiones del orquestador (documentarlas en IMPL.md, ADR y `docs/EXPORT_FORMATOS.md`)
1. **Export en el cliente, sobre el documento en memoria** (desviación de "ASP.NET Core"): el export v1 solo sirve SVG del pipeline guardado y el backend no tiene DXF/PNG/ZIP ni librerías para ello; exportar desde el servidor obligaría a guardar antes y a añadir dependencias (Svg.Skia/ezdxf). Aquí el archivo sale de la misma geometría que el editor dibuja. **Sin dependencias nuevas** en npm/NuGet/pip: ZIP (método *stored* + CRC-32), DXF y PNG se escriben con código propio y APIs del navegador. Backend y Python **sin cambios** (si crees necesitarlos, anótalo como desviación justificada). El export clásico de M1-S10 no se toca.
2. Módulos **puros y testeables sin DOM** en `lib/editor/export/` (p. ej. `exportPlan.ts`, `svgExport.ts`, `dxfExport.ts`, `zip.ts`, `fileNames.ts`); el DOM (Blob/descarga, canvas) queda en una capa fina inyectable.
3. **SVG**: un documento con `width`/`height` en `mm` y `viewBox` en unidades del documento (si no hay escala física, sin unidades, con aviso), un `<g>` por layer (`id`, `data-operation`, nombre), geometría de `serializeEditableLayer`. Export por layer: un SVG por layer con el mismo `viewBox`/tamaño del documento (para que se superpongan). Debe reabrirse con `parseEditableLayer*` sin pérdida de geometría.
4. **DXF** (ASCII, AutoCAD **R12/AC1009** por compatibilidad, `$INSUNITS = 4` mm): **POLYLINE/VERTEX/SEQEND** (no LWPOLYLINE), un DXF layer por layer del editor (nombre saneado), coordenadas en mm con el **eje Y invertido** (SVG y↓ → DXF y↑, `y' = alto − y`). Curvas (Bézier/arcos) aplanadas a polilíneas con tolerancia en mm (constante exportada, p. ej. 0,01 mm); el `transform` de cada objeto se aplica. Cada subpath es una polilínea (cerrada con el flag 1 si se cierra); los **huecos** son subpaths adicionales (DXF no tiene "relleno"): la geometría de huecos se conserva. Sin color/relleno (solo geometría). Primitivas soportadas = POLYLINE/VERTEX/SEQEND; documentar lo que NO (texto, bloques, splines, arcos nativos, hatch).
5. **PNG**: tamaño configurable (ancho en px con la relación de aspecto del documento; tope por lado y por megapíxeles, con mensaje), fondo **transparente u opaco** (color configurable o blanco). Render del SVG exportado a `<canvas>` (o dibujo de los paths) detrás de una interfaz inyectable (`rasterize(svg, w, h, background)`), para poder testear con un doble. Es un preview, no un archivo de fabricación.
6. **Naming**: `proyecto_layer_operación.ext` (`proyecto` = nombre del proyecto; `operación` ∈ `cut|engrave|ignore|unassigned`); saneado a `[a-z0-9._-]` en minúsculas sin tildes, longitud acotada, sin nombres reservados de Windows; **determinista** (mismo documento ⇒ mismos nombres, orden por `order` de la layer) y **sin colisiones** (sufijo `-2`, `-3` determinista). El archivo único del documento: `proyecto_documento.ext` (y `proyecto_png`-style para el ZIP: `proyecto_layers.zip`).
7. **Preflight** = función pura `buildExportPreflight(document, selection, options, laserReport)`: dimensiones en mm (o "sin escala"), layers incluidos/excluidos y por qué (oculta, IGNORE, no seleccionada), operación de cada layer, nº de objetos, **issues bloqueantes del Laser Check** (reusar `useLaserCheck`/`analyzeLaserLocal`; si el reporte no está listo o hay checks sin verificar, mostrarlo como NO VERIFICADO, nunca como OK). Con Laser Check `Blocking` el botón dice "Exportar de todos modos" y exige confirmación explícita (checkbox); no se bloquea del todo (es una decisión del usuario). Capas `unassigned` se avisan.
8. **Diálogo accesible** (`role="dialog"`, `aria-modal`, foco inicial y devuelto al botón EXPORT, Escape cierra, Tab atrapado, `aria-live` para el estado "Generando…/Listo/Error"). Descarga con Blob + `<a download>` detrás de un *seam* inyectable. Un error de generación se muestra, nunca se descarga un archivo parcial.
9. Documentos grandes: generar sin congelar la UI de forma evidente (trabajo por layer; si es costoso, ceder al event loop entre layers); sin límite artificial salvo el de PNG.
10. Cablear el botón EXPORT de `EditorHeader` (hoy deshabilitado, `aria-label` "próximamente") y actualizar sus tests; listas manuales de `VectorCanvas` no deberían tocarse (no es una herramienta de canvas).

## Tests exigidos
- **Puros**: `fileNames` (saneado, tildes, reservados, truncado, colisiones, determinismo); `zip` (CRC-32 con vectores conocidos, estructura local header/central directory/EOCD verificada con un lector mínimo en el test, nombres UTF-8, varios archivos); `svgExport` (escala mm, un `<g>` por layer, huecos, reapertura con el parser del editor ⇒ geometría idéntica, por layer, sin escala); `dxfExport` (cabecera/secciones/`$INSUNITS`, Y invertido, coordenadas en mm, cerrado vs. abierto, huecos como polilíneas extra, curvas aplanadas dentro de tolerancia, `transform` aplicado, capas DXF, estructura válida verificada con un parser mínimo en el test); `exportPlan`/preflight (selección parcial, ocultas/IGNORE, sin escala, Laser Check bloqueante/no verificado).
- **PNG**: con el doble de rasterizado (tamaño pedido, relación de aspecto, tope, fondo transparente vs. opaco).
- **Diálogo/EditorShell**: abrir desde el header, preflight visible, elegir formato/layers, descargar (seam), nombres, error, confirmación con Blocking, teclado/foco; suite S01–S14 verde.
- **Dataset**: documento con huecos, varias capas (CUT/ENGRAVE/IGNORE), una capa oculta y una sin escala.
- Verificación: `npm test`, `npm run build`, `npm run lint`, `dotnet build`, `pytest`.

## DoD
El usuario puede salir de VECTORiZE con archivos coherentes con lo que ve en el editor y aptos para continuar el flujo de fabricación.

## Ambigüedades detectadas
- "Validar importación en herramienta/visor objetivo": no hay visor en el entorno de desarrollo; se valida con un parser DXF mínimo de test y se documenta **qué se probó y qué NO** (importación en LightBurn/LibreCAD/AutoCAD sin verificar). No declarar la compatibilidad como verificada si no se probó.
- Tolerancia de aplanado de curvas, tope de PNG y longitud máxima de nombres no están en la tarjeta: constantes documentadas (se listan como supuestos en el PR).
- Fuera de alcance: DXF como formato interno, correcciones automáticas, export desde servidor, cambios al export clásico de M1-S10.
