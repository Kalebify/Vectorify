# IMPL.md — M3.1-S06 · Autorización y aislamiento multiusuario

Informe del implementador (backend), revisado y re-verificado por el orquestador. Spec: `spec.md`. Documento operativo: `docs/AUTH_AUTHORIZATION.md`.

## Resumen
`FallbackPolicy` = usuario efectivo resuelto (denegar por defecto) con `AllowAnonymous` solo en `/health`, `/api/v1/system/health` y `/api/v1/auth/register|login|logout|me`. Comprobación de dueño CENTRAL del flujo clásico: las 16 familias de rutas `/api/v1/projects/{projectId}/images/{imageId}/…` se mapean sobre un grupo (`MapClassicProjectGroup`)
marcado con metadata que lee `ClassicProjectOwnerMiddleware` (una resolución por request, antes del binding y de llamar a Python; mismo 404 `not_found` para ajeno e inexistente). Regla de dueño única en `IClassicProjectAccess`. `/api/v2/*` ya filtraba por `OwnerId` en repositorio/servicio y se audita.
Un registro legado sin dueño falla cerrado en Authenticated y sigue accesible solo para el usuario de desarrollo en Development. `UnauthenticatedUserMiddleware` (S03) se retiró: lo sustituye la política. Sin dependencias nuevas, sin migración de datos, sin URLs firmadas.

## Inventario (EndpointDataSource real): 72 rutas `/api/*` + `/health`
- Anónimas (lista blanca, 6): `GET /health`, `GET /api/v1/system/health`, `POST /api/v1/auth/register|login|logout`, `GET /api/v1/auth/me`. Swagger es middleware previo a la autorización y solo se monta en Development.
- Protegidas (66): 43 con comprobación central de dueño (grupo clásico); 13 con dueño en repositorio/servicio (4 de `/api/v2/projects/{id}`, 3 de assets, 6 de document/versions/restore/editor-save/layers); 10 sin recurso ajeno que direccionar (`POST /api/v1/projects`, `POST|GET /api/v2/projects`, `POST /api/v2/workspaces/save`, `logout-all`, 5 de `/api/v2/geometry/*`).

## Archivos
Nuevos: `Authorization/{ResolvedUserAuthorization,UnauthenticatedJsonResultHandler,ClassicProjectScope,ClassicProjectOwnerMiddleware}.cs`, `Projects/ClassicProjectAccess.cs`, `docs/AUTH_AUTHORIZATION.md`.
Modificados: `Program.cs` (pipeline `UseAuthentication → UserProvisioning → UseAuthorization → ClassicProjectOwnerMiddleware`), `Users/AuthRegistration.cs`, `Projects/ProjectRecord.cs` (`IsAccessibleBy(userId, allowOwnerless)`), `Projects/ProjectUploadService.cs`, `VectorDocuments/VectorDocumentService.cs`, 15 archivos de `Endpoints/*` (solo receptor/paths relativos; URLs finales idénticas), `ProjectEndpoints.cs`. Eliminado: `Middleware/UnauthenticatedUserMiddleware.cs`.
Tests nuevos: `MultiUserIsolationTests` (17), `DevelopmentModeAuthorizationTests` (4), `EndpointAuthorizationArchitectureTests` (4 + 6 controles), `ClassicProjectAccessTests` (8), helpers `RouteInventory`, `EndpointAuthorizationAudit`, `IsolationWorldFixture`. Ajustados sin debilitar: `AuthLoginLogoutTests` (constante), `PersistentProjectRegistryTests` (más estricto), `ProjectUploadServiceTests` (constructor).

## Resultados (re-ejecutados por el orquestador)
- `dotnet build`: 0 errores. `dotnet test Vectorify.sln`: implementador **1967/1967** (1927 + 40 nuevos, 24 min). Mi corrida completa: 1965/1967: fallaron `AuthLoginLogoutTests.Me_AClaimNamedLikeTheInternalOne_InsideTheProviderIdentity_CannotImpersonateAnotherUser` (31 s) y `AuthSessionLifecycleTests.LogoutAll_OnlyAffectsTheAuthenticatedAccount` (39 s); aislados pasan 2/2 dos veces (4-5 s) y las 5 clases de auth/aislamiento/arquitectura juntas pasan 109/109. Causa NO diagnosticada: por la duración (30-40 s vs 4 s) es carga/timeouts, pero no lo he demostrado.
- Mutaciones de control (implementador): sin el middleware de dueño ⇒ 5 tests rojos; ruta nueva fuera del grupo ⇒ 3 de arquitectura + control; sin `FallbackPolicy` ⇒ 6 rojos.
- Compose aislado `vectorify-s06` en Development: E2E anónimos `full_pipeline_e2e_test.mjs` 6/6 y `mvp3_release_e2e_test.mjs` 10/10; en Authenticated (curl): `/health` 200, `/me` 401, v2 y clásico 401 `unauthenticated`. Proyecto `vectify` del usuario sin tocar.

## Supuestos y decisiones
1. `UserProvisioningMiddleware` va antes de `UseAuthorization` (la política se evalúa sobre `IUserContext`); en Development el usuario de desarrollo satisface la política.
2. Dueño central por metadata + middleware (no `IEndpointFilter`): corre antes del binding, así un recurso ajeno no obtiene 400/413 ni dispara Python.
3. Cambio de contrato: el 404 de proyecto inexistente en las etapas clásicas es ahora el 404 central `not_found`; en `workspaces/save` un triple clásico inexistente pasa de 422 a 404 (el 422 era un oráculo de existencia).
4. En Authenticated `POST /api/v1/projects` y `/api/v2/geometry/*` exigen sesión (en Development siguen abiertas para el usuario de desarrollo).
5. Sin migración de datos: los proyectos del usuario de desarrollo y los registros sin dueño quedan huérfanos en Authenticated (intactos en base y disco). Decisión humana ADR P10; reasignación propuesta (SQL/script Node) solo en `docs/AUTH_AUTHORIZATION.md`, sin ejecutar ni probar.
6. Comparación de 404 en los tests excluye cabeceras volátiles (`X-Correlation-Id`, `Date`, `Server`, `Set-Cookie`, `Cache-Control`, `Expires`, `Pragma`).

## No verificado
- Latencias y tiempo de respuesta como oráculo de existencia (solo conteos de resolución de dueño y consultas). E2E en Authenticated con los scripts (S10); frontend no tocado ni corrido. SQL/script de reasignación contra una base real. Accesos directos a Postgres/`App_Data` y backups quedan fuera de esta autorización.
- Primera corrida del implementador: 9 timeouts ~100 s con carga paralela, 3 re-ejecutados aislados en verde, 6 sin re-ejecutar; la segunda corrida limpia dio 1967/1967.
