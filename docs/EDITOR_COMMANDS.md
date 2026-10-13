# Comandos del editor, historial y ejecutor declarativo (M3-S12)

Referencia de `EditorCommand` v1: la descripción **serializable** de cada operación mutante del editor de MVP 3, el historial de sesión que las
registra (Undo / Redo / `jumpTo`) y el ejecutor declarativo con el que MVP 4 (IA) emitirá los **mismos** comandos sin tocar el SVG. Decisión de
arquitectura: `docs/ADR_EDITOR_MVP3.md` (D2). Código: `frontend/src/lib/editor/{commands,commandDrafts,commandExecutor,operations}.ts`,
`frontend/src/hooks/useEditableDocument.ts`, `frontend/src/components/editor/{HistoryPanel,EditorHeader,EditorShell}.tsx`.

> Esta tarjeta es **solo frontend**: no hay endpoint de historial ni cambios en ASP.NET Core / Python. La validación de comandos de IA en el servidor
> y la persistencia del historial entre sesiones son de MVP 4 / M3-S13.

## 1. Modelo: `HistoryEntry = { command, patch }`

Cada entrada del historial son **dos cosas con roles distintos**:

| Parte | Qué es | Para qué sirve |
| --- | --- | --- |
| `command` | `EditorCommand` v1, JSON puro, **sin `d` ni SVG** | Describir qué se hizo: historial visible, exportable, revisable, y lo que emite/recibe una IA. |
| `patch` | `EditorEdit` interno de S01–S03 (snapshots inmutables `before/after` de objetos por capa, marco, estructura de capas o metadata de capa) | La **reversión exacta**. El motor de snapshots **no cambió**: el comando describe, el parche revierte. |

### `EditorCommand` v1

```json
{
  "version": 1,
  "id": "6f1c…",
  "sequence": 12,
  "type": "object.move",
  "label": "Mover 2 objetos",
  "targets": { "layerIds": ["aaaa…", "bbbb…"], "objectIds": ["r1", "b1"] },
  "parameters": { "dx": 5, "dy": -3, "objectCount": 2 },
  "origin": "user",
  "timestamp": 1760195432123
}
```

- `version`: siempre `1`. `id`: único (UUID por defecto). `sequence`: crece de a uno dentro de la sesión (no se reutiliza al descartar una rama de rehacer).
  `timestamp`: milisegundos desde la época (reloj inyectable en tests).
- `type`: del **registro cerrado** (`COMMAND_TYPES`, 44 tipos). Un tipo desconocido es un error de programación: `applyEdit` / `commitGesture` lanzan
  `InvalidCommandError` **antes** de tocar el documento (en producción solo se descartan los *parámetros* inválidos; el tipo siempre se exige).
- `label`: la que aporta el call-site (con conteos: «Mover 2 objetos») o, si falta, la etiqueta por defecto del registro (español).
- `targets`: **lo que el parche realmente cambió** (objetos agregados / quitados / modificados por contenido; capas tocadas, creadas o de metadata), salvo
  que el call-site los pida explícitamente. `objectIds` se acota a 500; el conteo exacto viaja en `parameters.objectCount`.
- `parameters`: números, enums, ids y textos cortos (≤ 200 caracteres), validados contra el esquema del tipo. **Nunca** `d`, SVG, puntos, matrices ni
  `transform` (ni como clave ni como valor): `findRawGeometry` lo comprueba en cualquier profundidad y `checkDraft` lo rechaza en desarrollo.
  El historial agrega dos parámetros **reservados**, calculados desde el parche: `objectCount` (objetos afectados) y `createdLayerIds` (capas que el comando
  crea, p. ej. Fill con un color nuevo). El ejecutor los rechaza como entrada.
- `origin`: `"user"` (UI, por defecto), `"ai"` (ejecutor, por defecto) o `"system"`.

### Auditoría de call-sites (cobertura total)

Cada `applyEdit(draft, producer)` y `commitGesture(draft)` **exige** un `CommandDraft` (`{ type, label?, targets?, parameters?, origin? }`): el tipo del
compilador impide llamarlos con un `string`, y `checkDraft` lo verifica también en ejecución. Call-sites y tipos que emiten:

| Call-site | Tipo(s) de comando |
| --- | --- |
| `VectorCanvas` — arrastre (`commitGesture`) | `object.move` (parámetros `dx`, `dy` del último frame) |
| `VectorCanvas` — handles del Transformer (`applyEdit`) | `object.scale` (`sx`, `sy`) / `object.rotate` (`degrees`) |
| `VectorCanvas` — flechas (`applyEdit` + `coalesceKey`) | `object.nudge` (una ráfaga = UN comando con `dx`/`dy` acumulados) |
| `VectorCanvas` — Suprimir sin shell (`applyEdit`) | `object.delete` |
| `EditorShell` — Inspector numérico | `object.setBounds` (`x`, `y`, `width`, `height`) / `object.rotate` (`degrees` relativos) |
| `EditorShell` — Rotar / Reflejar (`commitGesture`) | `selection.rotate` · `selection.flip` · `document.rotate` · `document.flip` (`quarterTurns`, `axis`) |
| `EditorShell` — Crop | `document.crop` (`x`, `y`, `width`, `height`, `removeOutside`) |
| `EditorShell` — portapapeles (`applyClipboardEdit`) | `object.cut` · `object.delete` · `object.paste` · `object.pasteInPlace` · `object.pasteToLayer` · `object.duplicate` |
| `EditorShell` — Fill / Color (`commitColor`) | `object.fill` · `object.recolor` · `object.merge` (vía `colorDraft`) |
| `EditorShell` — Organizar | `arrange.align` · `arrange.distribute` · `arrange.zorder` (vía `arrangeDraft`) |
| `EditorShell` — booleanas / offset | `geometry.boolean` · `geometry.offset` |
| `useCutTool` / `useFloatingTool` | `geometry.split` · `geometry.bridge` |
| `useDrawEraseTools` | `object.draw` · `object.erase.objects` · `object.erase.subtract` |
| `usePathTool` (`runEdit` + gesto de arrastre) | `path.moveAnchors` · `path.moveHandle` · `path.addNode` · `path.deleteNodes` · `path.setNodeKind` · `path.toggleSegment` · `path.closeSubpath` · `path.openSubpath` · `path.setNodeCoords` |
| `EditorShell` — metadata de capa (`commitLayerMeta`) | `layer.rename` · `layer.setVisible` · `layer.setLocked` · `layer.setOperation` · `layer.reorder` |
| Ejecutor declarativo | `layer.create` (la creación de capa también viaja implícita dentro de Fill / Draw / booleanas / offset: `parameters.createdLayerIds`) |

Un test (`commandCoverage.test.ts`) **falla** si aparece un `applyEdit` / `commitGesture` / `runEdit` sin `CommandDraft`, si un literal de tipo no está en el
registro, si un tipo del registro no tiene emisor en el código o no lo afirma ninguna prueba de ruta real, o si este documento no menciona un tipo o un parámetro.

## 2. Historial en `useEditableDocument`

- **Granularidad.** Un arrastre completo es UN comando (el gesto `beginGesture → previewEdit × N → commitGesture` no toca la pila hasta soltar). Un gesto de
  edición de nodo es UN comando. Nunca una entrada por frame. Ráfagas de flechas (misma `coalesceKey`, misma selección, mismo tipo, dentro de 1 s) se
  funden en un solo comando con `parameters.dx/dy` acumulados; si ir y volver deja el objeto en su sitio, el comando se descarta. Un comando que cambia la
  estructura de capas nunca se funde.
- **API.** `undo()` / `redo()` (síncronos para la geometría; devuelven el parche), `jumpTo(entryId | null)` (deshace o rehace varios pasos de una vez;
  `null` = estado inicial), `canUndo` / `canRedo`, `undoLabel` / `redoLabel` / `undoCommand` / `redoCommand`, `historyEntries` (`{ command, applied }`,
  cronológico: primero lo aplicado y después la rama de rehacer), `historyPosition`, `clearHistory()`, `exportHistory()`, `historyLimit`, `historyBusy`,
  `historyError`, `historyNotices`.
- **Una acción nueva tras un undo descarta la rama de rehacer.** Un `applyEdit` rechazado (capa bloqueada / oculta, sin cambios) **no** registra comando; un
  `producer` que lanza no corrompe la pila (el comando se arma antes de confirmar nada).
- **`exportHistory()`** devuelve `{ version: 1, position, commands }`: solo los comandos (JSON puro), sin parches, snapshots ni SVG. `parseHistoryExport` /
  `parseCommand` los validan al leerlos.
- **Límite** (200 por defecto, `limit` / prop `historyLimit`): al desbordar se descarta el más viejo y el panel **avisa una vez** («El historial guarda las
  últimas N acciones: se descartaron las K más antiguas…»). Aunque la pila ya no llegue al origen, `geometryDirty` sigue siendo verdadero.
- **Alcance del «reload».** El historial es **de sesión y vive en memoria**: un reload o cerrar la pestaña lo pierde (la persistencia de versiones entre
  sesiones es M3-S13). Se **reinicia con aviso visible** cuando (a) cambia el `svgUrl` de una capa ya cargada (el documento se regeneró por debajo, p. ej.
  tras el primer guardado: se descartan también las ediciones sin guardar, comportamiento de S03) y (b) se abre otro documento (proyecto / imagen / paleta).
  `beforeunload` y `geometryDirty` de S01 siguen avisando de ediciones sin guardar. El panel lo dice: «El historial dura mientras la sesión esté abierta».

## 3. Metadata de capa dentro del historial (PATCH inverso)

Renombrar, bloquear / desbloquear, mostrar / ocultar, cambiar la operación de fabricación y reordenar capas entran al historial como comandos **sin objetos**
(`touched: {}` + `EditorEdit.meta`). `Isolate` y los demás estados de vista **no** son comandos.

- **Un solo camino de escritura:** `applyLayerMeta` (en `EditorShell`) para el cambio original **y** para deshacer / rehacer.
  - Capa creada en el cliente (`isNew`, p. ej. la que crea Fill con un color nuevo): se edita **en local** (`updateLocalLayer`); **cero** llamadas de red.
  - Capa del servidor: el **mismo PATCH** que la originó. Con proyecto guardado, `PATCH /api/v2/projects/{id}/layers/{groupId}` con el campo cambiado
    (`{name}`, `{visible}`, `{locked}`, `{manufacturingOperation}`, `{order}` por capa que cambió); sin guardar, los sidecars clásicos
    (`POST …/visibility`, `…/lock`, `…/rename`, `…/operation`, `…/reorder`). Deshacer manda el valor **anterior**, rehacer el **siguiente**.
- **Orden de eventos.** El cambio original conserva su UX optimista de M2.1/M2.2 (la fila responde al instante y `useVectorDocument` revierte si la Web API
  falla); **recién cuando el servidor confirma** se registra la entrada. Si falla, no se registra nada y queda un error visible. Deshacer / rehacer **no son
  optimistas** (`optimistic: false`): no tocan nada local hasta que el servidor confirma, así un PATCH inverso que falla deja el estado intacto sin rollback que
  pelear con el de `useVectorDocument`.
- **Si el PATCH inverso falla:** el estado local **no cambia**, el puntero del historial **no se mueve**, el error se muestra (`role="alert"`) y se puede
  reintentar. Un `jumpTo` que cruza varios cambios de metadata espera cada PATCH y **se detiene en el primer fallo** (el puntero queda donde llegó).
- **Una operación a la vez.** Mientras hay un cambio de metadata en vuelo (original o inverso) Deshacer / Rehacer quedan deshabilitados **con el motivo**
  («hay un cambio de capa guardándose»), `applyEdit` responde `reason: "history_busy"` y el panel no deja saltar.
- **Estado fresco.** Un `jumpTo` encadena pasos de geometría (que crean o quitan capas nuevas) y de metadata; el persistidor lee el estado vigente
  (`getSnapshot()`, `getLayers()`), no el último render.
- **Limitación (diseño):** en un proyecto **sin guardar** el sidecar clásico nunca acepta volver a «sin asignar» (`ManufacturingOperationParser`), así que la
  **primera** asignación de operación de una capa del servidor no entra al historial (se avisa); el PATCH v2 de un proyecto guardado sí lo acepta y la
  registra. Reordenar con un proyecto guardado manda un PATCH por capa: si uno falla a mitad, el servidor puede quedar parcialmente reordenado (preexistente
  de M2.2-S05; el estado local se revierte).

## 4. Ejecutor declarativo (`commandExecutor.ts`)

```ts
executeCommand(host: { applyEdit, getSnapshot }, input: { type, targets?, parameters?, origin? }, context?: { createId?, mmPerUnit? })
  : { ok: true; command: EditorCommand; skippedLockedObjects; skippedHiddenObjects } | { ok: false; errors: { code, message, field? }[] }
```

1. **Valida todo antes de tocar nada:** forma de la entrada y claves; **sin geometría cruda** (`d`, `svg`, `points`, `matrix`, `transform`, marcado SVG o path
   data en cualquier lugar → `raw_geometry`); tipo conocido (`unknown_type`) y ejecutable (`not_executable`, con el motivo del registro); `origin`;
   `targets` bien formados; parámetros contra el esquema del tipo (claves, tipos, rangos, obligatorios, exclusiones → `invalid_parameters`); ids de objeto y de
   capa existentes (`unknown_target`); `missing_target`; **objetos en capas bloqueadas u ocultas** (`layer_locked` / `layer_hidden`: se rechaza el comando entero;
   la UI, en cambio, omite lo bloqueado y avisa).
2. **Ejecuta por el MISMO camino que la UI:** los planificadores puros de `lib/editor/*` (`planDelete`, `planDuplicate`, `planRecolor`, `runArrange`,
   `cropProduction`, `orientDocumentProduction`, `moveProduction` …) y `applyEdit`. El borrador de Fill / Recolor / Fusionar (`colorDraft`) y de Organizar
   (`arrangeDraft`) es **la misma función** que usa el shell. Se registra el valor **efectivo** de los parámetros por defecto (p. ej. el desplazamiento de
   `object.duplicate`), igual que el comando que deja la UI. Un test de equivalencia por tipo compara dos documentos idénticos —uno operado como el shell y
   otro con `executeCommand` sobre el comando serializado— y exige el **mismo estado exacto** y los mismos `type` / `targets` / `parameters` (solo difieren
   `origin` y la hora).
3. **Resultado estructurado:** `ok: true` devuelve el `EditorCommand` registrado (nunca `d` ni SVG); `ok: false` devuelve los errores y el documento no cambió
   ni sumó una entrada al historial (`nothing_to_do` si no cambia nada, `blocked` / `busy` / `rejected`).
4. **Ejecutables:** `object.move`, `object.scale`, `object.rotate`, `object.nudge`, `object.setBounds`, `object.delete`, `object.duplicate`, `object.fill`,
   `object.recolor`, `object.merge`, `object.erase.objects`, `document.crop`, `document.rotate`, `document.flip`, `selection.rotate`, `selection.flip`,
   `arrange.align`, `arrange.distribute`, `arrange.zorder` y `layer.create`. **No ejecutables** (motivo en el registro y en el error): lo que necesita el servidor
   (`geometry.*`), un gesto con puntos crudos (`object.draw`, `object.erase.subtract`, `path.*`), el portapapeles de la sesión (`object.cut`, `object.paste*`) o
   un PATCH asíncrono (`layer.rename` … `layer.reorder`).
5. `commandCatalog()` devuelve el catálogo JSON-puro (tipo, resumen, parámetros tipados, ejecutable / motivo) que MVP 4 puede mostrar a la IA.

Ejemplos de entrada:

```json
{ "type": "object.move", "targets": { "objectIds": ["r1", "b1"] }, "parameters": { "dx": 5, "dy": -3 } }
{ "type": "arrange.align", "targets": { "objectIds": ["r2", "e1"] }, "parameters": { "mode": "left", "reference": "selection" } }
{ "type": "object.fill", "targets": { "objectIds": ["r2"] }, "parameters": { "newColorHex": "#123456" } }
{ "type": "document.crop", "parameters": { "x": 0, "y": 0, "width": 55, "height": 25, "removeOutside": true } }
{ "type": "layer.create", "parameters": { "colorHex": "#12ab34", "name": "Verde lima" } }
```

Ejemplo de rechazo (la IA no puede pasar geometría):

```json
{ "type": "object.move", "targets": { "objectIds": ["r1"] }, "parameters": { "dx": 1, "dy": 0, "d": "M0 0 L9 9" } }
→ { "ok": false, "errors": [{ "code": "raw_geometry", "field": "input.parameters.d", "message": "«input.parameters.d» parece geometría o SVG crudos: …" }] }
```

## 5. UI

- **Header:** Deshacer / Rehacer muestran la **siguiente acción** en su nombre accesible y su `title` («Deshacer: Mover 3 objetos (Ctrl+Z)»); deshabilitados explican
  **por qué** (tooltip + `aria-describedby`: «no hay nada que deshacer», «hay una transformación pendiente», «hay un cambio de capa guardándose»). Atajos:
  Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y (listener de ventana; no dentro de campos de texto; siguen funcionando con el panel abierto).
- **Botón «Historial (N)»** (`aria-expanded`, `aria-controls="editor-history-panel"`; con ⚠ si hay un aviso o un error sin leer) abre el panel `region`
  «Historial de acciones»: lista cronológica con tipo, etiqueta, hora, objetos / capas afectados y origen; **«Estado inicial»** y la posición actual con
  `aria-current="step"`; las **entradas «futuras»** (rehacer) atenuadas (`data-future`) y con la insignia «rehacer»; **clic o Enter/Espacio** (son `<button>`) = `jumpTo`.
  Teclado: el foco entra a la acción actual, ↑ / ↓ / Inicio / Fin mueven el foco, Escape cierra y devuelve el foco al botón. Una región `aria-live="polite"` anuncia
  «Posición N de M: …». Muestra los avisos de reinicio / truncado («Entendido» los descarta) y el error de metadata; con el panel cerrado esos avisos siguen visibles
  como banner con «Ver historial».

## 6. Referencia por tipo

Generada desde `COMMAND_REGISTRY` (la fuente de verdad): cualquier tipo o parámetro nuevo debe aparecer acá o `commandCoverage.test.ts` falla.

npm warn exec The following package was not found and will be installed: vite-node@6.0.0
### Objetos

#### `object.move` — Mover objetos

Traslada los objetos (arrastre del canvas o ejecutor): compone la matriz, `d` queda intacto.

- **Ejecutable por el ejecutor declarativo:** sí
- **Objetivos:** exige `targets.objectIds` (≥ 1; todos en capas visibles y desbloqueadas).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `dx` | número | sí | Desplazamiento horizontal en unidades de documento. |
  | `dy` | número | sí | Desplazamiento vertical en unidades de documento. |

#### `object.scale` — Escalar objetos

Escala los objetos como grupo (handles del Transformer o ejecutor) alrededor de un pivote.

- **Ejecutable por el ejecutor declarativo:** sí
- **Objetivos:** exige `targets.objectIds` (≥ 1; todos en capas visibles y desbloqueadas).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `sx` | número -1000…1000, ≠ 0 | sí | Factor horizontal (negativo = reflejo). |
  | `sy` | número -1000…1000, ≠ 0 | sí | Factor vertical (negativo = reflejo). |
  | `pivotX` | número | no | X del pivote en documento; sin pivote se usa el centro del grupo. |
  | `pivotY` | número | no | Y del pivote en documento. |

#### `object.rotate` — Rotar objetos

Rota los objetos como grupo alrededor del centro de su caja (handle del Transformer, Inspector o ejecutor).

- **Ejecutable por el ejecutor declarativo:** sí
- **Objetivos:** exige `targets.objectIds` (≥ 1; todos en capas visibles y desbloqueadas).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `degrees` | número -3600…3600 | sí | Giro relativo en grados (horario en pantalla). |

#### `object.nudge` — Mover objetos con las flechas

Empuja la selección con el teclado; una ráfaga de flechas se funde en un comando con el desplazamiento acumulado.

- **Ejecutable por el ejecutor declarativo:** sí
- **Objetivos:** exige `targets.objectIds` (≥ 1; todos en capas visibles y desbloqueadas).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `dx` | número | sí | Desplazamiento horizontal acumulado en unidades de documento. |
  | `dy` | número | sí | Desplazamiento vertical acumulado en unidades de documento. |

#### `object.setBounds` — Posicionar y dimensionar objetos

Fija posición y tamaño del grupo (Inspector numérico o ejecutor), en unidades de documento.

- **Ejecutable por el ejecutor declarativo:** sí
- **Objetivos:** exige `targets.objectIds` (≥ 1; todos en capas visibles y desbloqueadas).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `x` | número | sí | X del grupo. |
  | `y` | número | sí | Y del grupo. |
  | `width` | número 0.000001…∞ | sí | Ancho del grupo (> 0). |
  | `height` | número 0.000001…∞ | sí | Alto del grupo (> 0). |

#### `object.delete` — Eliminar objetos

Elimina los objetos (Suprimir, botón o ejecutor); lo que está en capas bloqueadas se omite.

- **Ejecutable por el ejecutor declarativo:** sí
- **Objetivos:** exige `targets.objectIds` (≥ 1; todos en capas visibles y desbloqueadas).
- **Parámetros:** ninguno.

#### `object.cut` — Cortar objetos

Copia al portapapeles interno y elimina.

- **Ejecutable por el ejecutor declarativo:** no — Depende del portapapeles interno de la sesión de la UI, que el ejecutor no controla.
- **Parámetros:** ninguno.

#### `object.paste` — Pegar objetos

Pega el portapapeles interno con desplazamiento acumulativo, cada objeto en su capa de origen.

- **Ejecutable por el ejecutor declarativo:** no — Depende del portapapeles interno de la sesión de la UI, que el ejecutor no controla.
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `offsetX` | número | no | Desplazamiento horizontal aplicado. |
  | `offsetY` | número | no | Desplazamiento vertical aplicado. |

#### `object.pasteInPlace` — Pegar en el lugar

Pega el portapapeles interno sin desplazamiento.

- **Ejecutable por el ejecutor declarativo:** no — Depende del portapapeles interno de la sesión de la UI, que el ejecutor no controla.
- **Parámetros:** ninguno.

#### `object.pasteToLayer` — Pegar en la capa activa

Pega el portapapeles interno reasignando los objetos a la capa activa (toman su color).

- **Ejecutable por el ejecutor declarativo:** no — Depende del portapapeles interno de la sesión de la UI, que el ejecutor no controla.
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `layerId` | id | no | Capa activa que recibe los objetos. |

#### `object.duplicate` — Duplicar objetos

Duplica los objetos con ids nuevos, desplazados; sin tocar el portapapeles.

- **Ejecutable por el ejecutor declarativo:** sí
- **Objetivos:** exige `targets.objectIds` (≥ 1; todos en capas visibles y desbloqueadas).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `offsetX` | número | no | Desplazamiento horizontal; por defecto el de pegado (5 mm, o 5 u sin escala física). |
  | `offsetY` | número | no | Desplazamiento vertical. |

#### `object.fill` — Rellenar objetos

Mueve la selección a la capa del color elegido (Fill); un color libre nuevo crea una capa en el mismo comando.

- **Ejecutable por el ejecutor declarativo:** sí
- **Objetivos:** exige `targets.objectIds` (≥ 1; todos en capas visibles y desbloqueadas).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `targetLayerId` | id | no | Capa cuyo color se usa (identidad por groupId, nunca por hex). |
  | `newColorHex` | color `#RGB` / `#RRGGBB` | no | Color libre nuevo: crea una capa nueva con ese color (#RGB o #RRGGBB). |

#### `object.recolor` — Recolorear

Recolorea la selección, una capa o todo un color del documento (alcance explícito), sin fusionar capas.

- **Ejecutable por el ejecutor declarativo:** sí
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `scope` | enum (`selection`, `layer`, `document`) | sí | Alcance: selección, capa (cambia el color de la capa) o documento (capa origen elegida). |
  | `sourceLayerId` | id | no | Capa cuyo color cambia (alcances capa y documento). |
  | `targetLayerId` | id | no | Capa cuyo color se usa (identidad por groupId, nunca por hex). |
  | `newColorHex` | color `#RGB` / `#RRGGBB` | no | Color libre nuevo: crea una capa nueva con ese color (#RGB o #RRGGBB). |

#### `object.merge` — Fusionar capas

Recolorea una capa y la fusiona con otra de ese color: la capa origen queda vacía (no se elimina).

- **Ejecutable por el ejecutor declarativo:** sí
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `scope` | enum (`layer`, `document`) | sí | Alcance: capa o documento. |
  | `sourceLayerId` | id | sí | Capa origen, que queda vacía. |
  | `mergeIntoLayerId` | id | sí | Capa destino de la fusión (define el color). |
  | `targetLayerId` | id | no | Capa cuyo color se usa; por defecto la de destino. |
  | `newColorHex` | color `#RGB` / `#RRGGBB` | no | Color libre nuevo: crea una capa nueva con ese color (#RGB o #RRGGBB). |

#### `object.draw` — Dibujar

Crea una forma cerrada o una línea abierta con la pluma o la mano alzada (en la capa activa o una «Dibujo» nueva).

- **Ejecutable por el ejecutor declarativo:** no — Nace de un gesto sobre el canvas (puntos del puntero): la IA no recibe ni emite geometría cruda.
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `closed` | booleano | no | Forma cerrada (relleno) o línea abierta (trazo). |
  | `pointCount` | entero 0…∞ | no | Cantidad de puntos del trazo (los puntos no se guardan). |
  | `lineWidthMm` | número | no | Ancho del trazo de una línea abierta, en la unidad del panel. |
  | `normalized` | booleano | no | El servidor corrigió un trazo auto-intersecado. |
  | `pieceCount` | entero 0…∞ | no | Objetos creados. |

#### `object.erase.objects` — Borrar objetos

Borra los objetos bajo el cursor (modo Objeto del borrador).

- **Ejecutable por el ejecutor declarativo:** sí
- **Objetivos:** exige `targets.objectIds` (≥ 1; todos en capas visibles y desbloqueadas).
- **Parámetros:** ninguno.

#### `object.erase.subtract` — Restar geometría

Resta geometría con el pincel del borrador (difference en el servidor); las piezas son objetos nuevos.

- **Ejecutable por el ejecutor declarativo:** no — Nace de un gesto sobre el canvas (puntos del puntero): la IA no recibe ni emite geometría cruda. Además usa el servicio de geometría del servidor.
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `radiusMm` | número | no | Radio del pincel en la unidad del panel. |
  | `scope` | enum (`active-layer`, `unlocked-layers`) | no | Alcance: capa activa o todas las desbloqueadas. |
  | `strokePointCount` | entero 0…∞ | no | Puntos del trazo del pincel (no se guardan). |
  | `pieceCount` | entero 0…∞ | no | Piezas resultantes. |

### Nodos de un path

#### `path.moveAnchors` — Mover nodos

Mueve nodos (con sus handles) de un path: arrastre o flechas (fundidas en una ráfaga).

- **Ejecutable por el ejecutor declarativo:** no — Edita nodos de un path por índice y con puntos crudos: la IA no recibe ni emite geometría cruda (MVP 4 usará operaciones de más alto nivel).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `nodeCount` | entero 0…∞ | no | Cantidad de nodos afectados. |
  | `dx` | número | no | Desplazamiento X en el espacio local del objeto. |
  | `dy` | número | no | Desplazamiento Y en el espacio local del objeto. |
  | `source` | enum (`drag`, `keyboard`) | no | Origen del movimiento. |

#### `path.moveHandle` — Editar handle

Mueve un handle de Bézier (arrastre) o fija su largo/ángulo (Inspector).

- **Ejecutable por el ejecutor declarativo:** no — Edita nodos de un path por índice y con puntos crudos: la IA no recibe ni emite geometría cruda (MVP 4 usará operaciones de más alto nivel).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `side` | enum (`in`, `out`) | no | Lado del handle. |
  | `source` | enum (`drag`, `inspector`) | no | Origen del cambio. |
  | `field` | enum (`length`, `angle`) | no | Campo editado en el Inspector. |
  | `value` | número | no | Valor del campo editado. |

#### `path.addNode` — Agregar nodo

Agrega un nodo sobre un segmento (De Casteljau exacto: la forma no cambia).

- **Ejecutable por el ejecutor declarativo:** no — Edita nodos de un path por índice y con puntos crudos: la IA no recibe ni emite geometría cruda (MVP 4 usará operaciones de más alto nivel).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `subpath` | entero 0…∞ | no | Índice del subpath. |
  | `segment` | entero 0…∞ | no | Índice del segmento. |
  | `t` | número 0…1 | no | Posición paramétrica en el segmento (0..1). |

#### `path.deleteNodes` — Eliminar nodos

Elimina nodos (eliminación mínima) o el subpath entero.

- **Ejecutable por el ejecutor declarativo:** no — Edita nodos de un path por índice y con puntos crudos: la IA no recibe ni emite geometría cruda (MVP 4 usará operaciones de más alto nivel).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `nodeCount` | entero 0…∞ | no | Cantidad de nodos afectados. |
  | `removeSubpaths` | booleano | no | Eliminó subpaths enteros (tras la confirmación). |

#### `path.setNodeKind` — Cambiar tipo de nodo

Cambia el tipo de nodo (esquina, suave, simétrico).

- **Ejecutable por el ejecutor declarativo:** no — Edita nodos de un path por índice y con puntos crudos: la IA no recibe ni emite geometría cruda (MVP 4 usará operaciones de más alto nivel).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `kind` | enum (`corner`, `smooth`, `symmetric`) | no | Tipo de nodo resultante. |
  | `nodeCount` | entero 0…∞ | no | Cantidad de nodos afectados. |

#### `path.toggleSegment` — Alternar segmento recto/curvo

Convierte segmentos rectos en curvos y viceversa.

- **Ejecutable por el ejecutor declarativo:** no — Edita nodos de un path por índice y con puntos crudos: la IA no recibe ni emite geometría cruda (MVP 4 usará operaciones de más alto nivel).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `scope` | enum (`before`, `after`, `selected`) | no | Qué segmentos. |

#### `path.closeSubpath` — Cerrar subpath

Cierra un subpath abierto.

- **Ejecutable por el ejecutor declarativo:** no — Edita nodos de un path por índice y con puntos crudos: la IA no recibe ni emite geometría cruda (MVP 4 usará operaciones de más alto nivel).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `subpath` | entero 0…∞ | no | Índice del subpath. |

#### `path.openSubpath` — Abrir subpath

Abre un subpath cerrado en el nodo seleccionado.

- **Ejecutable por el ejecutor declarativo:** no — Edita nodos de un path por índice y con puntos crudos: la IA no recibe ni emite geometría cruda (MVP 4 usará operaciones de más alto nivel).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `subpath` | entero 0…∞ | no | Índice del subpath. |
  | `node` | entero 0…∞ | no | Índice del nodo. |

#### `path.setNodeCoords` — Fijar coordenada de nodo

Fija una coordenada (X o Y) de los nodos seleccionados desde el Inspector.

- **Ejecutable por el ejecutor declarativo:** no — Edita nodos de un path por índice y con puntos crudos: la IA no recibe ni emite geometría cruda (MVP 4 usará operaciones de más alto nivel).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `axis` | enum (`x`, `y`) | no | Eje editado. |
  | `value` | número | no | Valor en la unidad del panel. |
  | `nodeCount` | entero 0…∞ | no | Cantidad de nodos afectados. |

### Documento (área de trabajo)

#### `document.crop` — Recortar el área de trabajo

Recorta el marco (área de trabajo) y, opcionalmente, elimina los objetos totalmente fuera.

- **Ejecutable por el ejecutor declarativo:** sí
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `x` | número | sí | Origen X del nuevo marco. |
  | `y` | número | sí | Origen Y del nuevo marco. |
  | `width` | número 0.000001…∞ | sí | Ancho del nuevo marco (> 0). |
  | `height` | número 0.000001…∞ | sí | Alto del nuevo marco (> 0). |
  | `removeOutside` | booleano | no | Eliminar los objetos totalmente fuera del marco (por defecto sí). |

#### `document.rotate` — Rotar el documento

Gira TODO el documento (también las capas ocultas) alrededor del centro del marco; rechaza si hay capas bloqueadas.

- **Ejecutable por el ejecutor declarativo:** sí
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `quarterTurns` | entero 1…3 | sí | Cuartos de vuelta horarios (1..3). |

#### `document.flip` — Reflejar el documento

Refleja TODO el documento y después lo gira `quarterTurns` cuartos de vuelta horarios.

- **Ejecutable por el ejecutor declarativo:** sí
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `axis` | enum (`horizontal`, `vertical`) | sí | Eje del reflejo. |
  | `quarterTurns` | entero 0…3 | no | Cuartos de vuelta horarios posteriores (0..3). |

### Selección (rotar / reflejar)

#### `selection.rotate` — Rotar la selección

Gira la selección en múltiplos de 90° alrededor del centro de su caja (identidad exacta).

- **Ejecutable por el ejecutor declarativo:** sí
- **Objetivos:** exige `targets.objectIds` (≥ 1; todos en capas visibles y desbloqueadas).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `quarterTurns` | entero 1…3 | sí | Cuartos de vuelta horarios (1..3). |

#### `selection.flip` — Reflejar la selección

Refleja la selección y después la gira `quarterTurns` cuartos de vuelta horarios.

- **Ejecutable por el ejecutor declarativo:** sí
- **Objetivos:** exige `targets.objectIds` (≥ 1; todos en capas visibles y desbloqueadas).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `axis` | enum (`horizontal`, `vertical`) | sí | Eje del reflejo. |
  | `quarterTurns` | entero 0…3 | no | Cuartos de vuelta horarios posteriores (0..3). |

### Organizar

#### `arrange.align` — Alinear objetos

Alinea los objetos movibles (traslaciones) con la selección o con el marco del documento.

- **Ejecutable por el ejecutor declarativo:** sí
- **Objetivos:** exige `targets.objectIds` (≥ 1; todos en capas visibles y desbloqueadas).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `mode` | enum (`left`, `center`, `right`, `top`, `middle`, `bottom`) | sí | Borde o centro de alineación. |
  | `reference` | enum (`selection`, `document`) | sí | Referencia: la propia selección (≥ 2 objetos) o el marco del documento. |

#### `arrange.distribute` — Distribuir objetos

Reparte huecos iguales entre ≥ 3 objetos, con los extremos fijos.

- **Ejecutable por el ejecutor declarativo:** sí
- **Objetivos:** exige `targets.objectIds` (≥ 1; todos en capas visibles y desbloqueadas).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `axis` | enum (`horizontal`, `vertical`) | sí | Eje de distribución. |

#### `arrange.zorder` — Cambiar el orden de pintado

Reordena los objetos dentro de su capa (nunca los cambia de capa).

- **Ejecutable por el ejecutor declarativo:** sí
- **Objetivos:** exige `targets.objectIds` (≥ 1; todos en capas visibles y desbloqueadas).
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `action` | enum (`forward`, `backward`, `front`, `back`) | sí | Movimiento en el orden de pintado. |

### Geometría en el servidor

#### `geometry.boolean` — Operación booleana

Unión, diferencia, intersección o XOR n-aria de formas rellenas (servidor); un comando atómico.

- **Ejecutable por el ejecutor declarativo:** no — Necesita el servicio de geometría del servidor (asíncrono): el ejecutor declarativo opera solo sobre el documento en memoria.
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `operation` | enum (`union`, `difference`, `intersection`, `xor`) | no | Operación. |
  | `operandCount` | entero 0…∞ | no | Cantidad de operandos. |
  | `keepOriginals` | booleano | no | Se conservaron los originales. |
  | `resultCount` | entero 0…∞ | no | Objetos resultantes. |
  | `toleranceMm` | número | no | Tolerancia en la unidad del panel. |
  | `targetLayerId` | id | no | Capa cuyo color se usa (identidad por groupId, nunca por hex). |
  | `newColorHex` | color `#RGB` / `#RRGGBB` | no | Color libre nuevo: crea una capa nueva con ese color (#RGB o #RRGGBB). |

#### `geometry.offset` — Offset

Desplaza el contorno hacia afuera o adentro (servidor); un comando atómico.

- **Ejecutable por el ejecutor declarativo:** no — Necesita el servicio de geometría del servidor (asíncrono): el ejecutor declarativo opera solo sobre el documento en memoria.
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `direction` | enum (`outside`, `inside`) | no | Dirección. |
  | `distance` | número | no | Distancia en la unidad `unit`. |
  | `unit` | enum (`mm`, `u`) | no | Unidad de la distancia. |
  | `joinStyle` | enum (`round`, `mitre`, `bevel`) | no | Unión de esquinas. |
  | `capStyle` | enum (`round`, `flat`, `square`) | no | Extremos de una línea abierta. |
  | `mitreLimit` | número | no | Límite del inglete. |
  | `keepOriginals` | booleano | no | Se conservaron los originales. |
  | `resultCount` | entero 0…∞ | no | Objetos resultantes. |
  | `toleranceMm` | número | no | Tolerancia en la unidad del panel. |
  | `targetLayerId` | id | no | Capa cuyo color se usa (identidad por groupId, nunca por hex). |
  | `newColorHex` | color `#RGB` / `#RRGGBB` | no | Color libre nuevo: crea una capa nueva con ese color (#RGB o #RRGGBB). |

#### `geometry.split` — Cortar con una línea

Divide (o separa con ranura) los objetos con una línea de corte (servidor); un comando atómico.

- **Ejecutable por el ejecutor declarativo:** no — Necesita el servicio de geometría del servidor (asíncrono): el ejecutor declarativo opera solo sobre el documento en memoria. Además la línea de corte son puntos crudos.
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `mode` | enum (`split`, `slot`) | no | Modo. |
  | `slotWidth` | número | no | Ancho de la ranura en la unidad `unit` (solo modo slot). |
  | `unit` | enum (`mm`, `u`) | no | Unidad del ancho. |
  | `extend` | booleano | no | El corte se prolongó para cruzar todo. |
  | `cutPointCount` | entero 0…∞ | no | Puntos de la línea de corte (no se guardan). |
  | `pieceCount` | entero 0…∞ | no | Piezas resultantes. |

#### `geometry.bridge` — Aplicar bridges

Conecta piezas flotantes con bridges rectangulares (servidor); un comando atómico.

- **Ejecutable por el ejecutor declarativo:** no — Necesita el servicio de geometría del servidor (asíncrono): el ejecutor declarativo opera solo sobre el documento en memoria.
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `mode` | enum (`stencil`, `parts`) | no | Definición de pieza flotante. |
  | `bridgeCount` | entero 0…∞ | no | Bridges aplicados. |
  | `widthMm` | número | no | Ancho de los bridges en la unidad `unit`. |
  | `unit` | enum (`mm`, `u`) | no | Unidad del ancho. |
  | `floatingBefore` | entero 0…∞ | no | Piezas flotantes antes. |
  | `floatingAfter` | entero 0…∞ | no | Piezas flotantes después. |

### Capas

#### `layer.create` — Crear capa

Crea una capa vacía con un color (capa nueva `isNew`, todavía sin guardar). Fill, Draw, booleanas y offset la crean implícitamente dentro de su propio comando.

- **Ejecutable por el ejecutor declarativo:** sí (Fill, Draw, las booleanas y el offset la crean implícitamente dentro de su comando; el ejecutor la emite sola)
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `colorHex` | color `#RGB` / `#RRGGBB` | sí | Color de la capa (#RGB o #RRGGBB). |
  | `name` | texto (≤ 200) | no | Nombre de la capa; por defecto «Color #RRGGBB». |

#### `layer.rename` — Renombrar capa

Cambia el nombre de una capa (nunca su groupId); deshacer/rehacer re-persisten el nombre con el mismo PATCH.

- **Ejecutable por el ejecutor declarativo:** no — Persiste por PATCH inmediato al servidor (asíncrono) y entra al historial con su PATCH inverso: lo orquesta el cliente de la API, no el ejecutor síncrono.
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `from` | texto (≤ 200) | no | Nombre anterior. |
  | `to` | texto (≤ 200) | no | Nombre nuevo. |

#### `layer.setVisible` — Mostrar u ocultar capa

Muestra u oculta una capa (ojo del panel de capas). Isolate no es un comando.

- **Ejecutable por el ejecutor declarativo:** no — Persiste por PATCH inmediato al servidor (asíncrono) y entra al historial con su PATCH inverso: lo orquesta el cliente de la API, no el ejecutor síncrono.
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `visible` | booleano | no | Visibilidad resultante. |

#### `layer.setLocked` — Bloquear o desbloquear capa

Bloquea o desbloquea una capa para edición.

- **Ejecutable por el ejecutor declarativo:** no — Persiste por PATCH inmediato al servidor (asíncrono) y entra al historial con su PATCH inverso: lo orquesta el cliente de la API, no el ejecutor síncrono.
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `locked` | booleano | no | Bloqueo resultante. |

#### `layer.setOperation` — Cambiar la operación de fabricación

Asigna Corte / Grabado / Ignorar a una capa.

- **Ejecutable por el ejecutor declarativo:** no — Persiste por PATCH inmediato al servidor (asíncrono) y entra al historial con su PATCH inverso: lo orquesta el cliente de la API, no el ejecutor síncrono.
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `operation` | enum (`cut`, `engrave`, `ignore`, `unassigned`) | no | Operación resultante. |
  | `previous` | enum (`cut`, `engrave`, `ignore`, `unassigned`) | no | Operación anterior. |

#### `layer.reorder` — Reordenar capas

Cambia el orden de las capas en el panel (arrastrar y soltar).

- **Ejecutable por el ejecutor declarativo:** no — Persiste por PATCH inmediato al servidor (asíncrono) y entra al historial con su PATCH inverso: lo orquesta el cliente de la API, no el ejecutor síncrono.
- **Parámetros:**

  | Nombre | Tipo | Obligatorio | Descripción |
  | --- | --- | --- | --- |
  | `order` | lista de ids | no | Ids de TODAS las capas en el orden resultante. |

## 7. Pruebas

| Archivo | Qué fija |
| --- | --- |
| `lib/editor/commands.test.ts` | forma versionada, registro 1:1 con los tipos, parámetros documentados, JSON ida y vuelta, `exportHistory` sin parches ni SVG, validación y geometría cruda |
| `hooks/useEditableDocument.history.test.tsx` | secuencias mixtas, **60 acciones** hacia atrás y adelante con estado exacto, `jumpTo`, rama de rehacer, límite / aviso, fusión, reinicio, StrictMode, metadata con PATCH inverso (fallo, en vuelo, `jumpTo` que cruza metadata) |
| `lib/editor/commandExecutor.test.tsx` | equivalencia con la UI por tipo, validaciones sin tocar el documento, nunca acepta ni devuelve `d` / SVG, catálogo |
| `components/editor/EditorShell.history.test.tsx` | botones y motivos, panel (lista, posición, futuras atenuadas, `jumpTo` por clic y teclado, avisos), atajos, StrictMode, metadata contra un servidor simulado (método, URL, cuerpo, conteo de llamadas, `AbortSignal`), `isNew` sin red, tipos de comando de rutas reales |
| `components/editor/HistoryPanel.test.tsx` | el panel aislado |
| `lib/editor/commandCoverage.test.ts` | cobertura total (ver §1) |
| `EditorShell.{draw,erase,boolean,offset,cut,floating,path}.test.tsx` | el tipo de comando que deja cada ruta real de esas herramientas |

## 8. Fuera de alcance

Persistir el historial entre sesiones o en el servidor (M3-S13 / MVP 4), colaboración, undo selectivo (fuera de orden), historial por objeto, ejecución por IA de
los comandos que requieren servidor o gesto, y UI de la IA.
