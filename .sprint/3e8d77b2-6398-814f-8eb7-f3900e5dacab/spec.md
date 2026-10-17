# M3.1-S06 · Autorización y aislamiento multiusuario
URL: https://app.notion.com/p/3e8d77b26398814f8eb7f3900e5dacab
Stack declarado: ASP.NET Core, Infra (propiedad Área). ASP.NET Core Identity + cookie (S02-S05), .NET 10.

## Requerimiento (transcripción del cuerpo de la tarjeta)
Objetivo: Aplicar autorización server-side consistente para Projects, Assets, Documents, Versions y exports.

## Principio
Autenticación ≠ autorización. Tener sesión no concede acceso a un projectId.
## Backend
Policies/authorization service central. Resolver ownership por Project. No confiar en filtros del frontend.
## Recursos
Project, Asset, VectorDocument, DocumentVersion, Layer mutations y exports/downloads.
## Respuestas
Evitar filtrar existencia de recursos ajenos cuando sea apropiado.
## Storage
URLs de descarga deben respetar autorización; si se usan signed URLs, expiración corta y generación solo tras policy.
## Tests
Matriz UserA/UserB para GET/PATCH/DELETE/download/duplicate/version restore.
## DoD
Existe suite automatizada específica de aislamiento tenant/user.

## Criterios de aceptación
- User A no puede listar, leer, editar, exportar ni borrar recursos de User B incluso con IDs conocidos. (declarado)
- DERIVADO (ADR «Impacto concreto en S06», T11): `FallbackPolicy` = usuario autenticado (denegar por defecto); `AllowAnonymous` explícito y mínimo en `/health`, `/api/v1/system/health`, `/api/v1/auth/register|login|logout|me`, Swagger (solo Development). En modo `Development` (usuario de desarrollo, sin login) la política debe quedar satisfecha por el usuario de desarrollo, de modo que el flujo actual y los E2E anónimos sigan funcionando.
- DERIVADO: el ADR cuenta ~52 rutas `/api/v1/projects/{projectId…}` del flujo clásico (preprocess, threshold, vectorize, simplify, check, dimensions, paleta, capas, componentes, unión, operaciones, layout, geometría, export, etc.) que NO comprueban dueño (solo 2 lo hacen: `GET …/images/{imageId}` y `GET …/original`). Cerrar TODAS con una comprobación de dueño CENTRAL (un filtro de endpoint / servicio de autorización compartido aplicado a todo el grupo `/api/v1/projects/{projectId}`; no 52 `if`), con 404 uniforme (mismo cuerpo y cabeceras que «no existe») ante recurso ajeno.
- DERIVADO: `/api/v2/projects*`, assets, `VectorDocument`, `DocumentVersion` (incluida restauración de versión y duplicado), mutaciones de capa y exports/descargas: mismo criterio (dueño por Project, 404 uniforme). Las descargas por URL directa (`<img src>`, previews, miniaturas, export) respetan la autorización con la cookie; no se introducen URLs firmadas (documentar).
- DERIVADO: `ProjectRecord.OwnerId == null` (registros clásicos legados, hoy accesibles por CUALQUIERA): en modo Authenticated NO son accesibles por ningún usuario (falla cerrado, 404); en modo Development siguen accesibles para el usuario de desarrollo. El destino definitivo de los datos del usuario de desarrollo y de los registros sin dueño (reasignar a un usuario, borrar o dejar huérfanos) es una DECISIÓN HUMANA abierta (ADR P10): documentar el estado y cómo reasignar (script/consulta SQL propuesta, sin ejecutarla ni migrar datos).
- DERIVADO: que un POST/PUT cree recursos siempre con el `OwnerId` del servidor (`IUserContext`); ningún `ownerId`/`userId` enviado por el cliente se respeta (RS10).
- DERIVADO: test de ARQUITECTURA: todo endpoint `/api/*` descubierto por reflexión sobre el `EndpointDataSource` lleva autorización por defecto y comprobación de dueño, o está en una lista blanca explícita y justificada; añadir una ruta nueva sin protección rompe el test.
- DERIVADO: suite específica de aislamiento (UserA/UserB) con matriz por recurso y método: GET (lista y detalle), PATCH, DELETE, descarga/export, duplicado, restauración de versión, mutaciones de capa/paleta/componentes/unión/operaciones/layout y las etapas del pipeline clásico. Incluye IDs bien formados pero ajenos, IDs inexistentes (misma respuesta que ajenos), usuario anónimo (401) y, en modo Development, el flujo del usuario de desarrollo intacto.
- DERIVADO: los tests existentes (1927 backend, 3454 frontend) siguen verdes; los E2E anónimos `tests/e2e` siguen pasando en Development; en modo Authenticated se espera 401 sin sesión (los scripts adaptados a cookie jar son S10: fuera de alcance).

## Referencias visuales / de marca
No aplica.

## Contexto técnico vinculante
`docs/ADR_AUTH_MVP31.md` (T11, T13, «Impacto concreto en S06», contexto del código: solo 2 de 55 coincidencias comprueban dueño; `IsAccessibleBy` devuelve true si `OwnerId is null`; `/api/v2/projects*` y `…/assets` ya filtran por `OwnerId`), `docs/AUTH_SESSION_LIFECYCLE.md`, IMPL de S02-S05 en `.sprint/` (middlewares: `UserProvisioningMiddleware`, `UnauthenticatedUserMiddleware` —que S06 sustituye por `FallbackPolicy`—, `CsrfGuardMiddleware`). Dominio: `Project.OwnerId` FK a `users.Id`; `ProjectRecord` (file registries bajo App_Data), `ProjectService`, `IProjectRepository`, `VectorDocumentService`.

## Umbrales de calidad
Sin UI. `dotnet build` 0 errores; `dotnet test Vectorify.sln` verde (con Docker); `npm test`/`npm run build` verdes (frontend sin cambios esperados, salvo ajustes de manejo de 404/401 si hicieran falta); sin regresión de rendimiento apreciable por la comprobación de dueño (una sola resolución por request, sin N+1).

## Ambigüedades detectadas
Ninguna que impida empezar. Decisiones abiertas con valor por defecto: P10 (destino de datos legados/usuario de desarrollo): por defecto fallar cerrado en Authenticated y documentar la reasignación; respuesta «existe pero ajeno» = 404 uniforme (no 403) para no filtrar existencia; sin URLs firmadas.
