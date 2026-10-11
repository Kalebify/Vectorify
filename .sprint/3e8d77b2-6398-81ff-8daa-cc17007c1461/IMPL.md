# IMPL.md — M3-S10 · Cut / Split de geometría

## Resumen
Herramienta **Cut**: el usuario traza una polilínea (o un segmento) y divide objetos en piezas, en dos modos explícitos
(*Dividir* —las piezas comparten el borde— o *Separar con ranura* de ancho en mm), con preview que colorea cada pieza y
Apply/Cancel. Sobre el servicio de geometría de S04/S08/S09 (Shapely). Spec: `spec.md`.
**Nota de origen**: el conector de Notion estaba desconectado; la spec se redactó con el Objetivo y el Criterio de aceptación de la
tarjeta, sin su cuerpo (UX/Tests). Si el cuerpo trae requisitos extra, se tratarán como corrección posterior.

## Decisiones
- **Dividir**: `unary_union(borde, corte)` + `polygonize`, quedándose con las caras cuyo punto representativo cae en el subject (reparte
  huecos e islas). Líneas abiertas: se parten por posición a lo largo de la polilínea (`substring`); una polilínea cerrada se vuelve a
  unir en su vértice de origen. **Ranura**: resta un `buffer` de **extremos planos** (no `bufferedLine` redondo de S04: con extremos
  redondos la ranura se pasaría del trazo y dejaría de ser exactamente ancho × largo; test que lo fija).
- **Un corte que no atraviesa NO divide**, en ambos modos (`changed` solo si salen más piezas útiles que antes); el panel lo dice. La
  opción *Extender* prolonga primer/último tramo más allá de la diagonal de todo lo involucrado.
- **Alcance**: con selección ⇒ solo esos objetos; sin selección ⇒ todos los visibles y desbloqueados cruzados, listados antes de
  aplicar. Bloqueados/ocultos se omiten e informan. Piezas en la **misma capa** del original (sin decisión de capa), ids nuevos, mismo
  `fill`/`stroke`, sin matriz; `changed:false` conserva `d`. "Ninguno cambia" ⇒ Apply deshabilitado con explicación.
- **Preview/Apply**: igual que S08/S09 (debounce, abort, una petición viva, sin llenar la pila de undo); un comando atómico por Apply.
- **Línea de corte**: click agrega punto; doble click/Enter la terminan; arrastrar traza un segmento recto (umbral 4 px); Backspace quita
  el último punto y la reabre; Escape borra la línea y, vacía, cierra la herramienta; Enter con la línea terminada aplica.

## Entregado
- **Python**: `app/core/geometry_split.py` (`run_split`), `process_split` en el servicio (límites + timeout), ruta
  `POST /api/v1/geometry/split`, esquemas y `max_geometry_cutter_points = 10 000`.
- **ASP.NET**: contratos, `ValidateSplit` (`unknown_split_mode`, `invalid_slot_width`, `invalid_cutter`, `too_many_cutter_points`),
  `GeometryService.SplitAsync`, `PythonGeometryClient.SplitAsync` (revalida eco de parámetros, una entrada por subject, tipo de pieza,
  anillos cerrados/finitos, `pieceCount`, `changed ⇒ touched` y ≥ 2 piezas, `discarded`), `POST /api/v2/geometry/split`,
  `Geometry:MaxCutterPoints`.
- **Frontend**: `lib/editor/cut.ts` (puro; `planLineCut`/`LineCutPlan` para no chocar con `planCut` del portapapeles),
  `useCutOperation` (sobre `useGeometryPreview`), `useCutTool`, `CutPanel`, `CutOverlay`; `ToolSurface` acepta `tool:"cut"`; herramienta
  Cut habilitada (ya no queda ninguna herramienta deshabilitada en el toolbar). ADR actualizado.

## Desviaciones / observaciones
- La respuesta por subject trae dos campos extra, `touched` (lo toca pero no lo atraviesa ≠ no lo toca) y `discarded` (descartes
  visibles). Opción nueva `Geometry:MaxCutterPoints`. Cambiar la selección exige salir de Cut (la superficie captura el puntero).
- Cut no tiene atajo de teclado propio (igual que Offset).
- Una polilínea cerrada cortada una sola vez queda en una pieza abierta (no cuenta como separada).

## Verificación (orquestador)
Ver el reporte de QA en el PR (los 5 comandos corridos de forma independiente). El implementador comprobó con mutaciones (Python 27,
C# 20, frontend 47) que los tests pueden fallar; las pocas que sobrevivieron se reforzaron o son equivalentes (guardas redundantes).
