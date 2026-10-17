# IMPL.md — M3.1-S04 · Sesiones, cookies/tokens y renovación

Informe del implementador (backend + cliente HTTP + infra), revisado y re-verificado por el orquestador. Spec: `spec.md`. Documento del ciclo de sesión: `docs/AUTH_SESSION_LIFECYCLE.md`.

## Resumen
Sesión de 8 h deslizante; «recordarme» (`rememberMe` en login) = cookie persistente con tope ABSOLUTO de 30 días dentro del ticket cifrado (`SessionCookie`); revalidación del `SecurityStamp` cada 5 min (+ 30 s de `ClockSkew`, con guarda de desfase de reloj);
`POST /api/v1/auth/logout-all` (sesión obligatoria, mismo CSRF); Data Protection con key ring persistente (`Auth__DataProtection__KeysPath`, volumen en compose, obligatorio fuera de Development/Testing/Test);
frontera 401 en el cliente (`sessionBoundary.ts`: un único evento «sesión expirada» ante 401 concurrentes, sin reintentos). Sin tokens en el navegador, sin dependencias nuevas, sin pantallas (S05).

## Archivos
Backend: `Options/AuthOptions.cs` + `AuthOptionsValidator.cs` (RememberMeLifetime, ClockSkew, KeysPath validados al arrancar), `Users/SessionCookie.cs` (nuevo), `Users/AuthRegistration.cs`, `Endpoints/AuthEndpoints.cs` (rememberMe, logout-all, rotación compartida), `Contracts/AuthContracts.cs`, `docker-compose.yml`.
Tests backend: `EndToEnd/AuthSessionLifecycleTests.cs` (37), `TestSupport/ControllableTimeProvider.cs`, `AuthOptionsValidatorTests.cs` (+13), `UserContextRegistrationTests.cs` (Production exige KeysPath).
Frontend: `api/sessionBoundary.ts` (+ test, 21), `api/httpClient.ts`, `api/authApi.ts` (+3 tests, `logoutAll`), `types/auth.ts`. Docs: `docs/AUTH_SESSION_LIFECYCLE.md`.

## Resultados (re-ejecutados por el orquestador)
- `dotnet build`: 0 errores. `dotnet test Vectorify.sln`: **1926/1926** (1876 previos + 50 nuevos), 17 min 29 s.
- Frontend `npm test`: **3308/3308** (140 archivos; 3280 previos + 28 nuevos). `npm run build`: correcto.
- Implementador: mutación de control (sin tope absoluto, sin guarda de desfase, sin key ring persistente) ⇒ 5 tests rojos. Compose aislado con imagen real: cookie `rememberMe` con `max-age=2591999`, la misma cookie sigue válida tras `docker compose restart backend` (key ring en volumen); E2E anónimos en Development 10/10 y 6/6.

## Supuestos
1. «Recordarme» = tope absoluto fijo de 30 d desde el login, sin ventana de inactividad. La sesión normal se desliza 8 h indefinidamente con el uso (sin tope absoluto).
2. Identity reemite el ticket en cada revalidación con vida completa: por eso el tope viaja en el ticket cifrado y `SessionCookie` acota la renovación.
3. Max-Age solo en el login; la cookie renovada lleva Expires.
4. Fuera de Development/Testing/Test, sin `KeysPath` absoluto y escribible el arranque FALLA. Dentro, se usa el default de ASP.NET (fuera del repo).
5. Ventana de revocación = `RevalidationInterval` + `ClockSkew` (5 min 30 s por defecto): `logout`/`logout-all` no invalidan copias en otros navegadores al instante salvo intervalo `00:00:00` (coste: una consulta por request, no medido).
6. El key ring va en volumen propio, SIN incluir en `scripts/backup.*` (decisión documentada); claves en XML sin cifrar en reposo (ASP.NET lo advierte).
7. `rememberMe` no booleano ⇒ 400; ausente/null ⇒ false. Cambio de contraseña no existe aún (S07/S08): el documento dice que debe rotar el stamp.

## Variables de entorno nuevas (para .env.example, que NO se tocó por la regla de denegación)
`AUTH_COOKIE_LIFETIME` (08:00:00), `AUTH_COOKIE_REMEMBER_ME_LIFETIME` (30.00:00:00), `AUTH_SESSION_REVALIDATION_INTERVAL` (00:05:00), `AUTH_SESSION_CLOCK_SKEW` (00:00:30); `Auth__DataProtection__KeysPath` (obligatoria fuera de desarrollo, fija en compose, es un secreto: no va al repo ni a la imagen). Acumuladas de S02: `AUTH_MODE`, `AUTH_COOKIE_NAME`, `AUTH_COOKIE_SECURE_POLICY`, `AUTH_PASSWORD_MIN_LENGTH`.

## No verificado
Navegador real (`Secure`/`__Host-`/`SameSite=Lax` sobre `http://localhost`, Max-Age/Expires por navegador, restauración al reabrir); `ASPNETCORE_ENVIRONMENT=Production` en compose; clúster con key ring compartido; carga con `RevalidationInterval=0`; timing del login.
La primera corrida completa del implementador tuvo 4 timeouts de HttpClient y 1 fallo de frontend no identificado, atribuidos a carga; no se reprodujeron: mi corrida completa quedó en verde (1926/1926 y 3308/3308).
