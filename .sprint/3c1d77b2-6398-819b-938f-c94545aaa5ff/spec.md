# spec.md — M3-S05 · Path / Nodes / Bézier

> Lee primero `docs/ADR_EDITOR_MVP3.md` y los `IMPL.md` de M3-S01..S04 (`.sprint/3c1d77b2-6398-8167-977a-f44248e874b1/`,
> `.../3e8d77b2-6398-81c5-9257-ea063abbaa7e/`, `.../3e8d77b2-6398-81ac-931c-e83108231222/`, `.../3e8d77b2-6398-8102-b5de-e68e3f8fc1c0/`).
> Reusás `lib/editor/pathGeometry.ts` (`parsePathData` → segmentos absolutos M/L/C/Z, `segmentsToPathData`,
> `flattenSegments`, bounds), `matrix.ts`, `viewport.ts`, `useEditableDocument` (`applyEdit`, gestos, undo/redo, locks),
> `ToolSurface`/`useDrawEraseTools` (patrón de herramientas con captura de puntero) y el Inspector de objetos.

## Contexto
Criterio (Notion): "Mover/agregar/eliminar nodos y editar handles actualiza el path seleccionado sin corromper geometría y es
reversible." DoD: "Puede corregirse un error concreto del tracing con precisión y recuperar el estado anterior."
Notion pide: modo Path, seleccionar segmentos/nodos, mover anchors, editar `handleIn`/`handleOut`, añadir/eliminar nodos,
cerrar/abrir path cuando sea válido; nodos y handles visibles **solo en modo Path**; hit areas cómodas independientes del zoom;
Inspector contextual; mantener precisión, **evitar reserialización destructiva**, conservar winding/holes; **cada gesto
completo = un comando**. Fuera de alcance: editor tipográfico completo, brushes.

## Modelo de nodos (`lib/editor/nodes.ts`, lógica pura — ADR D1/D2)
`PathModel { subpaths: Subpath[] }`, `Subpath { closed: boolean; nodes: PathNode[] }`,
`PathNode { anchor: Point; handleIn: Point | null; handleOut: Point | null; kind: "corner" | "smooth" | "symmetric" }`
(handles **absolutos** en el espacio local del `d` del objeto; `null` = sin handle = segmento recto en ese lado).
- `pathToModel(d)` / `modelToPath(model)`: derivados de `parsePathData` (que ya normaliza arcos/Q a cúbicas). **No se
  reserializa nada que no se editó**: un objeto cuyo `d` no cambió conserva el string original byte a byte; al editar, se
  reserializa **todo el objeto** desde el modelo pero con precisión plena (formato numérico con hasta 6 decimales sin ceros
  sobrantes — documentá la elección y probá idempotencia `model → d → model → d`). Se conservan **subpaths en orden**
  (compound paths/huecos), su **sentido de giro (winding)** y el flag `closed`. El `kind` se infiere de la geometría
  (collineal e igual longitud ⇒ symmetric; collineal ⇒ smooth; si no ⇒ corner) y se conserva mientras se edita.
- Las edición ocurre en el **espacio local del objeto**: la `matrix` del objeto no se toca ni se hornea; los punteros se
  convierten con la inversa de la matriz (matriz no invertible ⇒ el modo Path rechaza el objeto con mensaje).
- Operaciones puras, cada una devuelve un `PathModel` nuevo (inmutable) o un error de validación:
  `moveAnchors(ids, delta)` (los handles viajan con su anchor), `moveHandle(node, side, to)` con la regla del `kind`
  (smooth: el handle opuesto conserva su longitud y se alinea; symmetric: espejo exacto; corner: independientes; **Alt**
  en la UI = romper a corner), `addNodeOnSegment(subpath, segmentIndex, t)` (subdivisión de **De Casteljau exacta**:
  la forma NO cambia; para segmentos rectos agrega un punto sin handles), `deleteNodes(ids)` (quita el anchor y une los
  vecinos conservando sus handles externos — la forma **sí cambia**, es lo esperado; **eliminación mínima**: nunca deja un
  subpath abierto con < 2 nodos ni uno cerrado con < 3 — en ese caso se **elimina el subpath completo** solo si el usuario
  lo confirma, y si es el único subpath del objeto, se rechaza con mensaje), `toggleSegmentKind` (recto ↔ curva: al
  curvar se generan handles a 1/3 del segmento), `setNodeKind`, `closeSubpath(subpath)` / `openSubpathAt(node)` (cerrar
  une último con primero —si ya coinciden se fusionan—; abrir en un nodo parte el lazo ahí; ambas solo si el resultado es
  válido), `setAnchor(node, point)` / `setHandleVector(node, side, length, angle)` para el Inspector numérico.
- Validación del resultado: sin NaN/Infinity, coordenadas dentro de límites, bbox no degenerado salvo que el original lo
  fuera. Una operación inválida **no** cambia nada y explica el motivo.

## UI (herramienta Path, `EditorToolbar` la habilita)
- **Entrar**: herramienta Path con **un** objeto seleccionado (o doble click sobre un objeto con Select ⇒ pasa a Path y lo
  selecciona). Varios objetos seleccionados ⇒ mensaje "Seleccioná un solo objeto"; capa **bloqueada/oculta** ⇒ rechazo claro
  (como en S01). Salir: Escape / Enter / cambiar de herramienta (los cambios ya están comiteados gesto a gesto).
- **Overlay** (solo en modo Path; Konva/SVG como `ToolSurface`): el contorno del path, **anchors** (cuadrados), **handles**
  (círculos) con sus líneas, el nodo/segmento bajo el cursor resaltado. **Tamaños y hit areas en píxeles de pantalla**
  (constantes a cualquier zoom; convertidos a unidades de documento con el zoom actual). Nodos con ≥ 1 handle muestran
  sus handles al seleccionarlos (y los de vecinos opcionalmente); sin saturar documentos con miles de nodos
  (renderizado acotado al viewport y a un máximo razonable con aviso).
- **Selección de nodos**: click, Shift+click (toggle), marquee (en vacío), Ctrl/Cmd+A (todos del subpath activo),
  Escape (limpiar). **Mover**: drag de anchors seleccionados y de handles; flechas = nudge (1 u; Shift 10 u), Shift+drag
  restringe a ejes. **Agregar nodo**: doble click sobre un segmento (o click con modificador) ⇒ De Casteljau en el `t` más
  cercano. **Eliminar**: Delete/Backspace sobre nodos seleccionados (con la regla de eliminación mínima y confirmación si
  elimina un subpath). **Tipo de nodo**: Alt+click sobre un nodo alterna corner↔smooth; botones en el panel.
  **Cerrar/Abrir**: botones contextuales (habilitados solo si es válido).
- **Un gesto = un comando**: el arrastre usa `beginGesture/previewEdit/commitGesture` (S01) y emite UN comando al soltar;
  Escape durante el arrastre cancela sin rastro; agregar/eliminar/toggle = un comando cada uno; nudges consecutivos
  fusionados como en S01 (`coalesceKey`). Undo/redo restauran el `d` EXACTO anterior (snapshot del objeto).
- **Panel contextual / Inspector**: coordenadas del nodo seleccionado en **mm** (x/y editables ⇒ un comando; relativas al
  documento, usando `mmPerUnit` y el marco vigente de S02), tipo de nodo, longitud/ángulo de `handleIn`/`handleOut`,
  tipo de segmento (recto/curvo) y el recuento de nodos del subpath; multi-selección muestra valores comunes.
- Accesibilidad: el panel es operable por teclado; el overlay tiene `aria-label` describiendo el modo y la cantidad de
  nodos seleccionados.

## Integración con el modelo
El objeto editado conserva su `id`, capa, `fill`/`stroke` y `matrix`; solo cambia `d` (y por tanto bounds/hit-test/preview/
miniatura, que ya leen del modelo editable). `geometryDirty` se activa. Objetos con `stroke`/`fill:none` (líneas abiertas
de S04) son editables igual (subpaths abiertos).

## Fuera de alcance
Editor tipográfico, brushes, simplificación/ajuste automático de curvas, snapping a rejilla/nodos, edición simultánea de
varios objetos, conversión de formas primitivas, persistencia (S13), operaciones booleanas (S08).

## Tests exigidos
- `lib/editor/nodes.ts` con **valores calculados a mano**: round-trip `d → modelo → d` para rectas, curvas, arcos
  normalizados, compound paths con huecos (orden y winding intactos), abiertos y cerrados; inferencia de `kind`;
  `moveAnchors` (los handles viajan), `moveHandle` por `kind` (smooth conserva la longitud opuesta; symmetric espejo exacto;
  corner independiente), **De Casteljau**: el punto agregado cae sobre la curva y la forma es idéntica (comparar muestras de
  `flattenSegments` antes/después), `deleteNodes` (eliminación mínima, subpath completo, único subpath ⇒ rechazo), cerrar/
  abrir (válido/ inválido), `toggleSegmentKind`, setters del Inspector, idempotencia de la serialización, precisión (sin
  deriva tras N ediciones), entradas degeneradas.
- Componentes/hook: entrar/salir del modo, rechazo (multi-selección, bloqueada, oculta, matriz no invertible), hit areas
  constantes a distintos zooms (el radio en unidades de documento escala con 1/zoom), selección (click/Shift/marquee),
  drag = **un** comando (la pila de undo crece en 1) y Escape cancela sin rastro, nudge fusionado, agregar/eliminar/toggle,
  undo/redo restauran el `d` exacto, Inspector numérico en mm, objeto con matriz (rotado/escalado) editado correctamente
  en espacio local, línea abierta de S04, rendimiento con un path de ≥ 5 000 nodos (sin umbrales frágiles).
  Mocks de `fetch` con `AbortSignal`; StrictMode.
- Verificación: `npm test`, `npm run build`, `npm run lint` (sin errores nuevos), `dotnet build` (backend/Python sin cambios).

## DoD
Se puede entrar en modo Path sobre un objeto, mover anchors y handles, añadir y eliminar nodos, cambiar tipo de nodo y
cerrar/abrir subpaths con precisión; cada gesto es un comando; la geometría nunca se corrompe y siempre se puede volver al
estado anterior.
