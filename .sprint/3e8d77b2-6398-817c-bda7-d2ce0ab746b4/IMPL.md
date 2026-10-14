# IMPL.md — M3.1-S01 · Arquitectura Identity/Auth + spike de proveedor

## Resumen
ADR de identidad y autenticación (`docs/ADR_AUTH_MVP31.md`, 459 líneas) y un PoC aislado (`backend/spikes/AuthPoc/`) que demuestra la frontera
`identidad autenticada → AuthenticatedUserContext → User local (Provider+Subject → User.Id) → GET /api/v2/projects filtra por OwnerId` con **dos fuentes
de identidad intercambiables** (emisor OIDC simulado y ASP.NET Core Identity con cookie), sin tocar el dominio. **El producto no cambió.**

## Decisión (estado: recomendada, pendiente de confirmación de la persona dueña)
Recomendación: **ASP.NET Core Identity con sesión en cookie `HttpOnly`/`Secure`/`SameSite=Lax`**, en la propia API y sobre el Postgres existente. Motivos verificados:
el frontend usa URL directas (`<img src>`, previews, miniaturas, descargas) que con cookie funcionan sin reescribirse; el coste no decide hoy (topes gratuitos verificados:
Auth0 25 000 MAU, Clerk 50 000 MRU, Entra External ID 50 000 MAU); la residencia UE solo queda bajo control propio con Identity. Pasaría a proveedor gestionado
(Entra External ID o Auth0) si hace falta MFA/social desde el día 1, si no se quiere operar el email, o si hace falta SSO empresarial. **S02–S10 no empiezan hasta confirmar.**

## Hallazgos que cambian el plan (verificados)
- **.NET 9 (y .NET 8) terminan soporte el 2026-11-10**; el backend está en `net9.0`. Migrar a .NET 10 LTS antes de S02 (ADR, sección de migración; no probado: solo hay SDK 9 en la máquina).
- **Autorización de recursos casi inexistente en la API v1**: de las 55 rutas `/api/v1/projects/{projectId…}`, solo 2 comprueban dueño, y `ProjectRecord.IsAccessibleBy` devuelve `true`
  cuando `OwnerId is null`. `/api/v2/*` sí filtra. Convierte a S06 en la tarjeta crítica (default-deny) y rompe los E2E de `tests/e2e/*.mjs` (llaman sin credenciales) ⇒ impacto en S10.
- `User.ExternalIdentityId` existe pero ninguna línea lo usa; el modelo definitivo propuesto es una tabla `UserIdentity` con índice único `(Provider, Subject)`.
- El CORS no permite credenciales y `httpClient.ts` no envía `credentials`: el cambio a cookies obliga a tocar ambos (S03/S04).

## Entregado
- `docs/ADR_AUTH_MVP31.md`: requisitos, alcance, threat model T1–T15, comparación en todos los ejes, diagramas, decisión, variables/config, impacto en S02..S10, migración a .NET 10, preguntas abiertas.
- `backend/spikes/AuthPoc/` (librería + tests xUnit, README): fuera de `Vectorify.sln` y de la imagen Docker; añadido `**/spikes` a `backend/.dockerignore`.

## Verificación (orquestador, independiente)
- `dotnet build Vectorify.sln`: 0 errores. `dotnet test backend/spikes/AuthPoc/AuthPoc.Tests` (Postgres real por Testcontainers): **38/38**.
- Tests de control del implementador: sin `RequireAuthorization()` fallan 11 tests de 401; 12 solicitudes paralelas de un usuario nuevo resuelven 20 colisiones del índice único con 1 usuario y 0 huérfanos.
- `git diff` sobre `Vectorify.Api`, `Vectorify.Api.Tests` y `Vectorify.sln`: vacío (el producto no cambió). Tests del producto sobre Users/Ownership/ProjectV2: 48/48 (corrida del implementador).

## NO verificado
Migración a .NET 10 (versiones de EF/Npgsql/Swashbuckle/Testcontainers, imágenes Docker); lo que ofrece Identity en .NET 10; cualquier proveedor gestionado real (exige crear un tenant: tarea humana);
precios a 100 k MAU y qué plan trae MFA; residencia UE de Auth0/Entra/Clerk/Cognito; exportación de usuarios; cookies `Secure`/`__Host-` sobre `http://localhost` en navegadores reales; persistencia del key ring
de Data Protection; rate limiting/TLS/HSTS; XSS actual del frontend; enumeración por temporización; sesión en servidor (`ITicketStore`). Los títulos de S02–S10 en el ADR se infirieron de la asignación del spec.
