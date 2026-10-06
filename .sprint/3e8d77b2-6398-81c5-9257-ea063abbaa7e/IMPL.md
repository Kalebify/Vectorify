# IMPL.md — M3-S02 · Crop + Rotate + Flip

## Resumen
Crop del área de trabajo, Rotate 90° y Flip de selección o documento, con flujo Apply/Cancel, preview y
resumen de lo que se modificará. Solo frontend. Spec: `spec.md`; arquitectura: `docs/ADR_EDITOR_MVP3.md`.

## Decisión de dominio (la tarjeta pide documentarla)
- **Crop modifica el ÁREA DE TRABAJO** (`DocumentFrame`: origen + ancho/alto en unidades de documento), no el
  raster fuente ni los assets (inmutables). La escala física (mm por unidad) se **conserva**.
- Objetos **totalmente fuera** del marco se eliminan solo con la opción "Eliminar objetos fuera del área"
  (default marcada, se recuerda); los que **cruzan el borde se conservan sin recortar** y el panel lo advierte
  (recorte exacto = Intersect, M3-S08). Objetos de capas bloqueadas no se eliminan; las capas ocultas tampoco
  (se informa).
- **Rotate/Flip**: con selección → sobre los objetos seleccionables (pivote = centro de su bbox); sin selección
  → **documento completo**. Con capas bloqueadas el documento completo se rechaza ("Desbloqueá las capas…").
  Rotación libre ya existe en S01 (Inspector/Transformer).

## Entregado
- `lib/editor/frame.ts` (marco, validación, clasificación inside/outside/crossing con bbox exacto de curvas,
  fit-to-content, aspect, `summarizeCrop`, `cropProduction`, `orientDocumentProduction`, (de)serialización del
  marco con viewBox + mm), `lib/editor/orientation.ts` (las 8 simetrías del cuadrado con coeficientes enteros:
  4 giros y 2 reflejos = identidad **exacta**), `flipAboutMatrix`.
- `EditorEdit` gana `frame?: {before, after}` (opcional, retrocompatible): crop y rotar-documento son **un solo
  comando** con undo/redo atómico; `geometryDirty` también se activa por cambios de marco.
- `useEditableDocument` posee el marco (`frame`, `committedFrame`, `sourceSize`); producciones `documentWide`
  rechazan todo si hay una capa tocada bloqueada.
- UI: `CropPanel` (X/Y/ancho/alto en mm, aspect lock, presets 1:1/4:3/16:9/ajustar al contenido/restablecer,
  resumen "Qué se va a modificar", Apply=Enter, Cancel=Escape), `OrientationBar` (Rotar ⟲⟳, Reflejar H/V con
  alcance explícito y Apply/Cancel), overlay de Crop en el canvas (marco con Transformer, exterior atenuado),
  atajos R/Shift+R/F/Shift+F, canvas/status bar/miniatura con el marco vigente (re-centrado tras crop).

## Decisiones menores / desviaciones
- Crop puede agrandar el área de trabajo (si no, "Ajustar al contenido" fallaría con contenido fuera de la hoja).
- Rotar el documento 90° pivota en el centro del marco y **no** normaliza el origen a (0,0) (puede quedar un
  viewBox con origen ≠ 0; el serializador lo soporta).
- Rotar/reflejar el documento completo **incluye capas ocultas** (si no, quedarían descolocadas al mostrarlas);
  Crop respeta las ocultas (no las elimina, lo informa).
- Cambiar de herramienta con una transformación pendiente la cancela sin rastro; Apply re-evalúa locks/visibilidad.

## Hallazgos
- `multiplyMatrices` puede producir `-0` (inofensivo; el álgebra de orientación lo normaliza).
- La identidad exacta de "×4" es estructural dentro de un preview; con 4 comandos separados es exacta para
  valores diádicos y puede derivar 1 ulp con coordenadas arbitrarias (aritmética del pivote).
- Preexistente: el título de Pan dice "o H" pero la tecla H no está implementada.

## Verificación (orquestador)
`npm test` 910/910 · `npm run build` limpio · `npm run lint` 0 errores · `dotnet build` 0/0. El implementador
verificó con 18 mutaciones (17 detectadas; la restante es un mutante equivalente = defensa en profundidad).
