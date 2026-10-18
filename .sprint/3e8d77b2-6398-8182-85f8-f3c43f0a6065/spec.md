# M3.1-S08 · Recuperación de acceso + verificación
URL: https://app.notion.com/p/3e8d77b26398818285f8f3c43f0a6065
Stack declarado: Frontend, ASP.NET Core, Infra (propiedad Área). ASP.NET Core Identity + cookie (S02-S07), React 19 + TypeScript + Vite, .NET 10.

## Requerimiento (transcripción del cuerpo de la tarjeta)
Objetivo: Implementar recuperación/cambio de acceso y verificación de email cuando la estrategia de identidad lo requiera.

## Regla
Preferir capacidades nativas del proveedor elegido. No reinventar reset tokens si no es necesario.
## UX
Forgot access/password, confirmación genérica, pantalla de reset/callback y resultado.
## Seguridad
No account enumeration; rate limits; expiración; one-time use; invalidar sesiones si la política lo requiere.
## Email verification
Implementar solo si forma parte de la estrategia seleccionada.
## Tests
Valid, expired, reused, malformed, unknown email y rate-limit behavior.
## DoD
Recuperación no requiere intervención manual del administrador en el happy path.

## Criterios de aceptación
- El usuario puede recuperar acceso mediante flujo seguro del proveedor/Identity; tokens son de un solo uso/expiran y no se revela si una cuenta existe. (declarado)
- DERIVADO (ADR «Impacto concreto en S08», T5, T15): usar los tokens NATIVOS de ASP.NET Core Identity (`UserManager.GeneratePasswordResetTokenAsync` / `ResetPasswordAsync`, `GenerateEmailConfirmationTokenAsync` / `ConfirmEmailAsync`); NO inventar tokens propios. Vida corta y configurable (`Auth:Tokens:*`, defecto: restablecer 1 h, confirmar 24 h); un solo uso (se invalidan al rotar el `SecurityStamp`: probar que un segundo uso falla). Reset correcto ⇒ rota el stamp (todas las sesiones previas dejan de valer, ADR T15) y limpia el bloqueo de la cuenta.
- DERIVADO (backend): `POST /api/v1/auth/forgot-password` (anónimo, respuesta 202 UNIFORME exista o no la cuenta, mismo cuerpo/cabeceras/forma; sin diferencias de tiempo evidentes: no enviar el correo dentro del camino síncrono visible), `POST /api/v1/auth/reset-password` {email, token, newPassword} (error genérico para token inválido/caducado/reusado/malformado y para cuenta inexistente; contraseña ≥ 12 como en el registro), `POST /api/v1/auth/confirm-email` {userId/email, token}, `POST /api/v1/auth/resend-confirmation` (202 uniforme) y `POST /api/v1/auth/change-password` {currentPassword, newPassword} (sesión obligatoria, CSRF, exige la contraseña actual, rota el stamp y mantiene viva la sesión actual re-emitiendo su cookie; es el «cambio de acceso» que S07 dejó pendiente). Todas con CSRF en modo Authenticated, `Cache-Control: no-store`, sin loguear correos, tokens ni contraseñas. Rutas nuevas anónimas en la lista blanca del test de arquitectura de S06 (con justificación) y `change-password` como protegida.
- DERIVADO (correo): abstracción `IEmailSender` con implementaciones por configuración `Auth:Email:Mode` = `Disabled` | `Log` (SOLO Development/Testing: escribe el mensaje, con el enlace, en el log para poder probar a mano; prohibido fuera de esos entornos, validado al arrancar) | `Smtp` (host/puerto/TLS/usuario/remitente por variables de entorno `Auth__Email__*`; la contraseña SMTP nunca en el repo). El proveedor de envío concreto y su residencia en la UE con DPA (ADR P5, requisito confirmado) es DECISIÓN HUMANA: NO elegir ni contratar proveedor; dejar SMTP genérico y documentar los requisitos. Preferir no añadir dependencias NuGet (si se usa MailKit u otra, justificarlo por escrito). El envío ocurre FUERA de la ruta de respuesta (cola en segundo plano o fire-and-forget con manejo de errores) para no abrir un canal de temporización ni romper el registro si el SMTP falla; los fallos de envío se registran sin PII.
- DERIVADO (enlaces): los correos enlazan a la SPA usando una URL pública CONFIGURADA (`Auth:Email:PublicBaseUrl`, validada: https salvo Development, y debe figurar en `Cors:AllowedOrigins`), NUNCA derivada de la cabecera Host/Origin de la petición (anti host-header injection). El token viaja en el FRAGMENTO de la URL (`#`) para que no llegue a servidores, logs ni cabecera Referer; la SPA lo lee y lo elimina de la barra con `history.replaceState` antes de cualquier otra cosa. Plantillas en español, texto plano + HTML mínimo, sin imágenes remotas ni rastreo.
- DERIVADO (verificación de correo): se implementa porque el reset depende de que el correo sea de su dueño, PERO NO es obligatoria para iniciar sesión por defecto (ADR P9 abierta): `Auth:RequireConfirmedEmail` (defecto `false`, configurable y validado; si `true`, el login de una cuenta sin confirmar devuelve el MISMO 401 uniforme y el reenvío sigue funcionando). Tras el registro se envía el correo de confirmación (si el modo de correo lo permite). Mensaje de «Registro recibido» sin afirmar que el correo llegó.
- DERIVADO (límites de frecuencia; S09 generaliza): límite de peticiones con el rate limiter nativo (`Microsoft.AspNetCore.RateLimiting`, ya en el framework) sobre forgot-password, reset-password, resend-confirmation y confirm-email: por IP y por dirección (hash, no el correo en claro). Por IP ⇒ 429 con `Retry-After`; por dirección ⇒ respuesta 202 uniforme SIN enviar (para no revelar nada). Valores configurables; no limitar login/register aquí (S09).
- DERIVADO (frontend, siguiendo S05): enlace «¿Olvidaste tu contraseña?» en el login; pantallas de solicitud (confirmación genérica «si existe una cuenta…»), de restablecimiento (lee el token del fragmento, nueva contraseña + repetir, resultado), de confirmación de correo (resultado, reenvío) y «Cambiar contraseña» dentro de «Mi cuenta» (S07). Mensajes uniformes, accesibles (foco, ARIA, aria-live), con los tokens `--auth-*`; ningún token en `localStorage`/`sessionStorage`/logs; el fragmento se borra de la URL; `returnUrl` sigue validado. Las pantallas de producto no importan auth (test de arquitectura de S05 verde). Diseño: `.sprint/3e8d77b2-6398-8182-85f8-f3c43f0a6065/DESIGN.md` (web-design-architect).
- DERIVADO (docs): actualizar `docs/AUTH_SESSION_LIFECYCLE.md`/`docs/AUTH_AUTHORIZATION.md` o crear `docs/AUTH_RECOVERY.md` con el flujo, configuración `Auth__Email__*`/`Auth__Tokens__*`, requisitos del proveedor de correo (UE + DPA), variables nuevas para `.env.example` (NO tocar ese archivo: hay una regla de denegación; listarlas en el informe) y lo no verificado.
- DERIVADO (tests): válido, caducado (reloj controlable), reusado, malformado, correo desconocido (respuesta idéntica a conocido), límite de frecuencia (IP y dirección), invalidación de sesiones tras reset y tras change-password, bloqueo limpiado, contraseña débil, token de otra cuenta, `RequireConfirmedEmail` true/false, el enlace usa `PublicBaseUrl` y nunca Host, el correo no aparece en logs, fallo del SMTP no rompe el registro; verificación real del envío SMTP contra un sumidero local (servidor SMTP falso en proceso o contenedor tipo Mailpit en el compose aislado).
- DERIVADO: los tests existentes (2014 backend, 3523 frontend) siguen verdes; `npm run build` verde; en modo Development el flujo existente no cambia.

## Referencias visuales / de marca
Lenguaje visual y tokens `--auth-*` de S05/S07 (frontend/src/auth/auth.css, `.sprint/3e8d77b2-6398-81e1-ac16-f85c9543a936/DESIGN.md`, `.sprint/3e8d77b2-6398-812a-8c0e-c7f89f52d2cf/DESIGN.md`).

## Contexto técnico vinculante
`docs/ADR_AUTH_MVP31.md` («Impacto concreto en S08», T5, T15, P5/P9), `docs/AUTH_SESSION_LIFECYCLE.md`, `docs/AUTH_AUTHORIZATION.md` y los IMPL de S02-S07 en `.sprint/`. Backend: `Endpoints/AuthEndpoints.cs`, `Users/AuthRegistration.cs`, `Options/AuthOptions*.cs`, `Middleware/CsrfGuardMiddleware.cs`, test de arquitectura de S06 (`EndpointAuthorizationArchitectureTests`, `TestSupport/EndpointAuthorizationAudit.cs`). Frontend: `frontend/src/auth/*`, `AppRoot.tsx`, `api/authApi.ts`.

## Umbrales de calidad
`dotnet test Vectorify.sln` y `npm test`/`npm run build` verdes; sin secretos en repo; accesibilidad con testing-library (axe no está en el repo: declarar); verificación real en navegador con pila local aislada en modo Authenticated.

## Ambigüedades detectadas
Ninguna que impida empezar. Decisiones abiertas con valor por defecto: proveedor de correo y remitente (P5, humana; SMTP genérico); verificación de correo no obligatoria (P9); límites de frecuencia con valores por defecto configurables; la entrega real de correo no se puede verificar sin proveedor (se verifica contra un sumidero SMTP local).
