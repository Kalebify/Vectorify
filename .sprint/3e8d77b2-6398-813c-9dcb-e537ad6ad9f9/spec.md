# spec.md — M2.2-S07 · Autosave + recuperación segura

## Contexto

Séptima tarjeta de MVP 2.2. El botón Guardar manual (M2.2-S05) y su máquina de estados
`idle/dirty/saving/saved/error` (`useWorkspaceSave`) ya existen. Esta tarjeta reemplaza el click
manual por guardado automático, con debounce, recuperación de fallos, e idempotencia real.

## ⚠️ Decisión arquitectónica confirmada con el usuario (vía AskUserQuestion)

Desde el cutover post-Save de M2.2-S05 (ronda de fix 1) y el fix de inmutabilidad de PATCH de
M2.2-S06 (ronda de fix 1), **cada edición de metadata en una sesión ya guardada
(toggle/lock/rename/reorder/operación) ya persiste de inmediato vía `PATCH
/api/v2/projects/{id}/layers/{layerId}`, y ese PATCH ya crea su propio checkpoint
(`DocumentVersion`) por sí solo.** Si esta tarjeta hiciera que el autosave disparara ADEMÁS el
snapshot completo (`POST /api/v2/workspaces/save`, que re-sube todos los SVGs) sobre las mismas
ediciones, cada click generaría DOS versiones redundantes con el mismo contenido.

**Resuelto**: se separan los dos conceptos.

- **Sesión en staging (sin `savedProjectId` todavía)**: el autosave automatiza el PRIMER Save —
  debounce tras inactividad desde la primera mutación, dispara `POST /api/v2/workspaces/save`
  (crea el `Project` v2 + V1). Esto es, literalmente, lo que el botón Guardar manual ya hacía,
  ahora disparado solo.
- **Sesión ya guardada (`savedProjectId` presente)**: el PATCH-por-edición YA ES el autosave
  real (persiste en el siguiente tick de la UI, sin esperar inactividad) — esta tarjeta conecta
  la máquina de estados Dirty/Saving/Saved/Error existente al ciclo de vida de ESE PATCH, no al
  snapshot completo. El snapshot completo (`POST /workspaces/save`) queda reservado para
  recapturar geometría (si se re-vectoriza estando ya dentro de una sesión guardada, caso fuera
  de alcance real hoy porque el Workspace no expone esa acción) — en la práctica, con esta
  tarjeta cerrada, un usuario normal nunca más necesita tocar el botón Guardar manualmente.

## Frontend

### Estado Dirty/Saving/Saved/Error (dos fuentes, un solo indicador)

`useWorkspaceSave` (M2.2-S05) sigue siendo dueño del estado visible en `EditorHeader`, pero deja
de ser el único que lo escribe:

- **Staging**: `markDirty()` arranca/resetea un debounce timer (ver "Debounce" abajo). Al
  vencer sin nueva actividad, dispara `save()` automáticamente (mismo código ya existente del
  botón manual) — el click manual del botón Guardar sigue funcionando igual, para forzar el
  save ANTES de que venza el debounce.
- **Ya guardado**: se agrega un método nuevo al hook, `trackPatch(promise: Promise<unknown>)` —
  lo llaman `useVectorDocument`/`useManufacturingOperations` (que ya saben si `savedProjectId`
  está presente y ya son quienes disparan cada PATCH) envolviendo la promesa del PATCH:
  `state` pasa a `"saving"` de inmediato, `"saved"` si resuelve, `"error"` (con rollback local YA
  EXISTENTE en esos hooks, sin cambios ahí) si rechaza. `markDirty()` deja de llamarse desde
  `EditorShell` para las 4 mutaciones una vez que hay `savedProjectId` (dejaría un estado "dirty"
  mentiroso inmediatamente pisado por el PATCH) — se sigue llamando tal cual en staging.

### Debounce (solo aplica al autosave de staging)

"No guardar por mousemove" / "los gestos se consolidan": en modo ya-guardado esto YA está
resuelto de origen (cada PATCH dispara una sola vez por acción discreta del usuario — un click,
un blur, un drop de drag-and-drop — nunca por frame de mousemove; reorder ya manda un PATCH por
layer SOLO al soltar, no durante el arrastre). El debounce nuevo de esta tarjeta aplica
exclusivamente al autosave de staging: ventana de **2000 ms** de inactividad desde la última
mutación antes de disparar el primer Save automático (cualquier mutación nueva reinicia la
ventana). Valor elegido por esta tarjeta (el criterio de aceptación no fija uno) — documentado
acá, ajustable sin romper nada más si se decide otro número.

### Cambio mientras un save está en vuelo (staging) / saturación de PATCH (guardado)

- **Staging**: si llega una mutación nueva mientras `save()` ya está en curso (`state ===
  "saving"`), NO se aborta el request en vuelo (cambio de comportamiento respecto al
  `save()` manual actual, que sí abortaba el anterior en cada click — eso se mantiene SOLO para
  el click manual explícito, nunca para el disparo automático del debounce). En su lugar, la
  mutación marca dirty igual y el debounce se reprograma para disparar un Save nuevo recién
  cuando el actual resuelva (éxito o error) — nunca dos `POST /workspaces/save` concurrentes
  para el mismo proyecto.
- **Guardado**: cada PATCH ya es independiente por layer; no hace falta serializar manualmente
  (el backend ya resuelve conflictos reales vía `xmin`, ver "Backend").

### Recuperación al cerrar la pestaña

- `beforeunload`: si `state` es `"dirty"` o `"saving"` (solo relevante en staging — en modo
  guardado casi nunca hay una ventana "dirty" visible dado que el PATCH persiste casi al
  instante), se muestra la confirmación nativa del navegador ("¿Salir sin guardar?").
- **Recovery local, SOLO como puntero, nunca como fuente de verdad del contenido** (requisito
  explícito de la tarjeta): mientras la sesión está en staging y dirty, se guarda en
  `localStorage` un puntero liviano `{classicProjectId, imageId, paletteId, updatedAt}` (NUNCA
  el documento en sí — el contenido real ya vive server-side en los sidecars clásicos, que son
  la fuente de verdad real de staging). Se borra apenas `state` pasa a `"saved"`. Al iniciar la
  app sin deep-link en la URL, si existe un puntero reciente (p. ej. últimas 24 h), se ofrece un
  affordance liviano ("Continuar donde quedaste") que reconstruye la URL del Workspace desde ese
  puntero — nunca intenta rehidratar el documento desde `localStorage` directamente, siempre
  vuelve a pedirlo al backend.

## Backend: idempotencia real en `POST /api/v2/workspaces/save`

Mismo patrón YA EXISTENTE en el flujo clásico (`ProjectRecord.IdempotencyKey`/
`ProjectUploadService.UploadAsync` — reusar el criterio, no reinventar): `VectorDocumentSaveRequest`
gana un campo `idempotencyKey: string?` (GUID generado por el cliente, UNA vez por intento
lógico de guardar — el mismo valor se reenvía en cada reintento automático/manual de ESE mismo
intento, nunca uno nuevo por reintento). `DocumentVersion` gana una columna `IdempotencyKey`
(`string?`, índice único PARCIAL -- solo sobre valores no nulos, Postgres soporta índices únicos
parciales con `HasFilter` en EF Core -- para no romper versiones viejas que nunca mandaron uno).

`VectorDocumentService.SaveAsync`: si `idempotencyKey` viene no-nulo, busca primero si YA existe
una `DocumentVersion` con esa key para el `VectorDocument` del proyecto -- si existe, devuelve
ESE resultado (mismo `VersionNumber`/`SavedAt`) sin crear nada nuevo ni volver a resolver el
estado clásico/re-subir SVGs. Esto es lo que vuelve seguro un reintento real (red lenta que hace
timeout del lado del cliente pero el servidor sí terminó, el cliente reintenta con la MISMA key):
nunca duplica una versión.

El PATCH de layer individual (`UpdateLayerAsync`) NO necesita idempotencia nueva: ya es
naturalmente idempotente a nivel de resultado observable (aplicar el mismo patch dos veces dejä
el mismo valor final), y cada PATCH ya es una operación barata sin I/O externo (sin re-subida de
SVGs) -- duplicar una versión ahí en el peor caso de un reintento de red es un costo aceptable
que el criterio de aceptación no pide resolver explícitamente para este camino (solo lo pide
para "Save" en general, y el camino caro/con I/O real es el snapshot completo).

## Backend: validar Project/Owner/Version

Ya existe (M2.2-S03/S05): `IUserContext`/`IProjectRepository.FindByIdAsync` resuelve ownership
antes de cualquier operación, 404 uniforme. Concurrencia optimista vía `xmin` ya cubre
"Version" (conflicto si otro Save/PATCH/Restore tocó el `Project` entre medio). Esta tarjeta no
necesita agregar nada nuevo acá -- solo confirmar con un test que el camino de autosave
(idempotencyKey incluido) sigue pasando por las mismas validaciones.

## Tests (pedidos explícitamente por la tarjeta)

- **Red lenta**: `save()`/PATCH tardan, la UI muestra "saving" todo ese tiempo, sin disparar un
  segundo intento en paralelo.
- **Offline**: fetch falla con error de red -- `state` a `"error"`, mensaje honesto, reintentable.
- **Doble request**: dos intentos de Save con la MISMA `idempotencyKey` (simulando un reintento
  real) -- la segunda llamada devuelve el mismo `VersionNumber`, nunca crea una versión nueva.
- **Cambio mientras el save está en vuelo**: mutación nueva durante un `POST /workspaces/save`
  en curso (staging) -- no se lanza un segundo POST concurrente, el debounce se reprograma para
  después de que el actual resuelva.
- **Conflicto**: 409 (`xmin`) durante un autosave -- se expone como error, nunca se reintenta en
  loop infinito automáticamente.
- **Reload**: recargar con una mutación "dirty" pendiente en staging -- el puntero de
  `localStorage` permite ofrecer continuar, el contenido real se re-resuelve 100% desde el
  backend (nunca desde `localStorage`).

## Fuera de alcance

- Resolución de conflictos a nivel de campo (merge de ediciones concurrentes) -- un 409 sigue
  siendo "recargá e intentá de nuevo", igual criterio que `ProjectService`.
- Recapturar geometría automáticamente si se re-vectoriza estando ya en una sesión guardada --
  el Workspace no expone esa acción hoy, nada que autosavear ahí todavía.
- Service Worker / guardado real offline-first -- el `localStorage` de recovery es un puntero,
  no una cola de sincronización.

## Definition of Done

El usuario puede trabajar normalmente sin pulsar Guardar de forma continua y sin una falsa
sensación de guardado -- el indicador Dirty/Saving/Saved/Error siempre refleja el estado real
(del snapshot completo en staging, o de cada PATCH individual ya guardado), y un reintento de
red nunca duplica versiones ni pierde la última edición confirmada.
