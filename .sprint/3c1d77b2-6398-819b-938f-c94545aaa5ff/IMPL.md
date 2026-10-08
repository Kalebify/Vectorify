# IMPL.md — M3-S05 · Path / Nodes / Bézier

## Resumen
Modo Path: seleccionar y mover anchors/handles, agregar/eliminar nodos, cambiar tipo de nodo, cerrar/abrir subpaths y
editar coordenadas en mm, con un gesto = un comando. Solo frontend. Spec: `spec.md`. (La sesión del implementador se
cortó una vez por un límite de la API y se retomó desde el árbol de trabajo.)

## Entregado
- `lib/editor/nodes.ts` (modelo puro): `pathToModel`/`modelToPath` sobre `parsePathData`; `moveAnchors` (los handles
  viajan), `moveHandle` por `kind` (smooth conserva el largo opuesto, symmetric espeja exacto, corner independiente, Alt
  rompe), `addNodeOnSegment` (**De Casteljau exacto**: la forma no cambia), `deleteNodes` (eliminación mínima),
  `toggleSegmentKind`, `setNodeKind`, `closeSubpath`/`openSubpathAt`, `setAnchor`/`setHandleVector`, `inferKind`.
- `lib/editor/pathEdit.ts`: integración con el documento (`resolvePathTarget`: un objeto, capa visible y desbloqueada,
  matriz invertible, `d` legible), `applyModelEdit` (solo cambia `d`), hit-test con tolerancias en **px de pantalla**,
  overlay acotado al viewport y a 1500 nodos, marquee, navegación entre nodos.
- `hooks/usePathTool.ts`, `PathSurface.tsx` (overlay SVG en px de pantalla: anchors 8 px, handles r=4 px),
  `PathPanel.tsx` (X/Y en mm relativas al marco vigente de S02, tipo de nodo, largo/ángulo de handles, tipo de segmento,
  cerrar/abrir/eliminar, confirmación). Herramienta Path habilitada; doble click con Select entra a Path.
- Garantías: objeto no editado conserva su `d` byte a byte; compound paths conservan orden/winding/huecos;
  idempotencia `d → modelo → d` (6 decimales sin ceros sobrantes) y sin deriva tras 1000 ediciones; edición en espacio
  **local** del objeto con su `matrix` (probado con objetos rotados/escalados/espejados); arrastre =
  `beginGesture/previewEdit/commitGesture` (un comando), Escape durante el arrastre cancela sin rastro, nudges fusionados
  con `coalesceKey`; undo/redo restauran el `d` exacto.

## Decisiones menores
Cada segmento `C` deja handles en ambos extremos (aunque midan 0) para serialización idempotente; `kind` inferido por
geometría (collineal sen ≤ 1e-3 ⇒ smooth; + igual largo ±0,1 % ⇒ symmetric) con una memoria de etiquetas por `d`;
eliminar un nodo une los vecinos conservando sus handles externos (la forma cambia, como se espera); quedar degenerado
pide confirmación para borrar el subpath, y si es el único se rechaza; abrir un lazo deja dos nodos coincidentes que
cerrar vuelve a fusionar; segmento recto → curvo con handles a 1/3.

## Desviaciones / observaciones
- Entrar con selección inválida activa igual la herramienta y el panel explica el rechazo.
- El `ObjectInspector` de S01 muestra X/Y absolutas del documento y los nodos relativas al marco (S02): inconsistencia
  señalada, no tocada.
- `VectorCanvas` no podía elegir objeto con una herramienta sin superficie: ahora Path usa el modo "solo seleccionar".

## Verificación (orquestador)
`npm test` 1577/1577 · `npm run build` limpio · `npm run lint` 0 errores · `dotnet build` 0/0. 30 mutaciones del
implementador (De Casteljau, espejo symmetric, eliminación mínima, hit area sin 1/zoom, un `applyEdit` por paso en lugar
de `previewEdit`, Escape en burbuja, etc.), todas detectadas.
