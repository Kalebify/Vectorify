# M3.1-S04 · Sesiones, cookies/tokens y renovación
URL: https://app.notion.com/p/3e8d77b2639881d69b7dfc8952fe9eca
Stack declarado: ASP.NET Core, Frontend, Infra (propiedad Área). Identidad confirmada: ASP.NET Core Identity + cookie (docs/ADR_AUTH_MVP31.md). .NET 10.

## Requerimiento (transcripción del cuerpo de la tarjeta)
Objetivo: Gestionar ciclo de vida de sesión, expiración y renovación de forma segura y transparente.

## Implementación
Seguir ADR S01. Si cookies: HttpOnly, Secure, SameSite adecuado y CSRF. Si tokens: almacenamiento/rotación/revocación seguros; evitar localStorage para secretos persistentes salvo justificación fuerte.
## Políticas
Idle/absolute expiration, refresh/rotation, logout, revocation y clock skew.
## Frontend
Interceptor/auth boundary para 401; un solo refresh concurrente; no loops.
## Backend
Validación issuer/audience/signature cuando aplique.
## Tests
Expired, tampered, refresh success/failure, concurrent requests, logout/revocation.
## DoD
El ciclo de sesión es documentado y testeado.

## Criterios de aceptación
- La sesión expira y se renueva según política; credenciales no se exponen innecesariamente a JavaScript y fallos de renovación llevan a reautenticación controlada. (declarado)
- DERIVADO (ADR D3.7 «Expiración y renovación»): sesión de 8 h con ventana deslizante (idle); «recordarme» = cookie persistente con tope ABSOLUTO de 30 días (campo opcional `rememberMe` en `POST /api/v1/auth/login`; sin él, cookie de sesión del navegador); revalidación del `SecurityStamp` contra la base cada 5 min por defecto (configurable; 0 en tests); clock skew documentado/limitado. Valores configurables vía `Auth__*` y validados al arrancar.
- DERIVADO: «cerrar sesión en todos lados» (rotar el SecurityStamp del usuario autenticado) como endpoint propio, con el mismo CSRF que el resto; el logout de S03 ya rota el stamp.
- DERIVADO: Data Protection con key ring PERSISTENTE (ruta configurable por `Auth__DataProtection__KeysPath`, volumen en `docker-compose.yml`): reiniciar el contenedor NO invalida las sesiones; sin ruta persistente fuera de Development/Testing, el arranque lo advierte o falla (decidir y declarar); sin claves en el repo ni en la imagen; documentar respaldo/rotación.
- DERIVADO (cookies, no hay refresh tokens): «refresh» = renovación deslizante de la cookie por el servidor. Se documenta explícitamente que NO hay tokens en el navegador (nada en localStorage/sessionStorage).
- DERIVADO (frontend): frontera de autenticación en `httpClient`: ante un 401 de un endpoint NO-auth se notifica UNA sola vez «sesión expirada» (varias requests concurrentes con 401 ⇒ un único evento, sin reintento automático, sin loops); `authApi.login/register` no disparan el evento. La navegación a /login conservando la ruta y las pantallas son de S05: aquí solo el evento/hook testeado.
- DERIVADO: documento del ciclo de sesión (`docs/AUTH_SESSION_LIFECYCLE.md`): políticas, valores por defecto, qué pasa en expiración/revocación/tampering, ventana de revalidación, rotación/respaldo del key ring, límites conocidos. Es parte del DoD.
- DERIVADO: los tests existentes (1876 backend, 3280 frontend) siguen verdes; `npm run build` verde; el flujo Development (sin login) sigue igual.

## Referencias visuales / de marca
No aplica (la UI de auth es M3.1-S05).

## Contexto técnico vinculante
`docs/ADR_AUTH_MVP31.md`: D3 (punto 7), T1/T2/T9/T15, «Impacto concreto en S04». Construido en S02/S03: `.sprint/3e8d77b2-6398-81c8-835c-fb711ce83b9d/IMPL.md` y `.sprint/3e8d77b2-6398-8160-9ec9-d6f1eb9e279b/IMPL.md` (`AuthOptions` ya tiene `Cookie.Lifetime` y `Session.RevalidationInterval` como referencia para S04; `AuthRegistration.cs`; logout con rotación de stamp; `httpClient.ts`/`authApi.ts`).

## Umbrales de calidad
Sin Lighthouse (sin UI nueva). `dotnet build` 0 errores; `dotnet test Vectorify.sln` verde (con Docker); `npm test` y `npm run build` verdes; sin secretos; `docker compose` arranca y las sesiones sobreviven a un reinicio del backend (verificado con el compose aislado, si es posible).

## Ambigüedades detectadas
Ninguna que impida empezar. Se aplican los valores propuestos por el ADR (P12: 8 h deslizante, «recordarme» 30 días, revalidación 5 min) como supuestos a confirmar por la persona dueña. «Issuer/audience/signature» de la tarjeta no aplica con cookie (se declara). «Un solo refresh concurrente» se interpreta como un solo evento de sesión expirada ante 401 concurrentes. Redirección a login conservando ruta = S05.
