# Recuperación de acceso y verificación de correo (M3.1-S08)

Complementa a `docs/ADR_AUTH_MVP31.md` («Impacto concreto en S08», T5, T15, P5/P9), `docs/AUTH_SESSION_LIFECYCLE.md` y `docs/AUTH_AUTHORIZATION.md`. Describe **lo que está implementado**,
su configuración, los requisitos del proveedor de correo y **lo que no está verificado**. Código: `Endpoints/AuthRecoveryEndpoints.cs`, `Email/*`, `Users/AuthTokenProviders.cs`,
`Users/AuthRecoveryRateLimiting.cs`, `Options/AuthOptions*.cs` (backend) y `frontend/src/auth/{authFragment,ForgotPasswordScreen,ResetPasswordScreen,ConfirmEmailScreen,ResendConfirmationForm,ChangePasswordForm}`.

## 1. Principios

- **Tokens NATIVOS de ASP.NET Core Identity**, sin tokens propios: `GeneratePasswordResetTokenAsync`/`ResetPasswordAsync` y `GenerateEmailConfirmationTokenAsync`/`ConfirmEmailAsync`. Son tokens de
  *Data Protection* (firmados y cifrados con el key ring de S04) que llevan el `SecurityStamp` de la cuenta. Dos proveedores con **propósito y vida propios** (`PasswordResetTokenProvider`, `EmailConfirmationTokenProvider`):
  un token de un uso no sirve para el otro. Perder el key ring invalida los enlaces emitidos.
- **Un solo uso.** `ResetPasswordAsync` rota el `SecurityStamp` ⇒ ese mismo token y cualquier otro pendiente de la cuenta dejan de valer (probado: el segundo uso falla). `ConfirmEmailAsync` **no** rota el stamp
  (para no cerrar las demás sesiones de quien solo confirma el correo), así que el uso único de la confirmación se impone rechazando el token cuando la cuenta **ya está confirmada**.
- **Sin enumeración de cuentas (T5).** `forgot-password` y `resend-confirmation` responden el **mismo 202** (estado, cabeceras y cuerpo) exista o no la cuenta, esté o no bloqueada o confirmada. Lo único distinto
  es un 400 `invalid_email` por correo mal formado, que no depende de la cuenta. `reset-password` y `confirm-email` devuelven **un solo** 400 `invalid_token` para token inválido, caducado, reusado, malformado,
  de otra cuenta, cuenta inexistente o límite por dirección alcanzado. El camino síncrono de forgot/resend **no toca la base ni el SMTP** (valida el formato, consulta el límite en memoria y encola), así que el tiempo
  de respuesta no delata nada ni depende de que el SMTP tarde o falle. *Riesgo residual:* el tiempo del 202 no está medido contra un atacante real.
- **El token viaja en el FRAGMENTO** (`#`) del enlace: el navegador no lo envía a ningún servidor, no queda en logs de acceso ni en el `Referer`. La SPA lo captura con un módulo de efecto importado **primero**
  en `main.tsx` (`authFragment.ts`), lo guarda solo en una variable del módulo y lo borra de la barra con `history.replaceState` antes de cualquier otra cosa (también en `hashchange`). Recargar lo pierde (la pantalla
  explica cómo seguir). No hay `<meta name="referrer">` global: haría que las peticiones del mismo origen salgan con `Origin: null` y el `CsrfGuardMiddleware` respondería 403.
- **El enlace sale de configuración**, nunca de la cabecera `Host`/`Origin` de la request (anti *host-header injection*): `Auth:Email:PublicBaseUrl`. Probado con `Host: evil.example`.
- **Nada sensible en los logs**: ni correos, ni tokens, ni contraseñas (probado con un log capturado a nivel `Trace` durante todo el flujo, incluidos fallos del SMTP). Únicas excepciones deliberadas: el modo `Log`
  (§3), que solo existe en desarrollo, y los ids internos de cuenta (GUID).

## 2. API

Todas responden `Cache-Control: no-store`. En modo `Authenticated` exigen el CSRF global (`X-Vectorify-Request` + `Origin` permitido). Las cuatro anónimas llevan además los límites de §6.

| Método y ruta | Auth | Cuerpo | Respuestas |
|---|---|---|---|
| `POST /api/v1/auth/forgot-password` | anónimo | `{email}` | **202** `{status:"accepted"}` uniforme; 400 `invalid_email`; 429 + `Retry-After` |
| `POST /api/v1/auth/reset-password` | anónimo | `{email, token, newPassword}` | **204**; 400 `invalid_token` (genérico) o `weak_password` (largo < 12 o > 128); 429 |
| `POST /api/v1/auth/confirm-email` | anónimo | `{userId` ó `email, token}` | **204**; 400 `invalid_token`; 429 |
| `POST /api/v1/auth/resend-confirmation` | anónimo | `{email}` | **202** uniforme; 400 `invalid_email`; 429 |
| `POST /api/v1/auth/change-password` | **sesión** | `{currentPassword, newPassword}` | **204** + cookie re-emitida; 400 `invalid_current_password` (**nunca 401**) o `weak_password`; 401 solo sin sesión |

- **Reset correcto**: cambia la contraseña, **rota el `SecurityStamp`** (todas las sesiones previas dejan de valer al revalidarse, ventana de `docs/AUTH_SESSION_LIFECYCLE.md` §5) y **limpia el bloqueo** (`LockoutEnd` y `AccessFailedCount`).
  No confirma el correo por sí mismo (decisión: no mezclar efectos; con `RequireConfirmedEmail=true` quien nunca confirmó pide además el reenvío).
- **change-password** exige sesión, CSRF y la contraseña actual. Una contraseña actual incorrecta es **400 `invalid_current_password`, no 401**: el cliente trata todo 401 de una pantalla protegida como «sesión
  terminada» y sacaría al usuario de su sesión por un simple error de tecleo. Cuenta bloqueada o intentos repetidos: cada fallo cuenta para el bloqueo (`Auth:Lockout:*`) y, bloqueada, ni la actual correcta cambia nada
  (sigue siendo 400). Éxito: rota el stamp (las demás sesiones caen) y **re-emite la cookie de la sesión actual** con el stamp nuevo; una sesión «recordarme» conserva su **tope absoluto original**.
  No se rechaza «la contraseña nueva es igual a la actual» (decide el servidor; hoy lo permite).
- **Registro**: tras crear una cuenta **nueva** encola el correo de confirmación (fuera de la ruta de respuesta; un fallo del SMTP no rompe el registro). Un correo ya registrado no recibe nada y la respuesta es la misma 202.
- **Login con `Auth:RequireConfirmedEmail=true`** (defecto `false`, ADR P9): una cuenta con el correo sin confirmar recibe el **mismo 401 uniforme** (código, mensaje y cabeceras) que una contraseña errónea; el reenvío sigue funcionando.
- **Login/registro** tienen sus propios límites desde M3.1-S09 (mismo limitador, ver `docs/AUTH_SECURITY_REVIEW.md` §5.1).

## 3. Correo: `IEmailSender` y `Auth:Email:Mode`

El envío ocurre **en segundo plano** (`AuthEmailQueue` + `AuthEmailWorker`, cola acotada en memoria): resuelve la cuenta, genera el token, arma el enlace y envía. Un fallo se registra
(`Correo PasswordReset: no se pudo enviar (SmtpException, SMTP 550)`) sin correo, token ni mensaje del servidor SMTP. *Límite conocido:* los pedidos pendientes se pierden si el proceso se detiene; la persona puede volver a pedir el enlace.

| `Auth__Email__Mode` | Qué hace | Dónde se permite |
|---|---|---|
| `Disabled` (defecto) | No envía nada. forgot/resend siguen respondiendo 202. Aviso en el arranque fuera de desarrollo. | Todos |
| `Log` | Escribe el mensaje **con el correo y el enlace** en el log (para probar a mano). | **Solo Development/Testing/Test**: en Production el arranque FALLA |
| `Smtp` | SMTP genérico (`System.Net.Mail.SmtpClient`, sin dependencias NuGet nuevas). | Todos; sin cifrado (`Security=None`) solo en desarrollo |

Variables (todas `Auth__...`, ver `docker-compose.yml`; el valor tras el `=` de ejemplo no es un secreto):

| Variable | Defecto | Notas |
|---|---|---|
| `Auth__Email__Mode` | `Disabled` | `Disabled` \| `Log` \| `Smtp` |
| `Auth__Email__PublicBaseUrl` | — | **Obligatoria** con `Log`/`Smtp`. Origen de la SPA (`https://app.ejemplo.com`), sin ruta; `https` fuera de desarrollo; **debe figurar en `Cors:AllowedOrigins`** |
| `Auth__Email__FromAddress`, `Auth__Email__FromName` | —, `Vectorify` | Remitente (obligatorio con `Smtp`) |
| `Auth__Email__Smtp__Host`, `__Port` | —, `587` | |
| `Auth__Email__Smtp__Security` | `StartTls` | `StartTls` \| `None` (solo desarrollo). *`SmtpClient` no soporta SMTPS implícito (465).* |
| `Auth__Email__Smtp__UserName` | — | Opcional |
| `Auth__Email__Smtp__Password` | — | **SECRETO. Solo por variable de entorno** o gestor de secretos; un test vigila que ningún `appsettings*.json` la traiga. Obligatoria si hay `UserName` |
| `Auth__Email__Smtp__Timeout` | `00:00:30` | |
| `Auth__Tokens__PasswordResetLifetime` | `01:00:00` | Máx. 7 días |
| `Auth__Tokens__EmailConfirmationLifetime` | `1.00:00:00` | Máx. 7 días |
| `Auth__RequireConfirmedEmail` | `false` | |
| `Auth__RateLimit__*` | ver §6 | |

Un valor inválido **impide el arranque** (`AuthOptionsValidator`) con un mensaje que nombra la variable.

**Plantillas** (`Email/AuthEmailTemplates.cs`): español rioplatense, texto plano + HTML mínimo (`multipart/alternative`), sin imágenes remotas ni rastreo. El texto nombra la vida del enlace (derivada de la configuración).

### Requisitos del proveedor de correo (decisión HUMANA pendiente, ADR P5)

NO se eligió ni contrató ningún proveedor. Hay que decidir y documentar:

1. **Residencia de datos en la UE y DPA firmado** (requisito confirmado, ADR P3): el proveedor trata el correo y el contenido de los mensajes.
2. Un dominio remitente propio con **SPF, DKIM y DMARC** configurados (sin ellos los correos de recuperación caen en spam o se rechazan) y un buzón `no-reply` o similar.
3. Acceso **SMTP con STARTTLS** (587) con usuario y contraseña de aplicación (API key con permiso solo de envío), guardados en el gestor de secretos del despliegue.
4. Cuotas y límites de envío acordes al tráfico, y un contacto para incidencias de entregabilidad.
5. Política de registros del proveedor (los proveedores suelen conservar destinatarios y asuntos): revisarla contra la política de privacidad.

## 4. Enlaces de los correos

```
{PublicBaseUrl}/?view=reset-password#email=<encodeURIComponent(email)>&token=<encodeURIComponent(token)>
{PublicBaseUrl}/?view=confirm-email#userId=<guid>&token=<encodeURIComponent(token)>
```

La pantalla de confirmación acepta también `#email=…&token=…`. Los valores van con `Uri.EscapeDataString` (equivalente a `encodeURIComponent`): un `+`, `/` o `=` del token sobrevive al `URLSearchParams` de la SPA.

## 5. Frontend

Pantallas por *query string* (sin react-router): `?view=forgot-password`, `?view=reset-password`, `?view=confirm-email` y la sección «Contraseña» de «Mi cuenta» (solo en modo `Authenticated`). Enlaces «¿Olvidaste tu contraseña?» y
«¿No te llegó el correo para confirmar tu cuenta?» **después** del botón del login. Reglas: ningún token en `localStorage`/`sessionStorage`/`history.state`/DOM/consola; el correo pasa entre pantallas solo en memoria (`prefillEmail`);
la confirmación es automática y **una sola petición por token** aunque `StrictMode` monte dos veces; `Retry-After` de un 429 se lee (`ApiClientError.retryAfterSeconds`) y se muestra en minutos; el backend lo expone por CORS
(`Access-Control-Expose-Headers: Retry-After`). Con sesión real, las pantallas de restablecer/confirmar **no redirigen** (el enlace viene de un correo); tras restablecer se cierra la sesión local sin el aviso de «sesión terminada».
Las pantallas de producto siguen sin importar nada de auth (test de arquitectura de S05 verde).

## 6. Límites de frecuencia (`Microsoft.AspNetCore.RateLimiting`)

| Eje | Rutas | Defecto | Al excederse |
|---|---|---|---|
| **Por IP** (y por ruta) | forgot, reset, confirm, resend | `Auth__RateLimit__IpPermitLimit=20` por `IpWindow=00:15:00` | **429** + `Retry-After` (segundos), `Cache-Control: no-store`, `{code:"rate_limited"}` |
| **Por dirección** (HMAC-SHA256 con clave aleatoria de proceso; el correo no se guarda en claro) | forgot + resend comparten contador | `AddressSendPermitLimit=5` por `AddressWindow=01:00:00` | el **mismo 202** uniforme **sin enviar** |
| Por dirección (o id de cuenta) | reset + confirm comparten contador | `AddressVerifyPermitLimit=10` por `AddressWindow` | el mismo 400 `invalid_token` genérico (aun con un token válido) |

Ventana fija, en memoria, **por instancia**. Límites conocidos: (a) tras un proxy sin `Auth__ForwardedHeaders__*` (S09, ver `docs/AUTH_SECURITY_REVIEW.md` §5.2) todas las peticiones comparten la IP del proxy y el límite por IP actúa como global; (b) varias instancias dividen el contador;
(c) un atacante puede agotar el cupo por dirección de una víctima (negación de servicio dirigida a *su* recuperación; el cupo se renueva solo). S09 lo extendió a login y registro (`docs/AUTH_SECURITY_REVIEW.md` §5.1, con el efecto del bloqueo de cuenta como DoS).

## 7. Comportamiento con `Auth:Mode=Development`

Sin cambios: el flujo de desarrollo (usuario fijo, sin login) y los E2E anónimos siguen igual. Las rutas nuevas existen; `change-password` responde 401 (no hay sesión que cambiar); `Auth:Email:Mode` es `Disabled` salvo configuración.
En la SPA las tres vistas nuevas redirigen a Mis proyectos y la sección «Contraseña» no se pinta.

## 8. Probar a mano

Con el compose (puertos propios para no tocar tu proyecto habitual):

```
docker compose -p vectorify-s08 --profile mail-sink up -d --build
# variables: AUTH_MODE=Authenticated, AUTH_EMAIL_MODE=Smtp, AUTH_EMAIL_SMTP_HOST=mailpit, AUTH_EMAIL_SMTP_PORT=1025, AUTH_EMAIL_SMTP_SECURITY=None,
#            AUTH_EMAIL_FROM_ADDRESS=no-reply@vectorify.local, AUTH_EMAIL_PUBLIC_BASE_URL=<origen de la SPA> (y el mismo en CORS_ALLOWED_ORIGINS)
```

Los mensajes aparecen en la UI de Mailpit (`http://localhost:8025` por defecto). Alternativa sin contenedor: `AUTH_EMAIL_MODE=Log` (solo desarrollo) y leer el enlace en `docker compose logs backend`.

## 9. Tests

| Qué | Archivo |
|---|---|
| Flujos completos, tokens válido/caducado/reusado/malformado/de otra cuenta/cuenta inexistente, respuesta idéntica a conocido, sesiones invalidadas tras reset y tras change-password, bloqueo limpiado, contraseña débil, `RequireConfirmedEmail` true/false, enlace con `PublicBaseUrl` y nunca `Host`, envío fuera de la ruta de respuesta, change-password (400 vs 401, cookie re-emitida, tope «recordarme»), registro que envía y no se rompe | `EndToEnd/AuthRecoveryEndpointsTests.cs` |
| Límite por IP (429, `Retry-After`, CORS) y por dirección | `EndToEnd/AuthRecoveryRateLimitTests.cs` |
| **Entrega SMTP REAL** contra un servidor SMTP falso en proceso (`TestSupport/FakeSmtpServer.cs`: EHLO, AUTH LOGIN, MAIL/RCPT/DATA, MIME multipart), flujos registro→confirmar y olvidé→restablecer→entrar con los enlaces recibidos, SMTP caído/rechazando destinatarios, logs sin PII, modo `Log`, arranque en Production | `EndToEnd/AuthRecoverySmtpTests.cs` |
| Validación de opciones | `Users/AuthRecoveryOptionsValidatorTests.cs` |
| Rutas anónimas nuevas y `change-password` en las listas del auditor | `EndToEnd/EndpointAuthorizationArchitectureTests.cs`, `TestSupport/EndpointAuthorizationAudit.cs` |
| Frontend: captura/borrado del fragmento, orden de arranque, cada pantalla y estado, StrictMode, 429 con `Retry-After`, 400 vs 401 | `frontend/src/auth/*.test.tsx` |

## 10. Verificación manual realizada (2026-10-18)

Pila aislada `docker compose -p vectorify-s08 --profile mail-sink` (SPA `:28173`, API `:28080`, Mailpit `:28025`, `AUTH_MODE=Authenticated`, `AUTH_EMAIL_MODE=Smtp` contra el contenedor Mailpit) y un **Chrome real en modo headless**
dirigido por el protocolo DevTools (31 comprobaciones, todas OK): registro → «Registro recibido» (condicional) → **correo en Mailpit** (asunto, remitente, texto + HTML, enlace con el token en el fragmento) → abrir el enlace → barra sin fragmento y
«Correo confirmado» → mismo enlace otra vez = «No pudimos confirmar tu correo»; login; «Mi cuenta → Contraseña» con la actual incorrecta (error en el campo, sin salir de la sesión) y correcta (campos vacíos, la cookie re-emitida sigue dando 200);
«¿Olvidaste tu contraseña?» (correo precargado, foco en el h1) → «Pedido recibido» idéntico para un correo desconocido (a ese correo no llega nada) → **correo de restablecimiento en Mailpit** → enlace → formulario (campo de usuario oculto) → contraseña corta rechazada
en el cliente → restablecer → aviso en el login → la contraseña vieja ya no entra y la nueva sí → el enlace de restablecimiento reusado muestra «Este enlace ya no es válido» → sin fragmento «Abrí el enlace desde tu correo»; sin scroll horizontal a 360 px;
sin errores de consola inesperados. Con curl: 20 pedidos por IP y el siguiente da 429 con `Retry-After: 900` y `Access-Control-Expose-Headers: X-Correlation-Id,Retry-After`. Con el compose en `AUTH_MODE=Development`: `mvp3_release_e2e_test.mjs` 10/10 y
`full_pipeline_e2e_test.mjs` 6/6 (el flujo anónimo no cambió). No se probó STARTTLS contra un servidor con certificado, ni otros navegadores, ni 768/1280/1920 px, ni zoom 200 %, ni modo claro.

## 11. Qué NO está verificado

- **Un proveedor de correo real** (entregabilidad, SPF/DKIM/DMARC, STARTTLS con un certificado real, límites del proveedor): solo se probó contra un sumidero local sin TLS. `SmtpClient` con STARTTLS no se ejercitó.
- **Caducidad con reloj controlado**: `Microsoft.Extensions.Identity.Core` valida los tokens con `DateTimeOffset.UtcNow` (no usa `TimeProvider`), así que la caducidad se prueba con una vida de 2 s y una espera real.
- **Tiempos de respuesta** de forgot/resend contra un atacante (no medidos), límites por instancia con varias réplicas, `ForwardedHeaders`/IP real tras un proxy (S09: implementado, ver `docs/AUTH_SECURITY_REVIEW.md`).
- **Navegadores reales** salvo el recorrido manual descrito en el informe de la tarjeta; no hay axe en el repo (accesibilidad verificada con Testing Library).
- El historial del navegador puede conservar la URL original con el fragmento (antes del `replaceState`); se acepta porque el token vence y sirve una vez.
