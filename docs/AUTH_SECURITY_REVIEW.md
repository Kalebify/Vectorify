# Revisión de seguridad de autenticación y sesiones (M3.1-S09)

Cierra el hardening de MVP 3.1. Complementa `docs/ADR_AUTH_MVP31.md` (modelo de amenazas T1–T15, «Impacto concreto en S09»), `docs/AUTH_SESSION_LIFECYCLE.md`, `docs/AUTH_AUTHORIZATION.md` y `docs/AUTH_RECOVERY.md`.
Regla de este documento: **solo está marcado como verificado lo que se ejecutó** (test, comando o prueba en navegador, con su nombre); lo demás figura en §8 «Lo que NO se verificó».

## 0. Veredicto para el release

| | |
|---|---|
| **BLOQUEA RELEASE (decisión humana)** | **H-1 · SixLabors.ImageSharp 2.1.13** — cinco avisos (3 High, 2 Moderate) cuya corrección solo existe en la **versión mayor 4.1.2** y bajo **otra licencia** (Six Labors Split License: Apache-2.0 solo si el uso es de código abierto, dependencia transitiva, empresa con < 1 M USD de ingresos brutos anuales u organización sin ánimo de lucro; en cualquier otro caso, licencia comercial de pago). No se adoptó en silencio. Se aplicaron mitigaciones (§5.7) y queda a la espera de **decidir** (§9). Hasta entonces el release queda bloqueado según la DoD de la tarjeta («hallazgos High/Critical corregidos o bloquean release»). |
| Corregidos en esta tarjeta | 10 hallazgos (H-2 … H-11, Medium/Low), §4. |
| Aceptados con justificación | 7 riesgos residuales (Low), §4. |
| No hay otro High/Critical abierto | Con las reservas de §8 (TLS/dominio reales, navegador distinto de Chrome, proxy real delante de la API). |

## 1. Cómo se verificó (entorno)

- **Backend:** .NET 10.0.402; xUnit con la Web API real (`WebApplicationFactory<Program>`) sobre PostgreSQL real. Los tests nuevos corren en la colección `AuthRecovery` (un solo PostgreSQL compartido).
- **Navegador real:** Chrome 155 (headless) por el protocolo DevTools, con `tests/e2e/csp_browser_check.mjs` (sin dependencias nuevas; `tests/e2e/lib/cdp.mjs`).
- **Pila de la verificación final en navegador:** `docker compose -p vectorify-s09` (puertos 30xxx, aislada de la pila del usuario): imágenes construidas desde el repositorio — **contenedor nginx real** (la plantilla `frontend/nginx.conf` procesada por el `envsubst` de la imagen oficial; `nginx -t` correcto), Web API (`Auth__Mode=Authenticated`, entorno Development), **motor Python real** y PostgreSQL 17. Una pasada exploratoria previa, cuando Docker dejó de estar disponible un rato, usó nginx 1.28.0 de Windows con la misma plantilla, la API en proceso y el motor Python simulado de los tests; los resultados fueron los mismos.
- Suites: `dotnet test Vectorify.sln` con Testcontainers (PostgreSQL real), `npm test`, `npm run build`, y los E2E anónimos de `tests/e2e` contra el compose en modo Development: resultados en el informe de la tarjeta y en §7.

## 2. Checklist de la tarjeta (ejecutado)

| Ítem | Estado | Evidencia |
|---|---|---|
| HTTPS en producción | **Parcial por diseño**: la API habla http detrás de un proxy que termina TLS; `ForwardedHeaders` seguro + HSTS + cookie `Secure`/`__Host-` | `ForwardedHeadersAndHstsTests` (HSTS solo fuera de Development y solo bajo https visto tras el proxy de confianza), `AuthThreatReviewTests.ProductionCookie_*`. **TLS/certificado/HSTS preload reales: no verificables sin dominio** (§8). |
| CORS mínimo | Verificado | `CorsCredentialsTests` (S02: orígenes explícitos, sin comodín, cabeceras y métodos enumerados), `UserContextRegistrationTests.Host_WithNonExplicitCorsOrigins_FailsToStart`, preflight con las cabeceras de seguridad (`SecurityHeadersTests.APreflightFromAnAllowedOrigin_*`). |
| CSP / cabeceras | Verificado en navegador real | §6; `SecurityHeadersTests`, `DeploymentDefaultsTests.Nginx_*`. |
| CSRF (cookies) | Verificado | `AuthLoginLogoutTests.Csrf_*` (8 tests, S03) + `AuthLoginRegisterRateLimitTests.ARejectedCsrfRequest_DoesNotSpendTheLoginQuota`. |
| XSS | Verificado | §5.5; `src/security/noUnsafeHtml.test.ts`, `src/security/svgPayloads.test.ts`, navegador. |
| Rate limiting de endpoints sensibles | Verificado | §5.1; `AuthLoginRegisterRateLimitTests` (11 tests), `AuthRecoveryRateLimitTests` (S08). |
| Gestión de secretos | Verificado | §5.8. |
| Cookies seguras | Verificado | `AuthLoginLogoutTests`, `AuthSessionLifecycleTests`, `AuthThreatReviewTests.ProductionCookie_*`. |
| Higiene de errores | Verificado | `ErrorHygieneTests`, `SecurityHeadersTests.Swagger_ExistsOnlyInDevelopment`. |
| Logging sin secretos / PII | Verificado | `AuthLogHygieneTests` (Trace, todas las rutas), §5.6. |
| Fuerza bruta | Verificado | bloqueo de cuenta (S03) + límites de §5.1; residual en §4 (R-1). |
| Dependencias | Ejecutado | §5.7 (`dotnet list … --vulnerable`, `npm audit`). |
| Threat review | Ejecutado | §3 y §4. |

## 3. Tabla T1–T15 del ADR

Estado: **Mitigado** (control probado), **Parcial** (control probado + parte no verificable aquí), **N/A** (no aplica a la opción A elegida). Todos los tests citados corren en la suite (`dotnet test`).

| # | Amenaza | Estado | Evidencia concreta | Riesgo residual |
|---|---|---|---|---|
| T1 | Robo de sesión | **Parcial** | Cookie `HttpOnly`, `SameSite=Lax`, `Path=/`, sin `Domain`: `AuthLoginLogoutTests.Login_Cookie_IsHttpOnlySameSiteLax_*`; en Production `__Host-` + `Secure`: `AuthThreatReviewTests.ProductionCookie_HasTheHostPrefix_Secure_HttpOnly_SameSiteLax_PathRoot_AndNoDomain` y `AuthSessionLifecycleTests.Login_WithRememberMe_UsingProductionStyleOptions_*`. La SPA no guarda tokens (`src/api/sessionBoundary.ts`, `authFragment.ts`: solo memoria; ningún `localStorage` con credenciales). CSP estricta probada en navegador (§6). HSTS: `ForwardedHeadersAndHstsTests`. | Una copia robada de la cookie vale hasta cerrar sesión en todos lados o la revalidación (5 min). TLS real no verificado. |
| T2 | Fijación de sesión | **Mitigado** | `AuthThreatReviewTests.SessionFixation_ALoginAlwaysIssuesAFreshCookie_AndNeverAdoptsOneChosenByTheClient` (un valor de cookie elegido por el atacante no es sesión y el login emite otra), `…_ALoginWhileHoldingASession_IssuesADifferentCookie_EachTime`, `TheSession_IsOnlyReadFromTheCookie_NeverFromTheUrlOrFromAnotherHeader` (query, `Authorization: Bearer`, cabecera propia ⇒ 401); `AuthSessionLifecycleTests.TamperedCookie_Returns401_WhateverPartIsAltered`. Resuelve el **[N]** del ADR («no cubierto por test»). | — |
| T3 | CSRF | **Mitigado** | `AuthLoginLogoutTests.Csrf_*` (sin cabecera, `Origin` ajeno, sin `Origin`, cabecera vacía, PATCH/DELETE, logout forzado cross-site), `AuthSessionLifecycleTests.LogoutAll_AppliesTheSameCsrfGuardAsTheRestOfUnsafeMethods`; el rechazo CSRF **no gasta cupo** del limitador. En navegador: login/registro/exports funcionan con `Referrer-Policy: strict-origin-when-cross-origin` (el `Origin` no sale `null`). | — |
| T4 | XSS | **Mitigado** | §5.5: ninguna vía de inyección en la SPA (test de código), payloads de SVG en tres caminos (`svgPayloads.test.ts`), SVG de la API entregado con `attachment` + CSP `sandbox` + `nosniff` (`SecurityHeadersTests.AnUploadedSvgWithScripts_*`), CSP sin violaciones en navegador, hallazgo H-5 corregido. | Trusted Types no evaluado. |
| T5 | Enumeración de cuentas | **Mitigado** (tiempos: residual bajo) | Respuestas: `AuthThreatReviewTests.Enumeration_ResponsesAreIndistinguishable_ForAnExistingAndAnUnknownAddress_OnEveryAnonymousRoute` (register, login, forgot, resend, reset, confirm: estado + nombres de cabecera + cuerpo idénticos) y `…_ALockedAccount_ReturnsTheSame401…`; 429 por dirección idéntico para cuenta existente/inexistente (`AuthLoginRegisterRateLimitTests.*_TheExcessIs429_For…`). **Tiempos medidos** (§5.3, API real, N = 25): login inexistente / errónea / bloqueada ≈ 1.0× (1.08 y 1.01); register nuevo vs existente 0.99; forgot/resend ≈ 1 ms en ambos casos. Test automático con umbral holgado: `Enumeration_LoginTimings_*`. H-6 corregido (la rama «bloqueada» respondía **20× más rápido**). | Medición local, un solo cliente: contra un atacante en red con muchas muestras no está demostrado. Registro: la cuenta nueva hace más trabajo en BD que la existente (R-4). |
| T6 | Fuerza bruta / stuffing | **Mitigado** (DoS residual) | Bloqueo de cuenta 5/15 min (S03: `AuthLoginLogoutTests`), límites nuevos de login/registro (§5.1) con `AuthLoginRegisterRateLimitTests`: por IP, por dirección, 429 + `Retry-After`, el bloqueo sigue funcionando (`Login_TheAccountLockoutOfS03StillApplies…`) y un intento limitado **no suma** al bloqueo (`Login_RateLimitedAttempts_DoNotCountTowardsTheAccountLockout`). | **R-1**: un tercero puede impedir el login de una víctima (bloqueo de cuenta + cupo por dirección). Ver §5.1. |
| T7 | Tokens en el cliente | **N/A** | Opción A: no hay tokens en el navegador (§T1). | — |
| T8 | CORS con credenciales | **Mitigado** | `CorsCredentialsTests` (S02), `Host_WithNonExplicitCorsOrigins_FailsToStart`; `Retry-After` expuesto para el 429. | — |
| T9 | Secretos | **Mitigado** (con reservas) | Barrido del árbol y del historial (§5.8): ningún secreto; `AppSettings_CarryNoSecretValues`; contraseña de ejemplo del compose **rechazada fuera de desarrollo** (`AuthHardeningOptionsTests.AProductionHost_WithTheComposeDevelopmentPassword_FailsToStart`); key ring obligatorio fuera de desarrollo (`AuthOptionsValidatorTests`, S04); `.gitignore`/`.dockerignore` con claves y certificados (`DeploymentDefaultsTests.GitAndDockerIgnores_*`). | La rotación/respaldo del key ring es operativa (no automatizada). `index.lock` vacío versionado (R-7). |
| T10 | Downgrade a HTTP / MITM | **Parcial** | `ForwardedHeaders` configurable y seguro, sin confianza ciega (§5.2): un cliente no puede falsificar su IP ni el esquema (`ForwardedHeadersAndHstsTests`, 14 tests); HSTS solo fuera de Development y bajo https; la redirección http→https la hace el proxy (§5.2). | Certificado/dominio/HSTS preload no verificables aquí (§8). |
| T11 | IDOR entre usuarios | **Mitigado** | S06: `MultiUserIsolationTests` (matriz de rutas clásicas y v2, 404 uniforme, subidas/descargas por URL directa con cookie), `UserOwnershipEndpointsTests`, `EndpointAuthorizationArchitectureTests` (todo endpoint con autorización por defecto y comprobación de dueño o en lista blanca justificada, con controles de mutación). | — |
| T12 | Forjado de token (opción B) | **N/A** | No hay JWT en el producto. | — |
| T13 | Suplantación por claim interno | **Mitigado** | `AuthenticatedModePipelineTests.AClaimNamedLikeTheInternalOne_InsideTheProviderIdentity_CannotImpersonateAnotherUser`. | — |
| T14 | Vinculación por email | **Mitigado** | La identidad es `(Provider, Subject)`, no el email (`UserProvisionerTests`); no hay login social. | — |
| T15 | Sesión zombi / repetición de tokens | **Mitigado** | `AuthSessionLifecycleTests.RevokedCookie_*`, `LogoutAll_*`; cambio/reset rotan el `SecurityStamp` (`AuthRecoveryEndpointsTests`, reset de un solo uso); nuevos: `AuthThreatReviewTests.Tokens_AResetTokenIsNotAConfirmationToken_AndViceVersa` (separación de propósito) y `…_AResetTokenOfOneAccountDoesNotWorkForAnother`. | Ventana de revalidación (5 min por defecto). |

Otras amenazas de la tarjeta:

| Tema | Estado | Evidencia |
|---|---|---|
| Open redirect | **Mitigado** | El backend **no tiene ninguna redirección** (`DeploymentDefaultsTests.TheApi_HasNoRedirectResults…`); los enlaces de los correos salen de `Auth:Email:PublicBaseUrl` y no de `Host`/`Origin`/`X-Forwarded-Host` (`AuthThreatReviewTests.EmailLinks_AlwaysPointToTheConfiguredPublicBaseUrl…`, con `Host: evil.example`); el `returnUrl` de la SPA solo admite rutas internas (`src/auth/returnUrl.test.ts`, S05). |
| Autorización de subidas/descargas | **Mitigado** | S06 (`MultiUserIsolationTests.Classic_Downloads_ByDirectUrl_RespectTheSessionCookie`, `…_Upload_StampsTheServerUserAsOwner…`); entrega segura de SVG/descargas: §5.4. |

## 4. Hallazgos

Severidad según el impacto más probable en este producto (no CVSS formal). «Corregido» = hay código y test; «Aceptado» = riesgo residual conocido, con motivo.

| ID | Sev. | Estado | Hallazgo | Evidencia / corrección |
|---|---|---|---|---|
| **H-1** | **High** | **BLOQUEA RELEASE (decisión humana)** | `SixLabors.ImageSharp` 2.1.13: GHSA-j3p4-wp97-rph4 (High, ecualización de histograma), GHSA-j9gm-c75j-xc9q (High, codificador TIFF CCITT T4), GHSA-jjfr-hcj7-qf5w (High, codificador TIFF CCITT T6), GHSA-gwg2-r3hj-4w44 (Moderate, CLUT de perfiles ICC), GHSA-wmxv-xphr-5c9g (Moderate, bucle en BigTIFF). Todos corregidos **solo en 4.1.2** (salto 2.x→4.x) con **cambio de licencia**. | §5.7. Mitigado en parte (decodificadores restringidos + tope de píxeles, ver H-9); el código vulnerable sigue en el ensamblado. |
| H-2 | Medium | Corregido | `backend/Dockerfile` fijaba `ASPNETCORE_ENVIRONMENT=Development` y `Auth__Mode=Development`: cualquier despliegue sin overrides arrancaba sin login y con la página de excepciones. | Default de la imagen: `Production` + `Authenticated`; el compose pide el modo de desarrollo de forma explícita. `DeploymentDefaultsTests.BackendImage_*`, `Compose_StatesTheDevelopmentModeExplicitly…`; Production+`Auth:Mode=Development` sigue sin arrancar (`UserContextRegistrationTests.Host_InProductionWithDevelopmentMode_*`, ambas variantes). |
| H-3 | Medium | Corregido | `login` y `register` sin límite de frecuencia (solo el bloqueo de cuenta): credential stuffing entre cuentas y registro masivo sin freno. | §5.1. `AuthLoginRegisterRateLimitTests`. |
| H-4 | Medium | Corregido | Sin `ForwardedHeaders`: detrás de un proxy todas las peticiones compartirían IP (el límite por IP actuaría como global) y `Request.Scheme` sería `http`. La variable que sugería el ADR (`ASPNETCORE_FORWARDEDHEADERS_ENABLED=true`) confía en **cualquier** origen (un cliente falsificaría su IP). | §5.2. La API **se niega a arrancar** con esa variable. `ForwardedHeadersAndHstsTests`, `AuthHardeningOptionsTests`. |
| H-5 | Medium | Corregido | **Client-side path traversal**: `projectId`/`imageId`/`paletteId`/`savedProjectId` de la URL se interpolaban en rutas de la API. Un enlace fabricado (`?projectId=../auth/logout-all?x=…`) hacía que el navegador de la víctima, con su cookie y la cabecera anti-CSRF, pidiera **otra ruta de la API**. | `readWorkspaceLocation` solo acepta ids opacos (`[A-Za-z0-9_-]{1,64}`). `src/lib/workspaceLocation.security.test.ts` (14 tests: 12 valores hostiles × los 4 parámetros, más el deep-link). |
| H-6 | Medium | Corregido | Enumeración por **tiempo**: una cuenta **bloqueada** no verificaba la contraseña y respondía mucho más rápido que una inexistente (que sí hashea); bloqueando un correo a propósito (5 fallos) se distinguía «existe» de «no existe». | Misma carga (hash ficticio) en la rama bloqueada. `AuthThreatReviewTests.Enumeration_LoginTimings_*`; medición en §5.3. |
| H-7 | Medium | Corregido | El editor (`useEditableDocument`) y el Laser Checker (`fetchSvgText`) leen el SVG con `fetch(url)` **sin `credentials: "include"`**: con la API en otro origen (desarrollo y el modelo del ADR) el navegador no envía la cookie y la API responde **401** — las capas del editor no cargarían en modo `Authenticated`. | `credentials: "include"` en ambos. Comprobado en navegador (paso 6): sin credenciales **401**, con credenciales **200**, y el editor carga las capas. |
| H-8 | Low | Corregido | `X-Correlation-Id` entrante se reutilizaba tal cual: valor arbitrario (hasta el tamaño de cabecera) en **cada línea de log** (inyección de líneas, correos o tokens pegados por error). | Solo se acepta un identificador opaco (`[A-Za-z0-9._-]{1,64}`); si no, se genera uno. `ErrorHygieneTests`. |
| H-9 | Medium | Corregido | Sin límite de dimensiones de las imágenes subidas: un PNG/JPEG pequeño puede declarar decenas de miles de píxeles por lado y agotar la memoria al decodificarse (bomba de descompresión; el tope de 15 MB de archivo no lo evita), por cualquier usuario autenticado. | Tope de píxeles leído de la **cabecera** antes de decodificar (`Upload:MaxPixels`/`Asset:MaxPixels`, 64 Mpx), rechazo `file_too_large`. `SafeImageDecodingTests`. |
| H-10 | Low | Corregido | Sin manejador global de excepciones fuera de Development (respuesta vacía, sin correlation ID visible) y sin cabeceras de seguridad en la API. | `UseExceptionHandler` con cuerpo genérico `internal_error` + `X-Correlation-Id`; `SecurityHeadersMiddleware`. `ErrorHygieneTests`, `SecurityHeadersTests`. |
| H-11 | Low | Corregido | `docker-compose.yml` publicaba Postgres (contraseña de ejemplo), la API **en modo Development sin login** y el motor Python en todas las interfaces del anfitrión; `.gitignore` sin claves/certificados. | Puertos en `127.0.0.1` por defecto (`BIND_ADDRESS`), contraseña de ejemplo rechazada fuera de desarrollo, patrones añadidos. `DeploymentDefaultsTests`. |
| R-1 | Low | Aceptado | **Bloqueo como DoS contra una víctima** (T6): 5 fallos bloquean la cuenta 15 min y 10 intentos (cualquiera, incluso con correo ajeno) agotan el cupo de login de esa dirección en la ventana. | Decisión de producto. Mitigaciones existentes: límite por IP (20/15 min) frena al atacante con una sola IP, el restablecimiento de contraseña **limpia el bloqueo** (S08). Alternativas si molesta: clave compuesta (IP, dirección) o desafío CAPTCHA, a costa de debilitar la defensa distribuida. |
| R-2 | Low | Aceptado | Límites **en memoria y por instancia** (ventana fija): con varias instancias el cupo real es N× y se pierde al reiniciar. | Hoy hay una instancia. Si se escala, mover el contador a un almacén común (Redis/Postgres) o poner el límite en el proxy. |
| R-3 | Low | Aceptado | El contenedor del backend corre como **root** y nginx también (master). | Cambiar a `USER app` rompe los volúmenes existentes (propiedad root) y la imagen `nginx-unprivileged` cambia el puerto: recomendado para el despliegue real, no aplicado para no romper el flujo de desarrollo. |
| R-4 | Low | Aceptado | Registro: la rama «cuenta nueva» hace más trabajo en la base (inserciones, creación del `User` interno, encolado del correo) que «ya existe»; en la medición local no se distinguió (0.99×). | Ver T5; sin evidencia de que sea explotable. |
| R-5 | Low | Aceptado | `Data/AuthDbContextFactory.cs` y `Data/VectorizationDbContextFactory.cs` llevan la contraseña de ejemplo como valor por defecto **solo de tiempo de diseño** (`dotnet ef`); `README.md` la nombra. | No se usa en runtime y es la misma del compose de desarrollo, rechazada fuera de desarrollo. |
| R-6 | Low | Aceptado | `useVectorDocument` resuelve `svgUrl` con `new URL(layer.svgUrl, API_BASE_URL)`: una URL absoluta de otro origen enviada por el servidor se pediría tal cual. | El servidor es de confianza; la CSP `connect-src` la bloquea en navegador. Defensa en profundidad pendiente (validar el origen). |
| R-7 | Info | Aceptado | `index.lock` (0 bytes) versionado en la raíz desde el primer commit. | Ruido sin riesgo; no se borró por no ser un archivo de esta tarjeta. |

## 5. Qué se implementó y cómo operarlo

### 5.1 Rate limiting de login y registro (T6)

Mismo mecanismo nativo que S08 (`Microsoft.AspNetCore.RateLimiting` + `System.Threading.RateLimiting`, ventana fija), generalizado en `Users/AuthRecoveryRateLimiting.cs`. Todos configurables (`Auth__RateLimit__*`, validados al arrancar).

| Ruta | Por IP (política de la ruta) | Por dirección (HMAC del correo con clave de proceso) | Al excederse |
|---|---|---|---|
| `POST /api/v1/auth/login` | 20 / 15 min (`LoginIpPermitLimit`, `LoginIpWindow`) | 10 / 15 min (`LoginAddress…`) | **429** + `Retry-After` + `no-store`, `rate_limited` |
| `POST /api/v1/auth/register` | 10 / 1 h (`RegisterIp…`) | 5 / 1 h (`RegisterAddress…`) | **429** + `Retry-After` |
| `forgot-password`, `resend-confirmation` | 20 / 15 min por ruta (`IpPermitLimit`) | 5 / 1 h compartido (`AddressSend…`) | IP: 429; dirección: el **202 uniforme sin enviar** (S08) |
| `reset-password`, `confirm-email` | 20 / 15 min por ruta | 10 / 1 h compartido (`AddressVerify…`) | IP: 429; dirección: el mismo 400 genérico (S08) |

Decisiones y por qué no revelan cuentas:
- El contador por dirección de login/registro se consulta **antes** de tocar la base y cuenta **todo** intento, exista o no la cuenta y acierte o no la contraseña: el 429 no depende de la cuenta (probado: mismo cuerpo y estado para existente e inexistente). Un intento limitado **no comprueba la contraseña y no suma al bloqueo** de cuenta.
- El rechazo CSRF (403) ocurre antes y no gasta cupo.
- **Efecto del bloqueo de cuenta como DoS (R-1):** quien conozca un correo puede dejar a esa persona sin poder entrar hasta 15 min (bloqueo) y, con 10 intentos, mientras dure la ventana del cupo por dirección. El límite por IP lo hace costoso (20 intentos/15 min por IP) pero no imposible con varias IP. Mitigación operativa: el restablecimiento de contraseña limpia el bloqueo.
- Si la API va detrás de un proxy **hay que configurar `Auth__ForwardedHeaders__*`** (§5.2); si no, todas las peticiones comparten la IP del proxy y el límite por IP actúa como global.

### 5.2 Proxy de confianza, IP real, esquema y HSTS (T10)

- `Auth__ForwardedHeaders__Enabled` (**`false` por defecto**: `X-Forwarded-*` de un cliente se **ignora**), `KnownProxies` (IP, coma), `KnownNetworks` (CIDR, p. ej. la red de docker `172.16.0.0/12`), `ForwardLimit` (1). Solo se atienden `X-Forwarded-For` y `X-Forwarded-Proto` (no `Host`), y solo si la **conexión TCP** viene de un proxy/red listado (se vacían los loopback por defecto del framework). Activarlo sin ninguna lista, con `0.0.0.0/0`, `::/0`, redes más anchas que /8 (IPv4) o /16 (IPv6), una IP `0.0.0.0`/`::` o `ForwardLimit` fuera de 1–10 **impide el arranque**. Código: `Security/ForwardedHeadersSetup.cs`.
- `ASPNETCORE_FORWARDEDHEADERS_ENABLED=true` (el interruptor del framework, que el ADR sugería) **impide el arranque**: confía en cualquier origen.
- **HSTS** (`Auth__Hsts__MaxAge` 180 días, `IncludeSubDomains` `false`, **sin preload**): solo fuera de Development y solo si la API ve `https` (es decir, tras `ForwardedHeaders` desde un proxy de confianza); el middleware ignora http y los hosts locales. El preload es casi irreversible y exige dominio y certificado: decisión humana.
- **Redirección http→https y TLS:** los gestiona el proxy que termina TLS (esta API escucha http en la red privada y no se activó `UseHttpsRedirection`). Ese proxy debe: redirigir http→https, emitir su propio HSTS para la SPA, enviar `X-Forwarded-Proto`/`X-Forwarded-For` y **no** reenviar las cabeceras que traiga el cliente sin sobrescribirlas (nginx: `proxy_set_header X-Forwarded-For $remote_addr;` y `X-Forwarded-Proto $scheme`). Cookie `Secure` + prefijo `__Host-` ya impiden que la sesión viaje por http.

### 5.3 Enumeración: respuestas y tiempos (T5)

Respuestas idénticas (estado, nombres de cabecera, cuerpo) para cuenta existente/inexistente en las seis rutas anónimas — `AuthThreatReviewTests.Enumeration_*`. Tiempos medidos con `tests/e2e/auth_timing_probe.mjs` (N = 25 por fila, API real en local, PostgreSQL local; mediana en ms; **máquina de desarrollo, no concluyente contra un atacante en red**):

| Par | Mediana A | Mediana B | A / B |
|---|---|---|---|
| login: cuenta inexistente / contraseña errónea (1 intento por cuenta, sin llegar al bloqueo) | 91.6 | 85.2 | 1.08 |
| login: cuenta **bloqueada** / contraseña errónea | 86.5 | 85.2 | 1.01 |
| register: correo nuevo / ya registrado | 79.0 | 80.1 | 0.99 |
| forgot-password: existente / inexistente | 1.2 | 1.4 | 0.85 |
| resend-confirmation: existente / inexistente | 1.6 | 1.3 | 1.30 |

(forgot/resend responden en ~1 ms porque el camino síncrono no toca la base ni el SMTP: las diferencias son ruido del orden de décimas de milisegundo.) **Antes de H-6** la rama «bloqueada» no hasheaba: con la corrección quitada (mutación de control, test de host con pool de conexiones) las medianas fueron inexistente 62 ms, contraseña errónea 66 ms y **bloqueada 3 ms**, y `Enumeration_LoginTimings_*` falla (§7). Ojo con la metodología: una sola cuenta con varios fallos acaba bloqueada y mediría la rama equivocada (la sonda usa una cuenta por muestra); y las cadenas de conexión de `AuthApiFixture` no usan pool (cada consulta abre una conexión: ~30 ms en Windows), lo que falsea cualquier medición — el test de tiempos usa pool.

### 5.4 Cabeceras de seguridad

**API** (`Security/SecurityHeadersMiddleware.cs`, el primer middleware: también en 401/403/429/500): `X-Content-Type-Options: nosniff`; `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox` (un SVG o una descarga abiertos en una pestaña no ejecutan scripts ni comparten origen con la API — el `sandbox` sin `allow-same-origin` le da un origen opaco que no puede usar la cookie; `style-src 'unsafe-inline'` solo para que un SVG conserve sus `style=""` y sin `img-src`/`font-src` ningún estilo carga nada externo; un `<img src>` de la SPA no se ve afectado); `X-Frame-Options: DENY`; `Referrer-Policy: no-referrer` (la API nunca es un documento con enlaces salientes; **no** confundir con la SPA); `Permissions-Policy` mínima; `Cache-Control: no-store` en `/api/v1/auth/*` y `private, no-cache` en el resto de `/api/*` si el endpoint no fijó otro. Swagger UI (solo Development) queda exento de CSP/X-Frame.
Descargas: el SVG subido como Asset se entrega con `Content-Disposition: attachment` y los bytes intactos (la defensa es de entrega, no de reescritura): `SecurityHeadersTests.AnUploadedSvgWithScripts_IsServedAsAnAttachment…` (con `<script>`, `onload`, `<foreignObject>`, `<use href>`).

**SPA** (`frontend/nginx.conf`, plantilla con `API_ORIGIN`): ver §6.

### 5.5 XSS (T4): auditoría

- **Ninguna** vía de inyección en el código de producción: sin `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`/`new Function`, `srcdoc`, `window.open`, `location.*=`, `<iframe>/<embed>/<object>` ni URLs `javascript:` (`src/security/noUnsafeHtml.test.ts` lo vigila para todo `src/` excepto tests). Los comentarios que mencionan `dangerouslySetInnerHTML` explican por qué **no** se usa.
- SVG: solo se toca de tres formas — **data URL en un `<img>`** (`svgToDataUrl`; el navegador nunca ejecuta script dentro de un `<img>`), **`DOMParser` en un documento desacoplado** para resaltar un path (`highlightSvgPath`, `parseEditableLayer`) y **objetos `{d, fill, matrix}`** que Konva dibuja en canvas; al volver a serializar solo salen `<svg>` y `<path>` con atributos escapados. `src/security/svgPayloads.test.ts`: `<script>`, `onload=`, `onclick=`, `<foreignObject>` con `onerror`, `<use href>`, `xlink:href` (https y `data:`), `javascript:`, ruptura de atributo (`fill="red&quot; onload=…"`), `<style>` con `url()` externa — por los tres caminos (y `window.__pwned` jamás se define).
- URLs construidas con datos: ids de la URL validados (H-5); los de la API son GUID del servidor; `exportApi` usa `URLSearchParams`. `projectsV2Api` acepta una miniatura absoluta `https?://` enviada por el servidor (confianza en el servidor + CSP `img-src`; R-6 análogo).

### 5.6 Errores y logs

- Fuera de Development: `UseExceptionHandler` → 500 `{"code":"internal_error","message":"…"}` + `X-Correlation-Id`, sin stack ni mensaje interno (`ErrorHygieneTests.InProduction_AnUnhandledException_*` comprueba que ni la contraseña, el host, el tipo de excepción ni «line N» llegan al cuerpo, y que el detalle SÍ queda en el log). En Development se conserva la página de excepciones del framework. Swagger solo en Development (`Swagger_ExistsOnlyInDevelopment`).
- `AuthLogHygieneTests.TraceLevelLogs_OfEveryAuthFlow_NeverContainPasswordsCookiesAuthHeadersTokensOrEmails`: log a nivel **Trace** recorriendo register (nuevo y existente), login (mala/buena/«recordarme»), me, perfil GET/PATCH, confirm-email (válido y reusado), forgot/resend (conocido y desconocido), reset (token inválido, contraseña débil, válido), change-password (mala y buena), logout, logout-all, rechazo CSRF con `Authorization`/`Cookie`, JSON roto con una contraseña dentro y 429. Busca contraseñas, valores de cookie de sesión, `Authorization`/`Cookie`/`Set-Cookie`, tokens (también codificados), el secreto SMTP, el nombre visible y **cualquier** `@vectorify.test`.
- Correlation ID: opaco o regenerado (H-8); no lleva PII.
- Excepciones deliberadas ya documentadas en S08: `Auth:Email:Mode=Log` escribe el correo y el enlace en el log (solo Development; en Production el arranque falla).

### 5.7 Dependencias

`dotnet list <proyecto> package --vulnerable --include-transitive` (2026-10-19; las salidas literales están en el informe de la tarjeta):

| Proyecto | Resultado |
|---|---|
| `Vectorify.Api` | solo `SixLabors.ImageSharp` 2.1.13 (5 avisos) |
| `Vectorify.Api.Tests` | solo `SixLabors.ImageSharp` 2.1.13 (transitivo, mismos 5) |
| `spikes/AuthPoc` | solo `SixLabors.ImageSharp` 2.1.13 (transitivo, mismos 5) |
| `npm audit` (frontend) | 1 high (`source-map-js` ≤ 1.2.1, dependencia **de desarrollo** vía vite/jsdom) → **corregido** con `npm audit fix` (solo `package-lock.json`: 1.2.1→1.2.2). Resultado final: `found 0 vulnerabilities`; `npm audit --omit=dev` también 0. |

**H-1 · alcance real de ImageSharp.** Código que lo usa: `Validation/ImageUploadValidator` y `Assets/AssetUploadValidator` (decodifican la imagen **subida por un usuario autenticado** para validarla), `Imaging/ThumbnailGenerator` (miniatura del original al guardar) y `Imaging/MaskCompositor` (máscaras PNG que genera el motor Python). Entradas: archivos de hasta 15 MB cuya firma coincide con `image/png`, `image/jpeg` o `image/webp`. No hay TIFF, GIF, BMP, ecualización de histograma ni lectura de perfiles ICC en el código de la aplicación.
Los avisos, uno a uno: tres están en el **codificador/decodificador TIFF** (la aplicación no codifica TIFF y, con las mitigaciones, ningún contenido subido llega al decodificador TIFF), uno en `HistogramEqualization` (no se usa) y uno en el análisis de **perfiles ICC** (ImageSharp 2.x guarda el perfil como bytes y lo interpreta de forma perezosa; los codificadores PNG/JPEG lo reescriben sin interpretarlo — **no verificado empíricamente** con un perfil malicioso).
Mitigaciones aplicadas (`Imaging/SafeImageDecoding.cs`, `SafeImageDecodingTests`): (1) `Configuration` propia con **solo PNG/JPEG/WEBP** en todas las lecturas de imágenes subidas — probado: un TIFF/GIF/BMP real que la configuración global sí decodifica lanza `UnknownImageFormatException` con la restringida, y un TIFF declarado como PNG se rechaza como corrupto; (2) tope de **píxeles** leído de la cabecera antes de decodificar (H-9). **Riesgo residual:** la dependencia vulnerable sigue en el ensamblado y los decodificadores PNG/JPEG/WEBP no se auditaron; DoS por memoria/CPU de un usuario autenticado es el peor caso razonable (no hay ejecución de código demostrada para estos avisos en las rutas alcanzables).
**Opciones para decidir (§9):** (a) **aceptar el riesgo** documentado con estas mitigaciones y revisar en la próxima ventana de mantenimiento; (b) **actualizar a ImageSharp 4.1.x** y cumplir la licencia (código abierto, empresa < 1 M USD o licencia comercial) — exige cambios de API (2.x→4.x: `Configuration`/`DecoderOptions`, `Image.Load`) y repetir la suite; (c) **sustituir** ImageSharp (el motor Python ya decodifica con OpenCV/`imagesize` y podría validar y generar las miniaturas, aislado en su contenedor); (d) **aislar** la decodificación en un proceso/contenedor con límite de memoria. Hasta que se decida, esta tarjeta bloquea el release.

### 5.8 Secretos y configuración

- **Barrido del árbol de trabajo** (`git grep` con patrones de claves privadas, AWS/GitHub/Slack/Google/JWT/Notion, literales `password|secret|api_key|token = "…"`, cadenas de conexión y URL `postgres://usuario:clave@`): sin hallazgos salvo la contraseña de ejemplo **documentada** (`vectorify_dev_password`: `docker-compose.yml`, `README.md`, los dos `*DbContextFactory` de tiempo de diseño — R-5) y `GOOD_PASSWORD` de un archivo de soporte de tests.
- **Historial completo (254 commits):** ningún nombre de archivo sensible (`.env*` salvo `.env.example`, `*.pem`, `*.key`, `*.pfx`, `id_rsa`, `.pgpass`, `appsettings.Production|Staging|Local`, key rings) y ningún patrón de clave/token en `-G` sobre todo el historial; en los últimos 200 commits, las únicas contraseñas añadidas son la de ejemplo y `GOOD_PASSWORD`.
- Endurecido: contraseña de ejemplo **rechazada** si el entorno no es Development/Testing/Test (`Security/KnownDevelopmentSecrets.cs`; el mensaje no vuelca la cadena de conexión); puertos del compose en `127.0.0.1`; `.gitignore` (`*.pem`, `*.key`, `*.pfx`, `*.p12`, `dataprotection-keys/`, `.pgpass`) y `backend/.dockerignore` (idem); imagen del backend sin secretos y con defaults de Production (H-2).
- Variables nuevas (todas con valor por defecto seguro): ver §10.

## 6. CSP de la SPA y verificación en navegador real

`frontend/nginx.conf` (plantilla procesada por la imagen oficial de nginx con `envsubst`; `API_ORIGIN` = origen de la API que el bundle llama, el mismo que `VITE_API_BASE_URL`):

```
default-src 'none'; script-src 'self'; style-src 'self';
img-src 'self' data: blob: ${API_ORIGIN}; font-src 'self'; connect-src 'self' ${API_ORIGIN};
base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'
```

| Directiva | Por qué (cada fuente tiene un uso real probado) |
|---|---|
| `script-src 'self'` | Solo el bundle de Vite; sin inline, sin `eval`, sin CDN. |
| `style-src 'self'` | Solo la hoja empaquetada. Los `style={{…}}` de React se aplican por CSSOM (no los bloquea la CSP): sin violaciones en el recorrido. |
| `img-src 'self' data: blob: API_ORIGIN` | `data:` = vistas previas de SVG (`svgToDataUrl`); `blob:` = miniatura del archivo elegido y rasterizado del export PNG; `API_ORIGIN` = `<img src>` de miniaturas, originales y previews servidos por la API con la cookie. |
| `connect-src 'self' API_ORIGIN` | `fetch` a la API (la cookie viaja con `credentials: "include"`). Es lo único que puede recibir datos del usuario. |
| `font-src 'self'` | La app no carga fuentes externas. |
| `base-uri`, `form-action`, `frame-ancestors`, `object-src` | Sin `<base>` ajeno, sin formularios hacia fuera, no embebible, sin plugins. |

Otras cabeceras de nginx: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, **`Referrer-Policy: strict-origin-when-cross-origin`** (nunca `no-referrer`: con ese valor el navegador envía `Origin: null` en las peticiones del mismo origen y el `CsrfGuard` respondería 403 — S08; probado: el login, registro y exports funcionan), `Permissions-Policy` mínima, `Cross-Origin-Opener-Policy: same-origin`, `server_tokens off`. Todas con `always`; no hay `add_header` dentro de `location` (anularían las heredadas). `index.html` no lleva `<meta name="referrer">`, ni scripts en línea. No se añadió `upgrade-insecure-requests` (el contenedor se prueba por http://localhost; añadirlo en el proxy TLS), ni `report-uri` (no hay colector), ni Trusted Types (no evaluado).

**Recorrido (Chrome 155 headless por DevTools, `tests/e2e/csp_browser_check.mjs`, contra nginx real + API real; cada paso recoge `securitypolicyviolation`, el log del navegador y la consola):**

| Paso | Resultado |
|---|---|
| 1 Pantalla de inicio de sesión (anónimo) | ok |
| 2 Registro de una cuenta nueva («Registro recibido») | ok |
| 3 Inicio de sesión | ok |
| 4 «Mis proyectos»: tarjeta + miniatura cargada desde la API (`img-src`) | ok |
| 5 Abrir el proyecto en el editor: capas por `fetch` con cookie + `<canvas>` (Konva) | ok |
| 6 Control: `fetch` de un asset **sin** credentials → **401**; **con** → **200** (H-7) | ok |
| 7 Exportación **SVG, DXF y PNG** desde el diálogo (Blob + `<a download>`; el PNG rasteriza por `blob:`) | ok — `logo_documento.svg/.dxf/.png` descargados |
| 8 «Mi cuenta» (perfil, cuenta de acceso, contraseña) | ok |
| 9 Flujo clásico: elegir un archivo → vista previa por `blob:` | ok |

**Violaciones de CSP: 0** (por las tres vías). **Control de mutación:** con `API_ORIGIN` vacío (CSP sin el origen de la API) el mismo script informa **14 violaciones** y 6 pasos fallidos, es decir, el detector no pasa en vacío. Errores de consola no-CSP: solo los `401` esperados de `/api/v1/auth/me` (anónimo) y del control del paso 6. (En la pasada exploratoria con el motor Python simulado aparecieron además `500` de `/api/v2/geometry/floating`: ese fake no implementa el endpoint; con el motor real no ocurren.)
Limitaciones: Chrome headless únicamente (Firefox/Safari/Edge no probados), viewport 1366×900, un solo proyecto de 1 layer con imágenes de los fakes, sin la rotación de pantallas del editor (herramientas de dibujo, booleanas, etc.); un uso real distinto del recorrido podría tocar rutas no cubiertas.

## 7. Mutaciones de control (los tests no pasan en vacío)

| Mutación | Efecto observado |
|---|---|
| Quitar el hash ficticio de la rama «cuenta bloqueada» del login | `AuthThreatReviewTests.Enumeration_LoginTimings_*` falla: «Una cuenta bloqueada responde claramente más rápido que una real: inexistente=62,0 ms, contraseña errónea=65,6 ms, bloqueada=3,1 ms» (3 de 3 ejecuciones) |
| Quitar `.RequireRateLimiting(LoginIpPolicyName)` del login | `AuthLoginRegisterRateLimitTests.Login_PerIp_*` fallan (2 de 2) |
| Desactivar la validación de ids en `readWorkspaceLocation` | `workspaceLocation.security.test.ts`: 13 tests rojos |
| CSP de nginx sin el origen de la API (`API_ORIGIN` vacío) | `csp_browser_check.mjs`: **14 violaciones** (3 vías de detección) y 6 pasos fallidos |

Todas se revirtieron (los tests vuelven a verde). 

## 8. Lo que NO se verificó

- **Proxy real delante de la API:** `AUTH_FORWARDED_HEADERS_*` solo se probó con tests de host que fijan la IP de la conexión, no con un proxy/ingress real; el compose de esta tarjeta no incluye uno.
- TLS real, certificado, dominio, HSTS en un navegador sobre https, HSTS preload.
- Firefox, Safari y navegadores móviles; zoom/teclado; el lector de pantalla.
- Comportamiento de `style-src 'self'` en el resto de herramientas del editor no recorridas (dibujo, booleanas, recorte, color): el código no usa `<style>` ni `style=""` en HTML (solo `style={{…}}` por CSSOM), pero no se pulsó cada herramienta.
- Perfiles ICC maliciosos contra ImageSharp 2.1.13 (H-1) y la superficie de los decodificadores PNG/JPEG/WEBP.
- Tiempos de las rutas ante un atacante real en red (la medición es local).
- Rotación/respaldo del key ring, restauración tras perder el volumen, múltiples instancias del backend.
- Proveedor de correo real (P5), supresión de cuenta (P11), destino de datos legados (P10): decisiones humanas abiertas.

## 9. Decisiones humanas pendientes

1. **H-1 ImageSharp** (bloquea release): aceptar con mitigaciones / actualizar a 4.1.x cumpliendo la licencia / sustituir / aislar (§5.7).
2. Dominio, certificado TLS y política de HSTS (incluido preload) de producción.
3. R-1: ¿se acepta el bloqueo de cuenta como vector de DoS o se pasa a un límite compuesto/CAPTCHA?
4. R-3: ejecutar los contenedores sin root en el despliegue real.
5. Proveedor de correo transaccional en la UE (P5).

## 10. Configuración nueva y cambios a aplicar a mano

`.env.example` **no se tocó** (hay una regla de denegación en este entorno). Variables nuevas del compose (todas opcionales, con el default indicado):

`BIND_ADDRESS` (127.0.0.1) · `API_ORIGIN` (= `VITE_API_BASE_URL`, http://localhost:5080) · `AUTH_RATE_LIMIT_LOGIN_IP_PERMIT_LIMIT` (20) · `AUTH_RATE_LIMIT_LOGIN_IP_WINDOW` (00:15:00) · `AUTH_RATE_LIMIT_LOGIN_ADDRESS_PERMIT_LIMIT` (10) · `AUTH_RATE_LIMIT_LOGIN_ADDRESS_WINDOW` (00:15:00) · `AUTH_RATE_LIMIT_REGISTER_IP_PERMIT_LIMIT` (10) · `AUTH_RATE_LIMIT_REGISTER_IP_WINDOW` (01:00:00) · `AUTH_RATE_LIMIT_REGISTER_ADDRESS_PERMIT_LIMIT` (5) · `AUTH_RATE_LIMIT_REGISTER_ADDRESS_WINDOW` (01:00:00) · `AUTH_FORWARDED_HEADERS_ENABLED` (false) · `AUTH_FORWARDED_HEADERS_KNOWN_PROXIES` (vacío) · `AUTH_FORWARDED_HEADERS_KNOWN_NETWORKS` (vacío) · `AUTH_FORWARDED_HEADERS_FORWARD_LIMIT` (1) · `AUTH_HSTS_MAX_AGE` (180.00:00:00) · `AUTH_HSTS_INCLUDE_SUBDOMAINS` (false). Opciones de la API sin variable de compose: `Upload__MaxPixels`, `Asset__MaxPixels` (64000000).

Para producción (imagen del backend, ahora Production + Authenticated por defecto): `Auth__DataProtection__KeysPath` (volumen), `Postgres__ConnectionString` con una contraseña propia, `Cors__AllowedOrigins` con el origen https real, `Auth__Email__*`, `Auth__ForwardedHeaders__*` con el proxy, y en el frontend `API_ORIGIN` igual al origen de `VITE_API_BASE_URL`.

## 11. Cómo reproducir

```bash
# Backend (con Docker): suite completa
dotnet test backend/Vectorify.sln
# Solo lo de esta tarjeta
dotnet test backend/Vectorify.Api.Tests --filter "FullyQualifiedName~AuthLoginRegisterRateLimitTests|FullyQualifiedName~ForwardedHeadersAndHstsTests|FullyQualifiedName~SecurityHeadersTests|FullyQualifiedName~ErrorHygieneTests|FullyQualifiedName~AuthLogHygieneTests|FullyQualifiedName~AuthThreatReviewTests|FullyQualifiedName~DeploymentDefaultsTests|FullyQualifiedName~AuthHardeningOptionsTests|FullyQualifiedName~SafeImageDecodingTests"
# Sin Docker: apuntar los tests de identidad a un PostgreSQL propio
VECTORIFY_TEST_POSTGRES="Host=localhost;Port=5432;Username=postgres;Password=...;Database=postgres" dotnet test ...
# Frontend
cd frontend && npm test && npm run build && npx oxlint src && npm audit
# Auditoría de paquetes .NET
dotnet list backend/Vectorify.Api/Vectorify.Api.csproj package --vulnerable --include-transitive
# CSP en navegador real (pila corriendo)
SPA_URL=http://localhost:5173 API_URL=http://localhost:5080 E2E_EMAIL=... E2E_PASSWORD=... node tests/e2e/csp_browser_check.mjs
# Tiempos de enumeración
API_URL=http://localhost:5080 SPA_ORIGIN=http://localhost:5173 node tests/e2e/auth_timing_probe.mjs
```
