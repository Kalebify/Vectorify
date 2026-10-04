# IMPL.md — M2.2-S09 · User Ownership + DevelopmentUserContext

## Resumen

Novena tarjeta de MVP 2.2. `IUserContext`, `User`, `Project.OwnerId`, `DevelopmentUserContext` y los
filtros por dueño de los repositorios v2 ya existían desde M2.2-S02/S03: esta tarjeta **cierra la
brecha** contra el criterio de aceptación y la vuelve demostrable con tests de dos usuarios. Solo
backend; sin login real, sin cambios de frontend. Spec: `spec.md` de esta carpeta.

## Qué se agregó

- **Contrato**: `IUserContext` mantiene `GetEffectiveUserId()` y gana `Email` e `IsAuthenticated`.
  `DevelopmentUserContext.IsAuthenticated = true` (identidad resuelta ≠ demostrada; eso es MVP 3.1).
- **Usuario de desarrollo configurable**: `DevelopmentUserOptions` (sección `DevelopmentUser`:
  `UserId`, `Email`, `DisplayName`, mismos defaults de siempre). `DevelopmentUserSeeder` siembra desde
  las opciones, idempotente, sin pisar un usuario existente. `ValidateOnStart` rechaza `Guid.Empty`.
- **Guardrail anti-Production**: `UserContextRegistration.Register(services, env, config)` es el único
  punto de registro. Solo `Development`/`Testing`/`Test`; cualquier otro entorno → el arranque falla
  con `InvalidOperationException` clara. Sin flag para saltearlo.
- **Puente clásico → v2**: `ProjectRecord` gana `Guid? OwnerId = null` (último parámetro con default →
  JSON viejos y los 7 `new ProjectRecord(...)` siguen válidos) y `IsAccessibleBy(userId)`. El upload
  clásico estampa el dueño; `SaveAsync` rechaza con 404 uniforme un triple clásico de otro usuario
  ANTES de crear el Project/subir Assets/generar thumbnail; `GET /api/v1/projects/{p}/images/{i}` y
  `.../original` devuelven 404 uniforme para un dueño distinto.
- **Tests**: `UserOwnershipEndpointsTests` (matriz A vs. B sobre las rutas v2 y el puente clásico,
  incluida una `SimulatedAuthenticatedUserContext` que demuestra el DoD: se reemplaza el contexto sin
  tocar Project/Asset/VectorDocument), `UserContextRegistrationTests` (Development ✔ / Testing ✔ /
  Production ✘ / Staging ✘), `DevelopmentUserSeederTests`, `UserContextArchitectureTests` (ningún
  módulo de la aplicación depende de `DevelopmentUserContext` salvo `Users/` y `Program.cs`).

## Hallazgos de la auditoría (huecos reales; cada uno con test rojo antes del fix)

1. **Puente clásico → v2**: B podía hacer Save con el triple clásico de A (y el thumbnail/sidecars de A
   terminaban en un proyecto de B). Corregido en `SaveAsync`.
2. **`GET /api/v1/.../images/{imageId}` y `/original`** devolvían 200 a cualquier usuario.
3. **Upload clásico con `Idempotency-Key` ajena**: B recibía los `projectId`/`imageId` de A. Ahora el
   replay solo aplica si el registro es accesible para el usuario efectivo.
4. **Save v2 con la `idempotencyKey` de otro usuario**: devolvía 500 (el índice único de
   `DocumentVersion.IdempotencyKey` es global) y de paso revelaba que la key de A existía. La key se
   persiste ahora como `{ownerId:N}:{key}` (sin migración).
5. Rutas v2 de projects/assets/document/versions/restore/PATCH layer: **sin hueco**. La matriz exige
   status + `code` + body idénticos a los de un recurso inexistente y que el recurso de A quede
   intacto.

## Verificación de que los tests no son vacuos

El implementador quitó a propósito el filtro de owner en `ProjectRepository.FindByIdAsync` y en
`VectorDocumentRepository.ListVersionsAsync` (fallaron las rutas correspondientes); el orquestador
repitió el ejercicio desactivando el chequeo del puente clásico en `SaveAsync` (fallaron los 2 tests
del puente) y lo restauró.

## Limitaciones conocidas (fuera de alcance, sin tocar)

- El resto del pipeline clásico (preprocess, threshold, vectorize, simplify, dimension, export, …) se
  direcciona por Guid sin dueño: hardening de MVP 3.1.
- Los uploads clásicos previos a esta tarjeta no tienen dueño (`OwnerId = null`) y siguen accesibles.
- Las filas `DocumentVersion` guardadas antes de esta tarjeta tienen la idempotencyKey sin prefijo: dejan
  de ser replayables (el replay solo cubre el reintento inmediato; aceptable).
- Triple clásico inexistente sigue dando 422 `palette_not_found`; uno ajeno da 404 `not_found`. B ya
  necesita conocer los Guids de A para distinguirlos.
- Con la misma `Idempotency-Key` clásica usada por A y B, la última escritura gana en el registry; un
  replay posterior de A crea un upload nuevo (seguro, no es un replay perfecto).

## Verificación

Ver el reporte de QA en la tarjeta de Notion y el PR (5 comandos corridos de forma independiente).
