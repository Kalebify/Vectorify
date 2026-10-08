# IMPL.md — M3-S04 · Erase + Draw

## Resumen
Draw (pluma/mano alzada) y Erase (objeto / restar geometría) en el editor, e **inauguración del servicio de
geometría del servidor** (ADR D4): Python/Shapely + ASP.NET Core, sin estado. Spec: `spec.md`.

## Decisiones
1. **Capa activa**: la seleccionada (o la del objeto seleccionado). Ninguna ⇒ se crea una capa «Dibujo» explícita en
   el MISMO comando atómico (mecanismo de S03); bloqueada/oculta ⇒ rechazo claro. Tras dibujar, esa capa queda activa.
2. **Objetos abiertos/cerrados**: `EditorObject` gana `stroke?`/`strokeWidth?` y `fill:"none"`. Cerrado ⇒ relleno con el
   color de la capa; abierto ⇒ trazo del color de la capa (0,1 mm por defecto). Round-trip serialize→parse probado; el
   hit-test contempla trazos (`max(strokeWidth/2, tolerancia)`); Fill/Recolor pintan `stroke` en las líneas.
3. **Formato de intercambio**: anillos de polígonos / polilíneas en unidades de documento (tipo GeoJSON), no path data.
   El cliente aplana curvas con tolerancia explícita; las booleanas devuelven **polilíneas aplanadas** (documentado en
   el ADR D4/D1). La respuesta trae `changed` por subject: un objeto intacto conserva sus Bézier originales.

## Entregado
- **Python**: `app/core/geometry_ops.py` (union/difference/intersection/xor/normalize; polígonos con regla par-impar,
  `make_valid`, pincel `bufferedLine` con resolución de arcos acotada, descarte de piezas < tolerancia², orden y
  orientación deterministas, `linemerge`), `app/services/geometry_service.py` (límites + timeout),
  `POST /api/v1/geometry/boolean` (cuerpo crudo ⇒ siempre `{code,message}`, rechaza NaN/Infinity y cuerpos grandes).
- **ASP.NET Core**: `POST /api/v2/geometry/boolean` (`GeometryEndpoints` → `GeometryService` → `IPythonGeometryClient`),
  validador de entrada (null/NaN/Infinity/operación/tolerancia/límites ⇒ 400 `ApiErrorResponse`), el cliente revalida
  la respuesta de Python; errores `engine_unavailable` 503 / `timeout` 504 / `invalid_response` 502. Sin DB ni usuario.
- **Frontend**: `lib/editor/{geometry,draw,erase}.ts`, `types/geometry.ts`, `api/geometryApi.ts`,
  `hooks/{useGeometryOperation,useDrawEraseTools}`, `ToolSurface`, `DrawPanel`, `ErasePanel`, `MeasureField`. Draw:
  pluma (click/Enter/doble click/Backspace/Escape, cerrar sobre el primer punto) y mano alzada (RDP en mm); trazo
  auto-intersecado ⇒ `normalize` del servidor, o rechazo si el servidor falla (nunca geometría inválida). Erase: modo
  **Objeto** (hit-test, bloqueadas se informan) y **Restar** (pincel en mm con cursor al tamaño real; alcance capa
  activa / todas las desbloqueadas; piezas con ids nuevos, el original conserva su id solo si queda una pieza;
  todo-o-nada; un comando por gesto; error del servidor ⇒ sin cambios).

## Desviaciones del spec
- Ruta Python `/api/v1/geometry/boolean` (prefijo de las rutas vecinas). Códigos de error reales del repo
  (`engine_unavailable`/`timeout`/`invalid_response`) en vez del inexistente `python_unavailable`.
- Sin suavizado Bézier en mano alzada (opcional en la spec): polilínea simplificada.
- Campo `changed` por subject en la respuesta (no estaba en la spec).

## Hallazgos en código previo
- `distanceToPolylines` cerraba implícitamente toda polilínea abierta (>2 puntos): ahora `respectOpen`.
- Konva con `fill="none"` pintaba negro: se mapea a `undefined`.
- Área con signo de un "moño" simétrico da 0: se detecta primero el cruce y recién después se valida el área.
- Pydantic acepta `NaN` en JSON: validación explícita (`allow_inf_nan=False`).

## Verificación (orquestador)
Ver el reporte de QA en Notion/PR: `dotnet build`, `dotnet test`, `pytest`, `npm test`, `npm run build`, `npm run lint`.
El implementador además levantó uvicorn + API .NET reales (polígono con hueco partido en dos piezas, línea
`changed:false`, null/NaN ⇒ 400) y comprobó con mutaciones (Python 15, frontend 20, C# 10) que los tests pueden fallar.
