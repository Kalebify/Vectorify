# M3.1-S09 · Hardening de seguridad Auth
URL: https://app.notion.com/p/3e8d77b2639881988251d72bc266cedc
Stack declarado: ASP.NET Core, Frontend, Infra (propiedad Área). ASP.NET Core Identity + cookie (S02-S08), React 19 + TypeScript + Vite, nginx, docker compose, .NET 10.

## Requerimiento (transcripción del cuerpo de la tarjeta)
Objetivo: Revisar y endurecer autenticación/sesiones antes de considerar el producto listo para usuarios reales.

## Checklist
HTTPS production, CORS mínimo, CSP/headers donde aplique, CSRF si cookies, XSS review, rate limiting en endpoints sensibles, secret management, secure cookies, error hygiene.
## Logging
Nunca loguear passwords, auth headers, refresh tokens ni secretos. Correlation IDs sin PII innecesaria.
## Brute force
Usar controles del proveedor y/o rate limiting/lockout según arquitectura.
## Dependencies
Audit de paquetes y configuración.
## Threat review
Revisar account enumeration, IDOR, session fixation, token replay, open redirects y upload/download authorization.
## DoD
Hallazgos High/Critical corregidos o bloquean release.

## Criterios de aceptación
- Checklist de seguridad ejecutado; rate limiting, headers, CORS/CSRF según arquitectura, secrets y logging seguro están configurados y testeados. (declarado)
- DERIVADO (ADR «Impacto concreto en S09», modelo de amenazas T1–T15): documento `docs/AUTH_SECURITY_REVIEW.md` con el checklist ejecutado, la tabla T1–T15 (estado, evidencia —test/archivo/prueba manual—, riesgo residual), los hallazgos con severidad (Critical/High/Medium/Low), el estado de cada uno (corregido / aceptado con justificación / BLOQUEA RELEASE) y lo NO verificado. Un hallazgo High/Critical no corregido se declara como BLOQUEANTE del release, no se esconde.
- DERIVADO (rate limiting y fuerza bruta): extender el rate limiting nativo de S08 a `login` y `register` (por IP y por dirección hasheada, valores configurables, 429 con `Retry-After`, respuestas uniformes que no revelen cuentas) sin romper el bloqueo de cuenta de S03; documentar límites y el efecto del bloqueo de cuenta como DoS contra una víctima (riesgo residual de T6).
- DERIVADO (proxy, IP real y TLS): `ForwardedHeaders` configurable y SEGURO (`Auth__ForwardedHeaders__*`: proxies/redes de confianza; sin confianza ciega en `X-Forwarded-For`), de modo que el límite por IP funcione detrás de nginx/proxy y `Request.Scheme` sea `https` cuando corresponde; HSTS solo fuera de Development y bajo https; redirección a HTTPS gestionada por el proxy (documentar). Prueba de que un cliente no puede falsificar su IP con cabeceras si no viene de un proxy de confianza.
- DERIVADO (cabeceras de seguridad): en la API (`X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Cache-Control` adecuado en respuestas de auth, `Permissions-Policy` mínima, `X-Frame-Options`/`frame-ancestors`) y en nginx para la SPA: CSP ESTRICTA (sin `unsafe-eval`, `script-src 'self'`; `connect-src`/`img-src`/`style-src` mínimos y justificados, incluido el origen de la API configurable en el build/arranque; `frame-ancestors 'none'`; `base-uri 'self'`; `form-action 'self'`), `X-Content-Type-Options`, `Referrer-Policy` (cuidado: S08 documentó que `no-referrer` GLOBAL por meta rompe el Origin del CsrfGuard; usar `strict-origin-when-cross-origin` o similar y probarlo), `Permissions-Policy`, `Cross-Origin-Opener-Policy`. La app DEBE seguir funcionando con la CSP: verificarlo en un navegador real contra la pila local aislada (0 violaciones CSP en consola recorriendo login, registro, proyectos, editor/workspace con un proyecto, descargas/exports y «Mi cuenta»).
- DERIVADO (XSS, T4): auditar todos los `dangerouslySetInnerHTML`, `innerHTML`, inyección de SVG (p. ej. `checkApi`) y URLs construidas con datos del servidor o del usuario; si hay contenido no confiable, sanitizar o eliminar la vía (sin dependencias nuevas salvo justificación fuerte) y añadir tests con payloads (`<script>`, `onload=`, `javascript:`, `<foreignObject>`, `<use href>`, `xlink:href`). El contenido SVG servido desde la API debe llevar cabeceras seguras (`Content-Type` correcto, `nosniff`, y `Content-Security-Policy: sandbox`/`default-src 'none'` en respuestas de SVG/descargas).
- DERIVADO (secretos y configuración): barrido del repo y del historial reciente en busca de secretos (cadenas de conexión, contraseñas, claves, tokens) y de configuración insegura por defecto; `.gitignore`/`.dockerignore` correctos; la imagen del backend NO debe arrancar por defecto en modo desarrollo: HOY `backend/Dockerfile` fija `ASPNETCORE_ENVIRONMENT=Development` y `Auth__Mode=Development` (anterior a S02): pasar el default de la imagen a `Production`/`Authenticated` y hacer explícito el modo de desarrollo en `docker-compose.yml` (que debe seguir funcionando para desarrollo con un solo comando), con tests/verificación de que Production + Development no arranca; contraseñas por defecto del compose de Postgres y similares: documentar/endurecer (sin romper el arranque de desarrollo) y avisar. `.env.example` NO se toca (hay una regla de denegación): listar los cambios que haga falta aplicar.
- DERIVADO (higiene de errores y logs): en Production ninguna respuesta de error expone stack traces ni mensajes internos (manejador global de excepciones con `ProblemDetails`/cuerpo genérico + correlation ID), Swagger solo en Development, sin `DeveloperExceptionPage`; barrido de logging: nunca contraseñas, cookies, cabeceras `Authorization`/`Cookie`/`Set-Cookie`, tokens, correos en claro ni cuerpos de auth; test que ejecuta los flujos de auth completos con logs a nivel Trace y busca esos valores (ampliar el de S02/S08 a todas las rutas de auth y errores); correlation ID sin PII.
- DERIVADO (dependencias): `dotnet list package --vulnerable --include-transitive` y `npm audit` (backend, tests, PoC y frontend); corregir lo corregible sin cambios de mayor riesgo; el aviso preexistente NU1903/NU1902 de `SixLabors.ImageSharp` 2.1.13 (varias vulnerabilidades altas) debe analizarse: si la corrección exige un cambio de MAYOR versión o un cambio de licencia (revisar la licencia del paquete corregido: puede no ser libre para uso comercial), NO adoptarlo en silencio: documentar alcance real (qué rutas de código usan ImageSharp y con qué entradas), mitigaciones y dejarlo como hallazgo con decisión humana; si hay corrección compatible, aplicarla con tests.
- DERIVADO (threat review con evidencia, no solo texto): enumeración de cuentas (respuestas y tiempos de register/login/forgot/resend), IDOR (referencia a S06 y a su suite), fijación de sesión (un login emite una cookie nueva; una cookie previa no se acepta), repetición de tokens (reset/confirmación de un solo uso), open redirect (`returnUrl`, referencia a S05), autorización de subidas/descargas (referencia a S06), CSRF (S03), cookies (atributos), y la prueba de que Production no puede arrancar con `Auth:Mode=Development`. Donde falte test, añadirlo.
- DERIVADO: los tests existentes (2088 backend, 3675 frontend) siguen verdes; `npm run build` verde; el flujo de desarrollo (compose en modo Development, E2E anónimos) sigue funcionando.

## Referencias visuales / de marca
No aplica (sin pantallas nuevas; solo cabeceras/CSP y, si hace falta, mensajes de 429 ya existentes).

## Contexto técnico vinculante
`docs/ADR_AUTH_MVP31.md` (modelo de amenazas T1–T15 y «Impacto concreto en S09»), `docs/AUTH_SESSION_LIFECYCLE.md`, `docs/AUTH_AUTHORIZATION.md`, `docs/AUTH_RECOVERY.md` y los IMPL de S02-S08 en `.sprint/`. Código: `backend/Vectorify.Api/Program.cs`, `Users/AuthRegistration.cs`, `Users/AuthRecoveryRateLimiting.cs`, `Options/Auth*.cs`, `Middleware/CsrfGuardMiddleware.cs`, `backend/Dockerfile`, `docker-compose.yml`, `frontend/nginx.conf`, `frontend/Dockerfile`, `frontend/index.html`, `frontend/src/api/checkApi.ts` y los usos de `dangerouslySetInnerHTML`.

## Umbrales de calidad
`dotnet build` 0 errores; `dotnet test Vectorify.sln` y `npm test`/`npm run build` verdes; verificación real en navegador con pila local aislada en modo Authenticated (CSP sin violaciones, cookies, flujos de auth); `dotnet list package --vulnerable` y `npm audit` ejecutados y documentados; sin secretos en repo.

## Ambigüedades detectadas
Ninguna que impida empezar. Decisiones humanas abiertas que NO se resuelven aquí: licencia/actualización mayor de ImageSharp, dominio y certificado TLS de producción, proveedor de correo (P5), destino de datos legados (P10), supresión de cuenta (P11). El hardening de TLS real y HSTS preload no se puede verificar sin dominio/certificado (se documenta).
