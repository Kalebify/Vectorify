# IMPL.md — M3-S15 · Export avanzado SVG / DXF / PNG / Layers

## Resumen
El botón **EXPORT** del editor abre un diálogo con **preflight** (dimensiones en mm, layers incluidos con su operación, bloqueantes del Laser Check) y
exporta **SVG**, **DXF** (mm), **PNG** (tamaño configurable, fondo transparente u opaco) y **layers individuales** (un archivo por layer, en **ZIP** cuando
son varios). Todo sale del documento **en memoria** (lo que el usuario ve, aunque no esté guardado). Spec: `spec.md`; detalle de formatos en
`docs/EXPORT_FORMATOS.md` y ADR D8.

## Decisiones
- **Desviación de la tarjeta (Área "ASP.NET Core")**: el export se implementa en el **cliente**. El export v1 (M1-S10) solo sirve el SVG guardado del pipeline
  clásico, el backend no tiene DXF/PNG/ZIP, y exportar desde el servidor obligaba a guardar antes y a añadir dependencias. Backend y Python **sin cambios**;
  el export clásico no se toca. **Sin dependencias nuevas**: ZIP, DXF y PNG con código propio y APIs del navegador.
- **SVG**: `width`/`height` en mm y `viewBox` del marco; un `<g>` por layer (`id`, `data-operation`). Sin escala física va sin unidades, con `data-units="none"` y
  un `<desc>`. Por layer: un SVG con el mismo marco (se superponen). Se reabre con el parser del editor con la misma geometría (test).
- **DXF** AC1009 (R12): POLYLINE/VERTEX/SEQEND, `$INSUNITS` 4 (0 sin escala), origen en la esquina inferior-izquierda del marco, **Y invertido**, curvas
  aplanadas a ≤ 0,01 mm (tope 2048 segmentos por curva), `transform` aplicado, 6 decimales, CRLF. Una capa DXF por layer (≤ 31 caracteres, mayúsculas, únicas) más la `0`.
  Cada subpath es una polilínea (cerrada solo si termina en `Z`); **los huecos son polilíneas adicionales**. Sin color ni relleno.
- **ZIP** *stored* (sin compresión) con CRC-32 propio, fecha fija (1980-01-01) ⇒ mismo contenido, mismos bytes; sin ZIP64 (error explícito al superar 65 535 entradas / 4 GiB).
- **PNG**: ancho por defecto 1024 px (mín. 16), tope 8192 px por lado y 16 MP (fuera de tope se rechaza con el ancho máximo, no se recorta). Fondo blanco por defecto o
  transparente. El rasterizado va detrás de una interfaz inyectable; se valida la firma PNG de lo que devuelve.
- **Nombres** `proyecto_layer_operación.ext` (`[a-z0-9.-]`, 40 caracteres por parte, reservados de Windows con `-x`, colisiones `-2`, `-3` deterministas); documento único
  `proyecto_documento.ext`, paquete `proyecto_layers.zip`.
- **Preflight**: un reporte del Laser Check ausente, desactualizado o con checks sin correr es "No verificado", nunca OK. Con `Blocking` el botón dice "Exportar de todos
  modos" y exige un checkbox. Selección por defecto: layers visibles y distintos de IGNORE. Generación todo-o-nada, cancelable (cerrar el diálogo no descarga nada).
- **Laser Check acotado a lo exportado**: los bloqueantes de layers que no se exportan no exigen confirmación; se informan aparte.
- El diálogo **comparte** la instancia de `useLaserCheck` del panel de S14: abrirlo dispara el análisis (incluida la petición de flotantes al servidor). Si el servicio de
  flotantes cae, el preflight queda "No verificado" y se puede exportar igual.

## Entregado
- `lib/editor/export/` (`exportDocument`, `fileNames`, `zip`, `svgExport`, `dxfExport`, `pngExport`, `exportPlan`, `exportRunner`, `browser`) con sus tests, `hooks/useExport.ts`,
  `ExportDialog` (+ tests), `EditorShell.export.test.tsx`, soporte de tests (`exportDataset`, `exportReaders` —lectores ZIP y DXF independientes de los escritores—, `fakePng`),
  `serializeEditablePaths` extraído de `serializeEditableLayer` (bytes de salida idénticos), EXPORT habilitado en `EditorHeader`, estilos, `docs/EXPORT_FORMATOS.md`, ADR D8.

## NO verificado
- **Importación de los DXF** en LightBurn, LibreCAD o AutoCAD (unidades, orientación, cerrado, capas): solo se leyeron con un parser mínimo de test. `$INSUNITS` no existe en R12
  estricto; se escribe igual y un lector estricto debería ignorarlo (no comprobado). `EXPORT_FORMATOS.md` trae un procedimiento manual de validación.
- **Rasterizado real del PNG** en navegador (`Image` + `<canvas>` + `toBlob`) y su fidelidad frente al canvas del editor; **descarga real** (`Blob` + `<a download>`): solo con dobles/seams.
- SVG exportado en Inkscape/Illustrator/LightBurn (cómo leen `width="…mm"`). Rendimiento con una sola layer de decenas de miles de objetos.
- El ZIP sí se comprobó una vez a mano con Info-ZIP (`unzip -t`), .NET `ZipFile`, `tar` y `Expand-Archive` de Windows (no es un test automático).

## Verificación (orquestador)
`npm test`: 136 archivos / 3253 tests verdes; `npm run build` y `npm run lint` sin errores ni warnings nuevos. `dotnet build` / `pytest` no se repitieron (backend y Python sin cambios desde S14).
