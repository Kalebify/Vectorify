# IMPL-fix-round-1.md — M2.2-S06 · Migración con pérdida de datos + PATCH no inmutable

## Bugs reportados por QA (3 hallazgos reales en una sola prueba manual)

1. La migración `MoveDocumentDimensionsToVersion` hacía `DropColumn` de `WidthMm`/`HeightMm`/
   `ViewBox`/`SchemaVersion` en `vector_documents` ANTES de copiar esos valores a
   `document_versions` — cualquier proyecto real ya guardado por M2.2-S05 perdía sus
   dimensiones (quedaban en 0/0/""/0).
2. La misma migración agregaba `Layer.GroupId` con `Guid.Empty` para TODAS las filas existentes
   y RECIÉN DESPUÉS creaba el índice único `(VersionId, GroupId)` — un documento multicolor real
   (2+ layers en la misma versión) hacía fallar la migración completa (dos filas `Guid.Empty` en
   la misma versión chocan contra el índice).
3. `UpdateLayerAsync` (PATCH) seguía mutando la fila de `Layer` de la versión ACTUAL in-place —
   la misma clase de violación de inmutabilidad que esta tarjeta ya había corregido para
   Save/Restore, pero no para PATCH. Consultar una versión como histórica DESPUÉS de un PATCH
   devolvía contenido distinto del checkpoint original.

## Fix 1 y 2: migración reescrita con backfill real

Orden correcto: agregar columnas nuevas (con default temporal) → `UPDATE` SQL real copiando
`WidthMm`/`HeightMm`/`ViewBox`/`SchemaVersion` de `vector_documents` a cada `DocumentVersion`
que le pertenece → `UPDATE layers SET "GroupId" = "Id"` para todas las filas existentes (antes
de esta tarjeta, `Layer.Id` SÍ era el groupId clásico reutilizado verbatim, así que `Id` es el
valor correcto) → recién ahí `CreateIndex` único `(VersionId, GroupId)` (sin colisión posible:
`Id` ya era la PK global de la tabla, única en TODA la tabla, por lo que `GroupId = Id` es
automáticamente único dentro de cualquier subconjunto agrupado por `VersionId`) → `DropColumn`
de las columnas viejas en `vector_documents`.

`Down()` reescrito en el mismo espíritu (reconstruye `vector_documents` desde la
`DocumentVersion` ACTUAL de cada `Project` antes de borrar las columnas nuevas) — un rollback de
este alcance ya implica perder historial por-versión de todas formas (esas columnas nunca
estuvieron versionadas antes de esta tarjeta).

**Test de regresión**: `MoveDocumentDimensionsToVersionMigrationTests` aplica todas las
migraciones EXCEPTO la última (deja la base en el esquema exacto de M2.2-S05), inserta un
documento multicolor real (2 layers en la misma versión, vía SQL crudo) con dimensiones
pobladas, aplica la migración reescrita, y confirma: no lanza excepción, las dimensiones
sobreviven, y `GroupId == Id` original por fila.

## Fix 3: `UpdateLayerAsync` crea una versión nueva, nunca muta la actual

PATCH es, igual que Save/Restore, un checkpoint: crea una `DocumentVersion` completa nueva
(mismo patrón de copia fresca que `RestoreAsync` — todos los `Layer`/`PaletteColor` de la
versión actual, ids nuevos), aplica el patch SOLO sobre la copia nueva del layer identificado
por `GroupId`, `Origin: ManualEdit`, repunta `Project.CurrentVersionId`. Misma transacción EF
explícita de dos fases y mismo manejo de concurrencia (`xmin` → 409, ahora también en
`VectorDocumentService.UpdateLayerAsync`/el endpoint PATCH, que antes no lo necesitaban porque
la mutación in-place nunca tocaba `Project`).

**Test de regresión** (repositorio + HTTP): Save (V1, 2 layers) → PATCH un layer → confirma que
V1 (releída desde un `DbContext` nuevo) sigue con su contenido original intacto, que se creó V2
con el patch aplicado y el resto de los layers preservados, y que `Project.CurrentVersionId`
apunta a V2. El test HTTP agrega: `GET .../versions/1` sigue devolviendo el nombre original,
`GET .../document` (V2) devuelve el nombre patcheado.

Dos tests preexistentes de M2.2-S05/S06 que codificaban el comportamiento viejo (mutación
in-place) se actualizaron para reflejar el nuevo número de versión que un PATCH de por medio
ahora produce (cada PATCH es su propio checkpoint).

## Verificación (confirmada de forma independiente por el orquestador)

- `dotnet build` → 0 errores/warnings.
- `dotnet test` → 784/784 (incluye los 3 tests nuevos de esta ronda: el de upgrade de la
  migración, y los dos de PATCH-crea-versión-nueva a nivel repositorio y HTTP).
- `pytest`/`npm test`/`npm run build` → sin tocar (diff puramente backend .NET, confirmado por
  `git diff --stat`).
