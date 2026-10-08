# spec.md — M3-S06 · Operaciones básicas: Copy / Paste / Duplicate / Delete

> Lee primero `docs/ADR_EDITOR_MVP3.md` y los `IMPL.md` de M3-S01..S05 (`.sprint/<card_id>/IMPL.md`; en particular S01
> `3c1d77b2-6398-8167-…`, S03 `3e8d77b2-6398-81ac-…` para mover objetos entre capas y S04 `3e8d77b2-6398-8102-…` para
> `stroke`). Reusás `useEditableDocument` (`applyEdit`, undo/redo, locks, capas efectivas), `lib/editor/{selection,
> objects,colors,layers,types}.ts`, el atajo de teclado global de S01 (undo/redo) y el Inspector de objetos.

## Contexto
Criterio (Notion): "Copy, Paste, Duplicate y Delete funcionan con selección simple/múltiple, IDs nuevos cuando corresponde,
layer correcto y Undo/Redo." Reglas: shortcuts documentados; **Paste/Duplicate crean IDs nuevos** (nunca clonar IDs
persistentes) y conservan la relación con la capa; posición con **offset visual predecible** o paste-in-place según la acción;
**no modificar objetos de capas bloqueadas**. DoD: "El flujo básico de edición no obliga a recrear geometría manualmente."

## Decisiones (documentalas en IMPL.md y en la UI)
1. **Portapapeles interno de la sesión del editor** (no el del sistema operativo): guarda copias *profundas e inmutables* de
   los objetos (`d`, `fill`, `stroke`, `strokeWidth`, `matrix`), el `layerGroupId` de origen y la posición relativa de cada
   uno respecto del conjunto. **No guarda ids** (se generan nuevos al pegar con `createId`). Sobrevive a cambios de selección
   y a ediciones posteriores del original (no se ve afectado por mutaciones: es una copia); se vacía al cambiar de
   documento/proyecto. Copiar no modifica nada (no es comando, no entra en undo, no activa `geometryDirty`).
2. **Acciones y atajos** (con el canvas enfocado o a nivel de ventana sin pisar inputs de texto, como undo/redo de S01;
   Ctrl en Windows/Linux, Cmd en macOS):
   | Acción | Atajo | Comportamiento |
   |---|---|---|
   | Copiar | Ctrl/Cmd+C | guarda la selección (solo objetos editables; incluye los de capas bloqueadas: copiar es lectura) |
   | Cortar | Ctrl/Cmd+X | copiar + eliminar (solo lo desbloqueado; lo bloqueado no se corta y se informa) |
   | Pegar | Ctrl/Cmd+V | pega **desplazado** (offset predecible, ver 3) en la capa de origen de cada objeto |
   | Pegar en el lugar | Ctrl/Cmd+Shift+V | misma posición exacta |
   | Pegar en la capa activa | Ctrl/Cmd+Alt+V | todos los objetos van a la capa activa (copia entre capas); toman el color de esa capa |
   | Duplicar | Ctrl/Cmd+D | copia + pega inmediata desplazada, sin tocar el portapapeles |
   | Eliminar | Delete / Backspace | elimina la selección (lo bloqueado se omite y se informa) |
   Lista de atajos visible en la UI (tooltips de los botones + un panel/diálogo "Atajos" o la ayuda del Inspector),
   y botones Copiar/Cortar/Pegar/Duplicar/Eliminar en el Inspector de objetos y/o barra del editor con estado
   deshabilitado correcto (sin selección, portapapeles vacío, solo bloqueados).
3. **Posición**: offset de pegado = **5 mm** en x e y (en unidades de documento vía `mmPerUnit`; si no hay escala física,
   5 unidades) hacia abajo-derecha en pantalla. Pegados consecutivos **acumulan** el offset (1×, 2×, 3×…) para no apilarse
   en el mismo lugar; el contador se reinicia al copiar de nuevo. **Duplicar repetido** (Ctrl+D varias veces seguidas sobre la
   selección resultante) repite el mismo delta desde el último duplicado ("step and repeat" simple), documentado. Paste en el
   lugar no usa offset.
4. **Capa destino y bloqueos**: cada objeto pegado va a su capa de origen **si existe, es visible y no está bloqueada**; si no,
   no se pega *en silencio en otro lado*: se informa "N objetos no se pegaron (capa «X» bloqueada/oculta/eliminada)" y el
   usuario puede usar *Pegar en la capa activa*. Si **ningún** objeto puede pegarse ⇒ rechazo claro, sin comando. La
   operación aplica solo a lo permitido y es **atómica** (un comando con todo lo pegado).
5. **Orden de pintado y selección resultante**: los objetos nuevos se agregan **encima** (al final) de su capa conservando el
   orden relativo entre ellos; tras pegar/duplicar la selección pasa a ser **los objetos nuevos** (los originales se
   deseleccionan). Delete/Cut limpian la selección.
6. **Compound paths** (un objeto con varios subpaths y huecos): se copian como **un solo objeto** íntegro (sin partirlo), con
   su winding/huecos intactos. Objetos con `matrix`, `stroke`, `fill:"none"` y los de capas `isNew` se copian fielmente.

## Alcance técnico
- `lib/editor/clipboard.ts` (puro): `buildClipboard(selection, document, …)`, `planPaste(clipboard, document, {mode, offset,
  activeLayerId, layers})` ⇒ producción (`EditProduction`) + resumen `{pasted, skipped:[{reason, count}]}`, `planDuplicate`,
  `planDelete`, `pasteOffset(count, mmPerUnit)`, generación de ids con `createId` inyectable (testeable). Reusa los
  mecanismos de S03 para asignar la capa/color al pegar en otra capa.
- `useEditableDocument`: sin cambios de contrato (todo es `applyEdit` con una producción). Si hace falta un helper para
  "estado del portapapeles + contador de offset", un hook `useClipboard` (estado en el shell, reseteo al cambiar de documento).
- UI: manejador de atajos (reutilizá el de undo/redo), botones, hints de "N objetos no se pegaron", etiquetas de comando
  legibles ("Pegar 3 objetos", "Duplicar", "Eliminar 2 objetos").
- Accesibilidad: botones con `aria-label` + atajo anunciado; mensajes en `role="status"`/`alert`.

## Fuera de alcance
Portapapeles del sistema (copiar/pegar SVG entre aplicaciones), pegar imágenes, arrastrar-con-Alt para duplicar, menú
contextual con clic derecho, copiar entre proyectos/documentos, persistencia (S13), historial como panel (S12).

## Tests exigidos
- `lib/editor/clipboard.ts` con valores calculados a mano: copia profunda (mutar el original después de copiar no cambia el
  portapapeles), **ids nuevos y únicos** (ningún id repetido con el original ni entre pegados repetidos), offset acumulado
  (1×, 2×, 3×) y reinicio al volver a copiar, paste-in-place exacto, duplicar repetido (delta constante), capa de origen
  respetada, capa de origen bloqueada/oculta/eliminada ⇒ omitido con motivo, nada pegable ⇒ rechazo, pegar en la capa activa
  (color de la capa destino), compound path íntegro, objetos con matriz/stroke/`isNew`, selección simple y múltiple, orden
  relativo/z-order, Cut con mezcla bloqueado/desbloqueado, Delete que omite bloqueados.
- Shell/hook/UI: atajos (Ctrl y Cmd; no se disparan dentro de inputs), botones y estados deshabilitados, un comando por
  operación (la pila de undo crece exactamente 1), **undo/redo exactos** (objetos y selección coherente), `geometryDirty`
  solo cuando corresponde (Copiar no lo activa), mensajes de omitidos, StrictMode, mocks de `fetch` con `AbortSignal`.
- La suite existente (S01–S05) debe seguir verde (el Delete de S01 se refactoriza al módulo nuevo sin cambiar su comportamiento
  observable salvo las mejoras descritas).
- Verificación: `npm test`, `npm run build`, `npm run lint` (sin errores nuevos), `dotnet build` (backend/Python sin cambios).

## DoD
Copiar, cortar, pegar (con offset y en el lugar), duplicar y eliminar funcionan con selección simple/múltiple, siempre con ids
nuevos, en la capa correcta (o con aviso explícito), respetando locks, como un comando undoable cada uno y con atajos
documentados.
