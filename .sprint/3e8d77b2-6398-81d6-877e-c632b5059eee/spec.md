# spec.md — M3-S07 · Align / Distribute / Z-order

> Lee primero `docs/ADR_EDITOR_MVP3.md` y los `IMPL.md` de M3-S01..S06 (`.sprint/<card_id>/IMPL.md`; en particular S01
> `3c1d77b2-6398-8167-…`, S02 `3e8d77b2-6398-81c5-…` para el marco del documento, y S06 `3e8d77b2-6398-81df-…` para el patrón
> de acciones atómicas con atajos y barra). Reusás `lib/editor/{objects,transform,selection,frame,units}.ts`,
> `useEditableDocument` (`applyEdit`, undo/redo, locks, capas efectivas), el manejador de atajos de S06 y el Inspector.

## Contexto
Criterio (Notion): "Align/Distribute y bring forward/back funcionan sobre selecciones válidas y mantienen geometría, layer e
IDs coherentes." Reglas: **Z-order no debe mover silenciosamente un objeto a otro Layer**; definir la referencia de alineación
(selección/bounds/documento); distribuir requiere 3+ objetos; z-order "dentro del scope permitido". DoD: "Operaciones
espaciales son precisas y previsibles."

## Decisiones (documentalas en IMPL.md y en la UI)
1. **Referencia de alineación** (selector visible, default "Selección"):
   - *Selección*: bounds de la unión de los objetos movibles seleccionados (requiere ≥ 2 objetos movibles);
   - *Documento*: el **marco vigente** (`DocumentFrame` de S02), también con 1 objeto.
   Alinear: izquierda, centro horizontal, derecha, arriba, centro vertical (middle), abajo. Se opera sobre los **bounds
   geométricos exactos** del objeto (curvas incluidas, con su `matrix`; el ancho de trazo **no** cuenta — documentado).
2. **Distribuir** (≥ 3 objetos movibles): **espaciado horizontal** y **vertical iguales** (huecos iguales entre bounds
   consecutivos): los dos objetos extremos quedan fijos y los intermedios se reubican; el orden se determina por posición
   (desempate estable por orden de pintado/id). Si los objetos se solapan y el hueco total es negativo, se distribuye igual
   (huecos negativos iguales) y se informa. < 3 ⇒ acción deshabilitada con motivo.
3. **Objetos bloqueados**: los de capas bloqueadas se **excluyen por completo** (no se mueven **ni** cuentan para la
   referencia de selección ni para el cálculo de huecos); se informa "N objetos bloqueados omitidos". Ninguna operación
   modifica una capa bloqueada ni oculta.
4. **Z-order**: *Traer adelante*, *Enviar atrás*, *Traer al frente*, *Enviar al fondo*, **siempre dentro de la capa de cada
   objeto** (el orden de pintado entre capas lo define el orden de capas del panel; esta tarjeta **no** lo toca ni mueve un
   objeto a otra capa — test explícito). Con selección en varias capas, cada capa se procesa por separado y en un solo
   comando. Adelante/atrás mueven el bloque seleccionado **un paso** respecto del vecino **no seleccionado** más cercano en la
   misma capa; frente/fondo lo llevan al extremo conservando el **orden relativo** entre los seleccionados. Si ya está en el
   límite ⇒ sin comando (y el botón lo indica). Los `id` y el contenido no cambian.
5. **Precisión y comandos**: alinear/distribuir se expresan como **traslaciones** (se compone la `matrix`; no se hornea ni
   se toca `d`); exactos en unidades de documento (sin redondeo; tolerancia de test 1e-9). Una operación = **un comando**
   (`applyEdit`, etiqueta legible: "Alinear a la izquierda", "Distribuir horizontalmente", "Traer al frente"); si nada se mueve
   (ya alineado) ⇒ **sin comando** y mensaje "Ya está alineado". Undo/redo exactos; la selección se conserva.

## Alcance técnico
- `lib/editor/arrange.ts` (puro): `alignProduction(objects, {mode, reference, frame})`, `distributeProduction(objects,
  {axis})`, `zOrderProduction(document, selection, {action})` + resúmenes `{moved, skippedLocked, noop, reason}`; reusa
  `bounds`/`translate` de S01 y los helpers de mm de `units`. Sin dependencias del DOM.
- UI: barra/sección "Organizar" (en el Inspector de objetos o junto a `ClipboardBar`): 6 botones de alineación (con iconos y
  `aria-label`), 2 de distribución, 4 de orden, selector de referencia; estados deshabilitados con el motivo en tooltip
  (sin selección, 1 objeto sin referencia documento, < 3 para distribuir, todo bloqueado, ya en el límite). Atajos de z-order
  con las convenciones habituales: Ctrl/Cmd+] adelante, Ctrl/Cmd+[ atrás, Ctrl/Cmd+Shift+] frente, Ctrl/Cmd+Shift+[ fondo
  (mismo manejador y reglas de no-pisar-inputs que S06); documentados en el panel "Atajos". Mensajes en `role="status"`/`alert`.
- Orden de pintado: el modelo ya pinta por orden del array de cada capa (`objectsByLayer[layer]`): z-order = permutar ese
  array dentro de la capa; confirmá que render, hit-test (el de más arriba gana) y miniatura respetan el nuevo orden.

## Fuera de alcance
Alinear a un objeto clave, alinear al pivote, distribución por centros o con valor numérico, guías/snapping, reordenar capas
(panel de capas existente), agrupación, persistencia (S13).

## Tests exigidos
- `lib/editor/arrange.ts` con valores calculados a mano: los 6 modos de alineación con **2 y 3+ objetos de tamaños distintos**,
  referencia selección vs. documento (marco recortado/rotado de S02), objetos con matriz (rotados/escalados) y con curvas (bounds
  exactos), distribución horizontal/vertical con tamaños distintos, solapados y desempate estable, < 3 ⇒ rechazo, objetos
  bloqueados excluidos de la referencia y de los huecos, ya-alineado ⇒ sin comando, multi-capa, z-order: cada acción con
  selección única y múltiple (orden relativo conservado), vecinos **no seleccionados**, límite ⇒ no-op, varias capas procesadas
  por separado, **ningún objeto cambia de capa** (afirmar `layerGroupId`/pertenencia en cada caso) y ids intactos, capa bloqueada.
- Shell/UI: un comando por operación (la pila de undo crece exactamente 1; 0 si no hay cambio), undo/redo exactos con selección
  conservada, botones y tooltips de deshabilitado, atajos Ctrl y Cmd (no dentro de inputs), render/hit-test/miniatura con el
  nuevo orden, mensajes de omitidos. StrictMode; mocks de `fetch` con `AbortSignal`.
- La suite existente (S01–S06) debe seguir verde.
- Verificación: `npm test`, `npm run build`, `npm run lint` (sin errores nuevos), `dotnet build` (backend/Python sin cambios).

## DoD
Alinear (6 modos, selección o documento), distribuir (≥ 3) y reordenar (4 acciones, siempre dentro de la capa) son precisos,
atómicos y reversibles, respetan locks y nunca cambian un objeto de capa ni sus ids.
