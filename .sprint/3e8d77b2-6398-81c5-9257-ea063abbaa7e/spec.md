# spec.md — M3-S02 · Crop + Rotate + Flip

> Lee primero `docs/ADR_EDITOR_MVP3.md` y el `IMPL.md` de M3-S01 (`.sprint/3c1d77b2-6398-8167-977a-f44248e874b1/`):
> reusás `lib/editor/*` (matrices, bounds, transform, pathGeometry), `useEditableDocument` (`applyEdit`, gestos,
> undo/redo, locks) y el Inspector de objetos. No dupliques lógica: extendé.

## Contexto
Criterio (Notion): "Crop, rotate y flip funcionan sobre el documento/selección definida, muestran preview y no
destruyen el original ni estados anteriores." DoD: "Las transformaciones son predecibles y el usuario siempre
sabe qué se modificará antes de Apply." Reversibilidad: toda aplicación es un comando undoable.

## Decisión de dominio (documentala en IMPL.md y en el panel: la tarjeta pide NO mezclar comportamientos)
1. **Crop modifica el ÁREA DE TRABAJO del documento vectorial** (`DocumentFrame`: origen + ancho/alto en
   unidades de documento, y sus mm), **no** el raster fuente ni los assets originales (inmutables; el original
   nunca se toca). La escala física se **conserva** (`mmPerUnit` no cambia): recortar de 200×100 mm a 100×100 mm
   deja los objetos en su tamaño real.
2. **Objetos y recorte**: los objetos **totalmente fuera** del nuevo marco se eliminan **solo si** el usuario deja
   marcada la opción "Eliminar objetos fuera del área" (default: marcada); los que **cruzan el borde se conservan
   sin recortar** (el recorte geométrico real necesita la booleana Intersect de M3-S08) y el panel lo advierte:
   "N objetos cruzan el borde; seguirán completos (recorte exacto: operación Intersect, M3-S08)". Nada se
   recorta "en silencio".
3. **Rotate/Flip**: si hay **selección** → se aplican a los objetos seleccionados alrededor del centro de su
   bbox (reusa `rotateAbout`/matrices de S01); si **no hay selección** → se aplican al **documento completo**
   (todos los objetos + el marco). Rotate = **90° horario/antihorario** (el ángulo libre ya existe en el
   Inspector/Transformer de S01: no se duplica). Flip = horizontal/vertical (reflejo exacto con `matrix`).
   Rotar el documento 90° **intercambia** ancho/alto del marco (y de mm) y reubica el origen.
   **Documento completo con capas bloqueadas**: se rechaza con mensaje claro ("Desbloqueá las capas para
   transformar el documento completo, o seleccioná objetos") — nunca se transforma a medias.

## Alcance

### 1. Modelo: `DocumentFrame` y extensión de comandos (`lib/editor`, `useEditableDocument`)
- `DocumentFrame { x, y, width, height }` (unidades de documento = viewBox) y su derivación a mm
  (`widthMm = width * mmPerUnit`). Estado inicial = viewBox del documento cargado. Helpers puros en
  `lib/editor/frame.ts`: `cropFrame`, `rotateFrame90`, `objectsRelativeToFrame(objects, frame)` →
  `{inside, outside, crossing}` (bbox, con tolerancia), `fitToContent`.
- `EditorEdit` (S01) se extiende con un cambio **opcional** de marco: `{ frame?: {before, after} }`, de modo
  que crop y rotate-documento sean **un solo comando** (objetos + marco) con undo/redo atómico. `geometryDirty`
  también se activa por cambios de marco. Compatibilidad: los comandos de S01 siguen igual (sin `frame`).
- Round-trip: el marco se serializa/deserializa (`viewBox`, mm) sin pérdida; test.

### 2. Flujo contextual Apply/Cancel (herramienta Crop; barra contextual para Rotate/Flip)
- **Crop**: al activar la herramienta aparece un marco editable sobre el canvas (Konva `Rect` +
  `Transformer`, el exterior atenuado), con handles, arrastre y flechas; panel contextual con X/Y/ancho/alto en
  **mm**, **bloqueo de proporción**, presets (1:1, 4:3, 16:9, "Ajustar al contenido", "Restablecer"), checkbox de
  eliminar-fuera, y un **resumen "Qué se va a modificar"** en vivo (área de trabajo A×B → C×D mm; N objetos se
  eliminarán; M cruzan el borde; K bloqueados no se eliminan). Botones **Apply** (Enter) y **Cancel** (Escape).
  Marco inválido (≤ 0, fuera de límites razonables, sin contenido que lo justifique no es error) se rechaza con
  mensaje. Durante Crop el resto de herramientas/atajos de edición de objetos quedan suspendidos.
- **Rotate 90° ⟲/⟳ y Flip H/V**: botones en una barra contextual (visible con la herramienta Select/Move y con
  atajos documentados) que muestran el **preview** (gesto de S01: `beginGesture/previewEdit`) y piden
  Apply/Cancel antes de confirmar; el texto dice explícitamente el alcance ("Se rotará la selección (N objetos)"
  / "Se rotará TODO el documento"). Rotate/flip repetidos antes de Apply se componen sobre el estado original
  (sin acumular error).
- Capas bloqueadas/ocultas: se respetan igual que en S01 (se informa cuántos objetos se omitieron).
- El toolbar habilita `Crop`; el resto de herramientas sigue deshabilitado.

### 3. Canvas/Preview/StatusBar
`VectorCanvas`, `PreviewNavigator`, `EditorStatusBar` y el cálculo de zoom/centrado usan el `DocumentFrame`
vigente (no el viewBox original fijo): tras un crop el documento se re-centra y las dimensiones mm mostradas
cambian. Un crop deshecho vuelve exactamente al estado anterior.

### 4. Guardado honesto
Igual que S01: cambios de marco/geometría ⇒ `geometryDirty` ("Cambios de geometría sin guardar"). La persistencia
del marco llega con la de geometría (M3-S13); dejá el TODO(M3-S13) existente cubriendo el marco.

## Fuera de alcance
Recorte geométrico exacto de paths (booleana, S08), crop del raster fuente/original, rotación libre del documento
completo, presets personalizados guardados, persistencia (S13).

## Tests exigidos
- `lib/editor/frame.ts`: crop dentro/fuera de bounds, clasificación inside/outside/crossing (bordes exactos, objetos
  que tocan el borde), mm conservados, `rotateFrame90` (4 giros = identidad exacta), fit-to-content, límites.
- Comandos: crop (objetos + marco) = un comando; undo/redo restauran marco y objetos; rotate/flip de selección y
  de documento (con y sin capas bloqueadas), multi-capa, flip dos veces = identidad, rotate 90 ×4 = identidad,
  preview sin llenar la pila, Cancel no deja rastro.
- Componentes: panel de Crop (aspect lock, presets, resumen en vivo, Apply/Cancel por teclado, validación),
  barra de Rotate/Flip con alcance explícito, re-centrado tras crop, dimensiones mm.
- Round-trip del marco. Mocks de `fetch` con `AbortSignal`.
- Verificación: `npm test`, `npm run build`, `npm run lint` (sin errores nuevos), `dotnet build`.

## DoD
Crop/Rotate/Flip funcionan sobre selección o documento, muestran preview y un resumen de lo que se modificará,
se aplican o cancelan, se deshacen/rehacen como un solo comando y nunca tocan el original.
