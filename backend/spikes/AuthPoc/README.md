# AuthPoc — spike de M3.1-S01 (identidad autenticada → `IUserContext`)

PoC **desechable pero ejecutable** que respalda `docs/ADR_AUTH_MVP31.md`. Demuestra que el dominio de VECTORiZE solo necesita un
`ClaimsPrincipal` y que da igual quién lo autentica:

```
 identidad autenticada ──► AuthenticatedUserContext ──► User local ──► GET /api/v2/projects filtra por OwnerId
 (A) JWT de un emisor OIDC simulado      (IUserContext)    (Provider+Subject
 (B) ASP.NET Core Identity + cookie                         → Users.Id, idempotente)
```

- **(A)** `AddJwtBearer` con *OIDC discovery* simulado (un `HttpMessageHandler` sirve `/.well-known/openid-configuration` y el JWKS;
  la clave RSA se genera en cada test). Es el *stand-in* de cualquier proveedor gestionado (Auth0, Entra External ID, Clerk, Keycloak…).
- **(B)** ASP.NET Core Identity autoalojado con cookie `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, defensa CSRF por cabecera
  personalizada + `Origin`, bloqueo de cuenta, CORS con credenciales.
- Los **mismos** tests de contrato (`Contract/IdentityBoundaryContract.cs`) corren contra las dos fuentes y contra los endpoints
  **reales** del producto (`MapProjectV2Endpoints`, `ProjectService`, `ProjectRepository`, `VectorizationDbContext`).

## Aislamiento

- **No** está en `backend/Vectorify.sln` y **no** entra a la imagen Docker (el `Dockerfile` solo copia `Vectorify.Api/`; además
  `backend/.dockerignore` excluye `spikes/`).
- Los paquetes de autenticación (`JwtBearer`, `Identity.EntityFrameworkCore`, `TestHost`) solo existen en estos dos proyectos.
- Referencia a `Vectorify.Api` **sin modificarlo**: `git diff` sobre `Project.cs`, `ProjectService.cs`, `ProjectRepository.cs`,
  `VectorDocumentService.cs` (y todo `Vectorify.Api/`) está vacío. El `UserContextRegistration` del producto **no** se usa ni se toca.
- Las tablas propias del spike (ASP.NET Core Identity y el vínculo `user_identities`) viven en el esquema `poc_auth` de la base de test;
  el `VectorizationDbContext` del producto no cambia.
- Sin secretos: la clave RSA y las contraseñas se generan en los tests (`TestSecrets`, `FakeOidcIssuer`); no hay ninguna versionada.

## Cómo correrlo

Requisitos: SDK .NET 9 y **Docker en marcha** (Testcontainers levanta un `postgres:17-alpine` efímero, igual que los tests del producto).

```bash
cd backend
dotnet test spikes/AuthPoc/AuthPoc.Tests/AuthPoc.Tests.csproj
```

La primera vez restaura paquetes (varios minutos en un disco sincronizado con OneDrive); después tarda ~20 s. Sin Docker los tests
de contrato fallan al iniciar el contenedor; los unitarios (`Units/`) no lo necesitan:

```bash
dotnet test spikes/AuthPoc/AuthPoc.Tests/AuthPoc.Tests.csproj --filter "FullyQualifiedName~Units"
```

## Qué demuestran los tests

| Archivo | Qué prueba |
|---|---|
| `Contract/IdentityBoundaryContract.cs` (corre con A **y** B) | usuario nuevo ⇒ `User` creado **una sola vez** (3 requests seguidas y 12 en paralelo, sin huérfanos); dos usuarios ven **solo sus proyectos** y un ID ajeno ⇒ **404** (GET/PATCH/DELETE); sin credencial ⇒ **401** en todos los endpoints y no se crea ningún usuario; el dominio resuelto son los tipos reales del producto y solo `IUserContext` cambia |
| `Contract/OidcJwtSourceTests.cs` (A) | token **expirado**, **firma inválida** (otra clave con el mismo `kid`), **emisor** o **audiencia** incorrectos, `alg:none`, HS256, sin `sub`, cabeceras mal formadas ⇒ **401**; el discovery/JWKS se descubren (no hay clave hardcodeada); un claim `vectorify:uid` dentro del token **no** suplanta a otro usuario; mismo `sub` en dos emisores ⇒ dos usuarios; el correo no es identidad |
| `Contract/AspNetIdentityCookieSourceTests.cs` (B) | **cookie manipulada**/truncada/basura ⇒ **401**; atributos `HttpOnly`/`Secure`/`SameSite=Lax`/`__Host-`; login sin enumeración de cuentas y con bloqueo tras 5 fallos; registro uniforme; **CSRF** (sin cabecera personalizada u `Origin` ajeno ⇒ 403); CORS con credenciales solo para el origen configurado; rotar el `SecurityStamp` revoca las sesiones emitidas |
| `Units/AuthenticatedUserContextTests.cs` | `ClaimsPrincipal` → `IUserContext` sin host ni base: identidad externa sola no basta; el claim interno solo se lee de la identidad interna; ids inválidos |

## Qué NO cubre (ver el ADR, «Qué no se verificó»)

Un proveedor gestionado **real** (exige crear un tenant/cuenta: tarea humana), email (verificación/recuperación), login social, MFA,
refresh tokens, comportamiento en un navegador real (cookies `Secure` sobre `http://localhost`), persistencia del *key ring* de
Data Protection entre reinicios, rate limiting, TLS/HSTS ni .NET 10 (en esta máquina solo hay SDK 9).

## Mapa de archivos

```
AuthPoc/
  Identity/ExternalIdentity.cs      ExternalIdentity, VectorifyClaimTypes, ClaimsIdentityReader (ClaimsPrincipal → Provider+Subject)
  Users/AuthenticatedUserContext.cs IUserContext sobre un ClaimsPrincipal
  Users/UserProvisioner.cs          (Provider,Subject) → User.Id, idempotente y a prueba de carreras (índice único + transacción)
  Persistence/                      UserIdentity (modelo propuesto), AuthPocDbContext (Identity + vínculo, esquema poc_auth), AuthPocSchema
  Hosting/AuthPocHost.cs            composición: dominio del producto + UNA fuente de identidad; MapGroup().RequireAuthorization()
  Hosting/Middleware.cs             UserProvisioningMiddleware, CsrfGuardMiddleware
AuthPoc.Tests/
  Support/                          PostgresFixture (Testcontainers), FakeOidcIssuer, Harnesses (host por fuente)
  Contract/ , Units/                tests (ver tabla)
```
