# IMPL.md — M3.1-S02 · Registro + creación/vinculación de User

Informe del implementador (web-implementer, adaptado a backend), revisado por el orquestador. Spec: `spec.md`. Base: `docs/ADR_AUTH_MVP31.md`.

## Resumen
Identidad propia con ASP.NET Core Identity + cookie sobre .NET 10: `UserIdentity` (única por Provider+Subject), `AuthDbContext` (esquema `auth`, historial propio),
resolver idempotente/transaccional/concurrente `UserProvisioner`, `UserProvisioningMiddleware`, `AuthenticatedUserContext`, `Auth:Mode` en `UserContextRegistration`,
CORS con credenciales y orígenes explícitos, y `POST /api/v1/auth/register` con respuesta uniforme (202 `{status:"accepted"}`).
El dominio (`Project`, servicios, repositorios, `IUserContext`) no cambió.

## Dependencias
- `Microsoft.AspNetCore.Identity.EntityFrameworkCore` 10.0.13 (solo el almacén EF; UserManager/SignInManager/cookies vienen en el shared framework). Sin otros paquetes.

## Archivos
Producción nuevos: `Data/UserIdentity.cs`, `Data/Auth/{ApplicationUser,AuthDbContext,AuthDbContextFactory}.cs`, `Migrations/20261015221543_AddUserIdentities*`,
`Migrations/Auth/*` (InitialIdentity + snapshot), `Users/{ExternalIdentity,VectorifyClaimTypes,ClaimsIdentityReader,AuthenticatedUserContext,IUserProvisioner,UserProvisioner,UserProvisioningMiddleware,AuthRegistration}.cs`,
`Options/{AuthOptions,AuthOptionsValidator}.cs`, `Endpoints/AuthEndpoints.cs`, `Contracts/AuthContracts.cs`.
Modificados: `Vectorify.Api.csproj`, `Data/User.cs`, `Data/VectorizationDbContext.cs`, snapshot del dominio, `Users/UserContextRegistration.cs`, `Options/FrontendCorsOptions.cs`, `Program.cs`,
`appsettings.Development.json`, `backend/Dockerfile`, `docker-compose.yml`.
Tests nuevos: `AuthApiFixture`, `UserProvisionerTests`, `AuthenticatedUserContextTests`, `AuthOptionsValidatorTests`, `AuthRegisterEndpointTests`, `AuthenticatedModePipelineTests`, `CorsCredentialsTests`, `AddUserIdentitiesMigrationTests`.
Tests modificados: `UserContextRegistrationTests`, `UserContextArchitectureTests`, `MigrationChainTests`.

## Resultados (informados por el implementador)
- Suite completa: 1833 verdes, 0 rojos (1706 previos + ~127 nuevos), 12 min 51 s. Mutación de control: quitar el catch de colisión, devolver 409 en duplicado y quitar el guardrail de Production ⇒ 13 tests rojos.
- Compose aislado con imagen .NET 10: `/health` online; `POST /api/v2/projects` sin sesión ⇒ 201 con el usuario dev; `register` x2 ⇒ 202 idéntico y 1 User + 1 vínculo; preflight con credenciales.
- E2E anónimos: `mvp3_release_e2e_test.mjs` 10/10, `full_pipeline_e2e_test.mjs` 6/6, `upload_e2e_test.mjs` OK.

## Supuestos (el spec no los cubría)
1. Default del código y de Production = `Authenticated`; el modo `Development` lo fijan explícitamente `appsettings.Development.json`, el compose (`${AUTH_MODE:-Development}`) y el Dockerfile (`ENV Auth__Mode=Development`). Production + Development ⇒ no arranca.
2. Registro uniforme = HTTP 202 `{"status":"accepted"}` (el PoC decía «check_your_email»: falso hasta S08).
3. Contraseña: solo largo, 12–128; correo recortado, ≤ 254. Sin reglas de composición.
4. Si crear el `User` falla tras crear la cuenta, el registro igual responde 202 y el middleware crea el `User` en la primera request autenticada.
5. CORS: se enumeran cabeceras (`Content-Type, Accept, Idempotency-Key, X-Correlation-Id`) y métodos (GET/POST/PATCH/DELETE); S03 debe añadir `X-Vectorify-Request`. Origen con comodín o ruta ⇒ no arranca.
6. Las migraciones de Identity se aplican siempre al arrancar (también en Development).
7. `ApplicationUser.CreatedAt` como único campo extra.

## No verificado / pendiente
- `.env.example` no se pudo modificar (regla de denegación del entorno sobre ese archivo): ver las 4 variables a añadir a mano en el comentario de Notion.
- El PoC `backend/spikes/AuthPoc` dejó de compilar (6 CS0104 por tipos con el mismo nombre que los copiados al producto). No está en la solución ni en la imagen. El ADR lo quería vivo hasta S10: hace falta decidir arreglarlo o retirarlo.
- En modo `Authenticated` los endpoints existentes no tienen `RequireAuthorization` (S06): una request anónima lanza `UnauthenticatedUserException` (falla cerrado). El flujo clásico `/api/v1/projects/...` sigue sin comprobar dueño.
- Login, cookie emitida por el servidor y revalidación de `SecurityStamp` (S03/S04). Timing de registro existente/no existente no medido (T5 [N]).
- `npm test` / `npm run build`: sin cambios de frontend, no se corrieron.
- El Dockerfile ya traía `ASPNETCORE_ENVIRONMENT=Development` por defecto (anterior a S02): una imagen sin overrides arranca en modo desarrollo. Queda para S09.
