# IMPL.md — M3.1-S03 · Login + Logout

Informe del implementador (adaptado a backend + cliente HTTP), revisado y re-verificado por el orquestador. Spec: `spec.md`. Base: `docs/ADR_AUTH_MVP31.md`; S02: `.sprint/3e8d77b2-6398-81c8-835c-fb711ce83b9d/IMPL.md`.

## Resumen
`POST /api/v1/auth/login` (lockout 5 fallos / 15 min, 401 idéntico para cuenta inexistente, contraseña mala y bloqueada), `POST /api/v1/auth/logout` (rota el `SecurityStamp` y borra la cookie),
`GET /api/v1/auth/me` (solo desde la identidad verificada de la cookie), `CsrfGuardMiddleware` (cabecera `X-Vectorify-Request` + `Origin` permitido, solo en modo Authenticated),
CORS con la cabecera nueva, `UnauthenticatedUserMiddleware` (401 en vez de 500 sin sesión) y cliente HTTP con `credentials: "include"` + cabecera. Sin pantallas (S05). Sin dependencias nuevas.

## Archivos
Backend: `Endpoints/AuthEndpoints.cs`, `Contracts/AuthContracts.cs`, `Middleware/CsrfGuardMiddleware.cs` (nuevo), `Middleware/UnauthenticatedUserMiddleware.cs` (nuevo), `Users/InternalIdentityReader.cs` (nuevo),
`Users/AuthenticatedUserContext.cs`, `Program.cs`.
Tests backend: `EndToEnd/AuthLoginLogoutTests.cs` (39, cookies emitidas por el servidor), `TestSupport/CsrfTestExtensions.cs`, `AuthenticatedModePipelineTests.cs` (clientes con `.WithCsrf()`), `CorsCredentialsTests.cs`.
Frontend: `api/httpClient.ts` (`request` y `uploadFile`), `api/authApi.ts`, `types/auth.ts`, `api/httpClient.test.ts` (9), `api/authApi.test.ts` (9), `test/FakeXMLHttpRequest.ts` (`withCredentials`).

## Resultados (re-ejecutados por el orquestador)
- `dotnet build`: 0 errores. `dotnet test Vectorify.sln`: **1876/1876** (1833 previos + 43 nuevos), 16 min 32 s. `AuthPoc.Tests`: 38/38 (implementador).
- Frontend `npm test`: **3280/3280** (139 archivos; 3260 previos + 20 nuevos). `npm run build`: correcto (solo el aviso previo de tamaño de chunk).
- Mutación de control (implementador): sin rotación de `SecurityStamp` y con el guard desactivado, 10 tests rojos.

## Decisiones y supuestos
1. Logout rota el `SecurityStamp` y borra la cookie; tras el logout `/me` y los endpoints protegidos dan 401 con la misma cookie. Las copias robadas se invalidan al revalidarse (`Auth:Session:RevalidationInterval`, 5 min por defecto): ventana de hasta 5 min; cerrarla es S04. Si la rotación falla: cookie borrada y 503 `logout_incomplete`.
2. Logout idempotente y tolerante a anónimo (204 sin sesión o con cookie basura); sujeto al CsrfGuard.
3. `Origin` ausente ⇒ 403 en modo Authenticated (lectura literal de «falta/ajeno»); los E2E de S10 deberán enviar cabecera y `Origin`; con proxy de mismo origen, `Cors__AllowedOrigins` debe incluir el origen público de la SPA.
4. El frontend envía la cabecera en todo fetch (también GET): preflight en cada GET cross-origin en desarrollo; mitigado con `Access-Control-Max-Age` 600 s.
5. 401 de login: `invalid_credentials` / «Correo o contraseña incorrectos.» con cuerpo, cabeceras y longitud idénticos; hash de relleno para cuenta inexistente. Timing de la cuenta bloqueada no medido.
6. `UnauthenticatedUserMiddleware` convierte `UnauthenticatedUserException` en 401 `unauthenticated` (para cumplir el DoD antes de S06); S06 lo sustituirá por `FallbackPolicy`.
7. En modo Development `/login` y `/me` funcionan con cookie real, pero `IUserContext` sigue siendo el usuario de desarrollo; el CsrfGuard no aplica.
8. Login sin «recordarme» (`isPersistent: false`, S04). El nombre de la cabecera es constante, no configurable (el ADR listaba `Auth__Csrf__HeaderName`: no implementado). Sin variables de entorno nuevas.

## No verificado
- Navegador real: `Secure`, `__Host-` y `SameSite=Lax` sobre `http://localhost` (riesgo [N] del ADR); solo se verificó la cabecera `Set-Cookie` con TestServer.
- E2E `tests/e2e/*.mjs` y `docker compose` no se ejecutaron en S03 (sin cambios de comportamiento en Development).
- Ventana de revalidación por defecto (5 min), timing del login, rate limiting (S09), key ring persistente (S04).
- «Back button» y «múltiples pestañas» a nivel UI: S05 (a nivel servidor, dos cookies simultáneas, sí hay test).
- Una corrida intermedia del implementador tuvo 2 fallos en `EditorShell.history.test.tsx` (archivo no tocado, sensible al tiempo bajo carga); mi corrida completa: 3280/3280.
