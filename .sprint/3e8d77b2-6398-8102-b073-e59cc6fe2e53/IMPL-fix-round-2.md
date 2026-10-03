# IMPL-fix-round-2.md — M2.2-S05 · `SaveAsync` releía sidecars clásicos congelados

## Bug encontrado por el orquestador (no reportado explícitamente por QA, descubierto durante la revisión del fix round 1)

El agente que implementó el fix round 1 (cutover de frontend: mutaciones post-Save pasan a
`PATCH /api/v2/projects/{id}/layers/{layerId}`, nunca a los sidecars clásicos) notó, sin que
fuera parte de su alcance, un problema más profundo: `VectorDocumentService.SaveAsync` seguía
resolviendo `order`/`visible`/`locked`/`name`/`manufacturingOperation` leyendo
`ILayerLayoutService.FindCurrent`/`IManufacturingOperationService.FindCurrent` (los sidecars
clásicos) de forma **incondicional**, sin importar si era el primer Save o uno subsiguiente.

Una vez que el fix round 1 entra en efecto, el frontend deja de escribir a esos sidecars por
completo apenas existe un `savedProjectId` — quedan **congelados** con el estado del momento del
primer Save. Esto significaba que un segundo Save real (el usuario edita vía PATCH v2, después
pulsa "Guardar" de nuevo para crear un checkpoint) revertía en silencio TODAS las ediciones
hechas desde el primer Save, porque la nueva `DocumentVersion` se construía desde los sidecars
congelados, no desde la fila ya persistida (y potencialmente parcheada) de cada `Layer`.

Confirmado reproduciendo el bug: revertí el fix temporalmente y corrí el test nuevo --
efectivamente, el nombre de la capa volvía a su valor original ("Color 1") en vez de mantener
el nombre asignado vía PATCH antes del segundo Save.

## Fix

`VectorDocumentService.SaveAsync` ahora resuelve, antes de armar cada `LayerSnapshot`, la
`DocumentVersion` ACTUAL del proyecto (`_repository.FindCurrentDocumentAsync`, `null` en el
primer Save) y construye `currentLayersByGroupId`. Para cada layer del layer set clásico
vigente:

- **Si ya existe una fila persistida para ese `GroupId`**: usa su
  `Name`/`Order`/`Visible`/`Locked`/`ManufacturingOperation` tal cual están en la DB —fuente
  autoritativa real, puede reflejar ediciones hechas vía PATCH v2 que los sidecars clásicos ya
  no ven.
- **Si el layer nunca se guardó antes** (primer Save del proyecto, o un layer nuevo que el
  layer set clásico generó después del último Save): usa el estado clásico vigente, mismo
  comportamiento que la tarjeta tenía antes de este fix.

`SvgAssetId`/`PathCount` siguen viniendo SIEMPRE del SVG recién re-leído/re-subido en este
mismo Save (eso no cambia — el contenido geométrico sigue siendo "el vigente del pipeline
clásico", solo la metadata de layout/operación prefiere lo ya persistido).

## Test de regresión agregado

`Save_SecondSave_PreservesEditsMadeViaPatchSinceTheFirstSave_NeverRevertsToTheClassicSidecars`:
Save → PATCH (rename/visible/locked/operación) → segundo Save → `GET .../document` → confirma
que el valor patcheado sobrevivió. Confirmado que este test FALLA sin el fix (reproducido
revirtiendo el cambio temporalmente) y PASA con él.

## Verificación (confirmada de forma independiente por el orquestador)

- `dotnet build` → 0 errores/warnings.
- `dotnet test` → 760/760 (759 de M2.2-S06 + el nuevo test de regresión de esta ronda).
- `pytest`/`npm test`/`npm run build` → sin tocar (diff puramente backend .NET, un solo archivo
  de producción + un test nuevo).
