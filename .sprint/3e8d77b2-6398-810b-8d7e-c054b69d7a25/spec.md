# spec.md — M2.2-S09 · User Ownership + DevelopmentUserContext

## Contexto

Novena tarjeta de MVP 2.2. **Gran parte ya existe** desde M2.2-S02/S03: `User`, `Project.OwnerId`
(FK obligatoria + índice), `IUserContext.GetEffectiveUserId()`, `DevelopmentUserContext` (Guid fijo),
`DevelopmentUserSeeder`, y los repositorios/servicios v2 filtran por `ownerId` (404 uniforme ante
ownership distinto). Esta tarjeta NO rehace eso: cierra lo que falta contra el criterio de aceptación
y la hace **demostrable** (tests con dos usuarios reales).

Criterio (Notion): "Todos los proyectos pertenecen a un User; consultas sensibles filtran por usuario
efectivo; DevelopmentUserContext permite desarrollo y puede reemplazarse en MVP 3.1."
DoD: "Cambiar DevelopmentUserContext por AuthenticatedUserContext no requiere rediseñar
Project/Asset/VectorDocument." Frontera: MVP 2.2 sabe a quién pertenecen los datos; MVP 3.1 demostrará
quién es el usuario. **Sin login real, sin cookies/JWT, sin cambios de frontend.**

## Qué falta (alcance)

### 1. Contrato `IUserContext`
Hoy solo expone `Guid GetEffectiveUserId()`. La tarjeta pide UserId, Email opcional, IsAuthenticated.
- Se **mantiene** `GetEffectiveUserId()` (lo usan ~12 archivos; no se renombra → cero churn).
- Se agregan `string? Email { get; }` e `bool IsAuthenticated { get; }`.
- `DevelopmentUserContext`: `IsAuthenticated = true` (representa una identidad ya resuelta; documentarlo
  en el XML doc: "autenticado" ≠ "demostrado", eso es MVP 3.1), `Email` desde opciones.
- La aplicación (servicios/repos/endpoints) depende SOLO de `IUserContext`: ningún `using` de
  `DevelopmentUserContext` fuera de `Vectorify.Api.Users` y `Program.cs` (verificable con un test
  de arquitectura simple por reflexión/lectura de tipos, o con grep documentado en IMPL.md).

### 2. Usuario de desarrollo configurable
- `DevelopmentUserOptions` (sección de config `DevelopmentUser`): `UserId` (default = el Guid fijo
  actual `00000000-0000-0000-0000-000000000001`), `Email` (default `dev@vectorify.local`),
  `DisplayName` (default `Dev User`). Validar `UserId != Guid.Empty`.
- `DevelopmentUserContext` y `DevelopmentUserSeeder` leen las opciones (el seeder siembra
  `Id/Email/DisplayName`; idempotente; si el usuario ya existe no pisa datos salvo que hagan falta
  Email/DisplayName vacíos — decisión conservadora: no modificar un usuario existente).
- "Seed reproducible": mismos defaults siempre; test que verifica seed idempotente y que cambiar
  `DevelopmentUser:UserId` por config siembra OTRO usuario.

### 3. Guardrail anti-Production (fail-fast al arrancar)
- `DevelopmentUserContext` solo se registra cuando `builder.Environment` es `Development` o `Testing`/
  `Test` (revisá cómo nombran el entorno los tests existentes con `WebApplicationFactory`, que por
  defecto usa `Development`; el docker-compose usa `ASPNETCORE_ENVIRONMENT` default `Development`).
- En cualquier otro entorno (p. ej. `Production`, `Staging`) el arranque **falla con
  `InvalidOperationException`** de mensaje claro (no existe `IUserContext` autenticado todavía; MVP 3.1
  lo provee; `DevelopmentUserContext` no puede activarse fuera de Development/Testing). Extraer la
  decisión a un método **testeable** (p. ej. `UserContextRegistration.Register(IServiceCollection,
  IHostEnvironment, IConfiguration)`), con tests para Development ✔, Testing ✔, Production ✘,
  Staging ✘. No existe flag para saltarse el guardrail.
- Un único punto de registro de `IUserContext` (reemplazar el `AddScoped` suelto de `Program.cs`).

### 4. Ownership: auditoría + cruce real entre usuarios
Auditar CADA ruta v2 y confirmar que filtra por el usuario efectivo y que **nunca** confía en un
ownerId enviado por el frontend (los DTOs de request no deben tener campo de owner):
- `/api/v2/projects` (POST/GET list/GET/PATCH/DELETE/duplicate),
- `/api/v2/projects/{id}/assets` (POST/GET/DELETE),
- `/api/v2/projects/{id}/document`, `/versions`, `/versions/{n}`, `/versions/{n}/restore`,
  `PATCH /layers/{layerId}`,
- `POST /api/v2/workspaces/save` con `ProjectId` de otro usuario,
- reapertura por idempotencyKey (`FindByIdempotencyKeyAsync` ya scoped por owner: verificar que un
  replay de la key de A hecho por B NO devuelve la versión de A).
Cualquier hueco que aparezca se **corrige en esta tarjeta** (documentar cada hallazgo en el reporte).
**Tests (Testcontainers PostgreSQL real, sin InMemory)**: infraestructura de test para correr como
Usuario A y Usuario B contra la MISMA base (p. ej. dos factories con `DevelopmentUser:UserId`
distintos compartiendo conexión/storage, o un `IUserContext` de test intercambiable — usá el
mecanismo más simple y que ejercite el DI real), y una matriz "B no puede leer/modificar/borrar lo
de A": cada ruta de la lista de arriba devuelve **404 uniforme** (idéntico al de un recurso
inexistente: mismo status y mismo `code`), y el recurso de A queda intacto después. El listado de B
no contiene proyectos de A (y viceversa); `GET list` con `search` tampoco filtra por fuera del owner.

### 5. Puente clásico → v2 (el único hueco de ownership conocido)
Los uploads del flujo clásico (`ProjectRecord`, JSON en disco) NO tienen dueño; `POST
/api/v2/workspaces/save` recibe `(classicProjectId, imageId, paletteId)` y lee de ahí el original
(thumbnail) y el estado de sidecars: hoy el usuario B podría guardar en SU proyecto el contenido
clásico subido por A conociendo los Guids.
- `ProjectRecord` gana `Guid? OwnerId = null` como **último parámetro con default** (los 7 sitios
  `new ProjectRecord(...)` y los JSON viejos en disco siguen válidos; `null` = registro previo sin
  dueño, se sigue permitiendo).
- El upload clásico (`ProjectUploadService`) estampa el usuario efectivo (`IUserContext`).
- `VectorDocumentService.SaveAsync`: si el registro clásico existe y tiene `OwnerId` distinto del
  usuario efectivo → resultado **NotFound uniforme** (mismo que "no existe"), SIN crear Project ni
  subir Assets (hacer el chequeo antes de crear el Project) y SIN generar thumbnail.
- `GET /api/v1/projects/{projectId}/images/{imageId}` y `.../original`: mismo criterio (404 si el
  registro tiene dueño distinto). El resto del pipeline clásico (preprocess/threshold/vectorize/…)
  queda **fuera de alcance**: las demás etapas se direccionan por Guid sin dueño; se documenta como
  limitación conocida (hardening de MVP 3.1) — NO se toca.
- Tests: A sube, B intenta Save con el triple de A → 404 y no queda Project/Asset huérfano de B; A sí
  puede; registro sin `OwnerId` (JSON viejo) sigue funcionando; GETs v1 de la imagen de A → 404 para B.

### 6. DoD demostrado
Un test que registra una **segunda implementación de `IUserContext`** (doble de test que representa un
`AuthenticatedUserContext`: Id/Email/IsAuthenticated desde un `ClaimsPrincipal` simulado o similar)
en lugar de `DevelopmentUserContext` y corre el flujo Project/Asset/VectorDocument sin tocar nada de
esos módulos. (Es el mismo mecanismo de la matriz del punto 4; no duplicar infraestructura.)

## Fuera de alcance
Login/OAuth/JWT/cookies, UI de usuarios, roles/permisos, compartir proyectos, ownership de las demás
etapas del pipeline clásico, migración de datos previos (no se puede inferir dueño de uploads viejos),
cambios de frontend.

## Tests exigidos
Además de lo indicado arriba: `dotnet build` (0 errores/warnings), `dotnet test`, `pytest` (sin tocar),
`npm test`, `npm run build`.
