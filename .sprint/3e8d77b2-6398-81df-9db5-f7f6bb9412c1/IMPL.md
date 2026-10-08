# IMPL.md — M3-S06 · Copy / Paste / Duplicate / Delete

## Resumen
Copiar, cortar, pegar (con offset, en el lugar, en la capa activa), duplicar y eliminar, con ids nuevos, capa correcta,
locks respetados y un comando undoable por operación. Solo frontend. Spec: `spec.md`.

## Decisiones
- **Portapapeles interno de la sesión** (no el del SO): copia profunda, congelada y **sin ids** (`d`, `fill`, `stroke`,
  `strokeWidth`, `matrix`, capa de origen, posición relativa). Copiar no es comando ni activa `geometryDirty`. Se vacía al
  cambiar de documento (y no reaparece al volver).
- **Offset de pegado 5 mm** (sin escala física, 5 unidades) hacia abajo-derecha, **acumulativo** (1×, 2×, 3×) y reiniciado al
  copiar/cortar de nuevo; Pegar en el lugar no usa offset ni adelanta el contador; Duplicar usa siempre 1× sin tocar el
  portapapeles y, repetido, repite el delta.
- **Capa destino**: la de origen si existe, es visible, está desbloqueada y cargada; si no, el objeto se **omite con motivo**
  (nunca se pega en silencio en otra capa); nada pegable ⇒ rechazo sin comando. *Pegar en la capa activa* (Ctrl/Cmd+Alt+V)
  reasigna al color de esa capa (reusa S03); si la capa de origen cambió de color desde que se copió, lo pegado toma el color actual.
- Operación atómica; los nuevos objetos van encima en su capa y pasan a ser la selección. Compound paths íntegros.

## Entregado
- `lib/editor/clipboard.ts` (puro: `buildClipboard`, `planPaste`/`planDuplicate`/`planDelete`/`planCut`, `pasteOffset`,
  atajos Ctrl/Cmd, resúmenes de omitidos), `hooks/useClipboard.ts`, `ClipboardBar.tsx` (Copiar/Cortar/Pegar/Pegar en el
  lugar/Pegar en la capa activa/Duplicar/Eliminar con `aria-keyshortcuts`, motivo del deshabilitado en el tooltip, panel "Atajos").
- `EditorShell`: acciones, atajo global de ventana (solo con Select/Move, no dispara en inputs ni con auto-repetición),
  selección coherente en undo/redo (asociada al comando). El Delete de S01 se refactorizó al mismo `planDelete`
  (etiqueta ahora cuenta lo realmente eliminado).
- `ApplyEditResult` gana `edit?` (aditivo; el spec decía "sin cambios de contrato" pero hace falta para restaurar la selección).

## Hallazgos
El aviso de portapapeles seguía visible al cambiar de documento (corregido); `useVectorDocument.toggleVisibility` hace
rollback optimista si el POST falla; `EditorLayerNodes` no asigna `id` a los nodos Konva (los tests leen `data-vid`).
En macOS Option+V devuelve "√" en `key`: el atajo se reconoce por `code: KeyV`.

## Verificación (orquestador)
`npm test` 1738/1738 · `npm run build` limpio · `npm run lint` 0 errores · `dotnet build` 0/0. 57 mutaciones del
implementador, todas detectadas salvo una equivalente (`finiteOrZero`, defensa en profundidad). No se ejercitó con la UI
real en un navegador (jsdom).
