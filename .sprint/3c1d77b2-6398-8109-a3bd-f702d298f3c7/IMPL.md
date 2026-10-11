# IMPL.md — M3-S11 · Bridges + piezas flotantes

## Resumen
Análisis de **piezas flotantes** (dos definiciones explícitas), lista de issues que **centran y resaltan** el componente, y **bridges** configurables
en mm con sugerencia determinista, preview, reanálisis del resultado y Apply/Cancel. Sobre el servicio de geometría de S04/S08–S10 (Shapely).
Spec: `spec.md`. (La sesión del implementador se cortó una vez por un límite de uso de la API y se retomó; el árbol estaba completo.)

## Decisiones
- **Flotante — dos modos** (selector, default *Plantilla*): **Plantilla/stencil** — las formas son cortes (vacío) y una isla es cada hueco de la
  unión, a profundidad impar (la contra-forma de A/O/R, los centros de un stencil; un corte dentro de una isla no la conecta); **Piezas/parts** —
  las formas son material y flotante es un componente dentro de un hueco de otro. Ids en orden determinista (profundidad y coordenadas canónicas).
  En Plantilla la hoja es el único componente principal (id 0, sin polígono ni área).
- **Alcance explícito**: la selección o, sin selección, los objetos con relleno de capas **CUT visibles**. Bloqueados **cuentan** para el
  análisis (solo lectura) pero **no se modifican** (un bridge que los necesite se rechaza con motivo); ocultos no cuentan. Solo polígonos.
- **Bridge**: *Plantilla* ⇒ rectángulo de ancho w (default 0,8 mm) que cruza el corte entre isla y material exterior, **restado** de las formas
  de corte; *Piezas* ⇒ rectángulo **sumado** entre el flotante y el cuerpo vecino. El rectángulo entra `2·tolerancia` en cada lado, de modo que el
  área quitada/agregada es exactamente `ancho × largo del hueco`. Sugerencia determinista (punto medio del tramo del borde que mira al padre,
  perpendicular; independiente del vértice inicial y del giro de anillos). El ancla debe estar a ≤ tolerancia del borde; el cliente ajusta un
  click a ≤ 10 px de pantalla. Varios bridges por isla permitidos; `reduces` es acumulado (con dos sobre la misma isla, ambos válidos y solo el
  primero reduce).
- **Reanálisis y validez**: el servidor valida cada bridge (ancla fuera, ancho < tolerancia, no cruza, queda corto, forma bloqueada, no reduce
  flotantes), aplica los válidos juntos y devuelve `floatingBefore → floatingAfter`. Apply solo si todo bridge pedido es válido (una sugerencia que
  el servidor no pudo resolver no bloquea, solo avisa). `changed:false` conserva el `d` original.
- **Análisis explícito**: el botón *Analizar* congela el plan; si cambia un objeto analizado el panel pide re-analizar; cambiar el modo lo
  descarta. Un comando atómico undoable por Apply; preview sin llenar la pila de undo.

## Entregado
- **Python**: `app/core/geometry_floating.py` (`run_floating`, `run_bridges`), servicio (`process_floating`/`process_bridge`, topes y timeout),
  `POST /api/v1/geometry/floating` y `/bridge`, `max_geometry_bridges = 200`.
- **ASP.NET**: `POST /api/v2/geometry/floating` y `/bridge`; validador (`unknown_floating_mode`, `invalid_bridge`, `invalid_bridge_width`,
  `too_many_bridges`), servicio, cliente que revalida toda la respuesta (502 `invalid_response` si no cierra), `Geometry:MaxBridges`.
- **Frontend**: `lib/editor/floating.ts` (puro), `focusTransform` en `viewport.ts` y `centerOn` en `useCanvasTransform` (seleccionar un issue centra
  el viewport), `useFloatingAnalysis`, `useBridgeOperation`, `useFloatingTool`, `FloatingPanel`, `FloatingOverlay`, botón visible "Flotantes"
  en el toolbar (no estaba en el wireframe obligatorio). ADR: sección "Piezas flotantes y bridges (M3-S11)".

## Desviaciones / hallazgos
- Campos extra en la respuesta (`subjects`, `locked`, `affects`, `area`, `length`, `reduces`, `suggested`), `suggest_width`, motivo `no_connection`; el
  principal de Plantilla tiene `polygon: null`; ancho y largo de un bridge se acotan con `Geometry:MaxOffsetDistance`.
- Cada herramienta nueva obliga a tocar listas manuales en `VectorCanvas` (`selectOnly`, Escape, `TOOL_LABELS`): olvidar una falla en silencio.
  `useGeometryPreview` reutiliza el último resultado por clave. Los tres `FakePythonGeometryClient` de tests tuvieron que implementar los métodos nuevos.

## Verificación (orquestador)
Ver el reporte de QA en Notion/PR (los 5 comandos corridos de forma independiente, con Docker activo). Mutaciones del implementador: Python 31/31,
frontend 39 + 15 (las sobrevivientes se reforzaron o son equivalentes), .NET 23 (2 equivalentes por defensa en profundidad).
