# IMPL.md — M2.2-S07 · Autosave + recuperación segura

## Resumen

Séptima tarjeta de MVP 2.2. Reemplaza el click manual de Guardar por guardado automático, con
debounce, recuperación de fallos, e idempotencia real — siguiendo la decisión arquitectónica
confirmada con el usuario antes de escribir el spec (ver spec.md, "⚠️ Decisión arquitectónica
confirmada").

## Decisión arquitectónica (confirmada por el usuario vía AskUserQuestion)

Desde el cutover post-Save de M2.2-S05 y el fix de inmutabilidad de PATCH de M2.2-S06, cada
edición de metadata en una sesión ya guardada ya persiste al instante vía PATCH, que ya crea su
propio checkpoint. Hacer que el autosave disparara ADEMÁS el snapshot completo
(`POST /workspaces/save`) sobre las mismas ediciones habría duplicado versiones redundantes.

**Resuelto**: se separan los dos conceptos. **Staging** (sin `savedProjectId`): el autosave
automatiza el PRIMER Save con debounce de 2000ms de inactividad. **Ya guardado**: el
PATCH-por-edición YA ES el autosave real — esta tarjeta conecta la máquina de estados
Dirty/Saving/Saved/Error existente (`useWorkspaceSave`) al ciclo de vida de ESE PATCH, nunca
dispara el snapshot completo sobre la misma edición.

## Frontend

- **`useWorkspaceSave.ts`**: debounce de staging de 2000ms (`AUTOSAVE_DEBOUNCE_MS`, exportado;
  `markDirty()` arranca/resetea el timer). `trackPatch(promise)` nuevo: conecta el indicador al
  PATCH real de una sesión guardada sin tocar el rollback optimista que `useVectorDocument.ts`/
  `useManufacturingOperations.ts` ya manejan por su cuenta. Generación/reuso de
  `idempotencyKey` por intento lógico: la misma key se reenvía en cada reintento del MISMO
  intento (nunca una nueva por reintento), se descarta y se genera una nueva recién cuando una
  mutación nueva supera a un intento fallido. El abort de un request en vuelo queda reservado
  EXCLUSIVAMENTE al click manual del botón — el disparo automático del debounce nunca aborta
  nada, solo reprograma el timer para después de que el actual resuelva.
- **`workspaceRecovery.ts`** (nuevo): puntero liviano `{classicProjectId, imageId, paletteId,
  updatedAt}` en `localStorage` — NUNCA el documento (la fuente de verdad real de staging sigue
  siendo el backend/los sidecars clásicos). Ventana de 24h para el affordance "Continuar donde
  quedaste". Todo el acceso a `localStorage` envuelto en try/catch (best-effort, nunca crítico).
- **`useVectorDocument.ts`/`useManufacturingOperations.ts`**: nuevo parámetro opcional
  `trackPatch`, envuelve las 4 mutaciones PATCH cuando `savedProjectId` está presente. Reorder
  envuelve el `Promise.all(...)` completo de todos los PATCH por-layer como una sola unidad
  trackeada.
- **`EditorShell.tsx`**: rompe la dependencia circular (`useVectorDocument` necesita `trackPatch`
  de `useWorkspaceSave`, que a su vez necesita `document.paletteVersion` de
  `useVectorDocument`) con el patrón "latest ref" — `trackPatch` es una función estable que
  reenvía a una ref actualizada vía `useEffect` una vez resuelto `workspaceSave`. Deja de llamar
  `markDirty()` para las 4 mutaciones una vez que hay `savedProjectId`.
- **`App.tsx`**: affordance "Continuar donde quedaste" — reusa `resolveWorkspaceDeepLink` tal
  cual (nunca rehidrata desde `localStorage`, siempre vuelve a pedir todo al backend).
- `beforeunload`: confirmación nativa del navegador mientras `state` es `dirty`/`saving`.

## Backend: idempotencia real

Mismo patrón ya existente en el flujo clásico (`ProjectRecord.IdempotencyKey`/
`ProjectUploadService`, reusado tal cual). `VectorDocumentSaveRequest` gana `IdempotencyKey:
string?`. `DocumentVersion` gana columna `IdempotencyKey` (nullable) con índice único PARCIAL
(`HasFilter`, solo sobre valores no nulos — no rompe versiones viejas sin key). Nuevo
`IVectorDocumentRepository.FindByIdempotencyKeyAsync(ownerId, key)`, scoped por ownership (sin
necesitar `projectId`, porque el primer intento de un Save siempre manda `ProjectId: null`).
`VectorDocumentService.SaveAsync` chequea esto primero; si existe, devuelve
`VectorDocumentResult.Replayed` (siempre 200, nunca 201) sin tocar storage/sidecars/DB. El PATCH
individual de layer no necesita idempotencia nueva (decisión ya tomada en el spec — operación
barata, sin I/O externo).

## Bug real encontrado y corregido en la revisión del orquestador

**El click manual podía reutilizar la `idempotencyKey` de un autosave que estaba
interrumpiendo.** Escenario: un autosave automático (key K) queda en vuelo; el usuario hace
click en "Guardar" antes de que resuelva; `performSave("manual")` abortaba el request en vuelo
pero REUSABA la misma key K para el nuevo intento manual (ya que `idempotencyKeyRef.current`
seguía siendo K, nunca se había limpiado). Si el intento automático abortado en realidad ya
había llegado a persistirse del lado del servidor (la cancelación del cliente no llegó a tiempo
— una condición de carrera real, no hipotética), el backend le devolvería al click manual el
resultado YA VIEJO de K (vía el replay de idempotencia) como si fuera la confirmación del
guardado actual — perdiendo en silencio cualquier edición hecha entre que el intento automático
arrancó y el click manual.

Corregido: cuando el click manual aborta un Save que SÍ estaba en vuelo (`isSavingRef.current`
true), se descarta la key vieja (`idempotencyKeyRef.current = null`) antes de abortar, forzando
que el intento manual arme una key fresca. Peor caso resultante: dos versiones en vez de una
(si el abortado efectivamente había persistido) — nunca contenido perdido mostrado como
"guardado". Confirmado reproduciendo el bug: revertí el fix, el test nuevo falló exactamente
como se esperaba (la segunda key coincidía con la primera), lo restauré y pasó.

También corregí un error de tipos en mi propio test nuevo (`vi.fn(() => ...)` con una función
explícita angosta el tipo de `.mock.calls` a tuplas vacías — cambiado a
`vi.fn().mockImplementation(...)`, mismo patrón que el resto de los tests del archivo).

## Fuera de alcance (según spec)

Resolución de conflictos a nivel de campo, recapturar geometría automáticamente al re-vectorizar
dentro de una sesión guardada (el Workspace no expone esa acción hoy), Service Worker/guardado
offline-first real.

## Verificación (5 comandos, confirmados de forma independiente por el orquestador)

1. `dotnet build` → 0 errores/warnings.
2. `dotnet test` → 791/791 (Testcontainers PostgreSQL real, incluye los tests de idempotencia:
   replay con la misma key no crea una versión nueva, sin key dos calls crean dos versiones
   distintas).
3. `pytest` (python-engine) → 400/400, sin tocar.
4. `npm test` (frontend) → 348/348 (incluye el test de regresión del bug de la key manual
   encontrado en esta revisión, con fake timers para el debounce).
5. `npm run build` (frontend) → limpio, 0 errores de TypeScript (tras el fix del error de tipos
   en mi propio test).

Revisión de código personal completa: `VectorDocumentService.cs`/`VectorDocumentRepository.cs`
(idempotencia), `useWorkspaceSave.ts` (máquina de estados completa, debounce, manejo de
idempotencyKey en cada rama), `EditorShell.tsx` (resolución de la dependencia circular),
`useVectorDocument.ts`/`useManufacturingOperations.ts` (wiring de `trackPatch`),
`workspaceRecovery.ts`, `App.tsx` (affordance de recovery) — diseño consistente y cuidadoso, un
bug real de condición de carrera encontrado y corregido antes de mergear.
