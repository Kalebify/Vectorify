# M3.1-S03 · Login + Logout
URL: https://app.notion.com/p/3e8d77b2639881609ec9d6f1eb9e279b
Stack declarado: Frontend, ASP.NET Core (propiedad Área). Identidad confirmada: ASP.NET Core Identity + cookie (docs/ADR_AUTH_MVP31.md). .NET 10.

## Requerimiento (transcripción del cuerpo de la tarjeta)
Objetivo: Implementar entrada y salida segura de VECTORiZE usando la arquitectura elegida.

## Login
Soportar los métodos aprobados en S01; no añadir proveedores sociales fuera de alcance.
## Logout
Eliminar estado local sensible y terminar sesión server/provider según arquitectura.
## UX
Mensajes genéricos para credenciales inválidas; loading; retorno a destino original cuando sea seguro.
## Backend
Resolver CurrentUser exclusivamente desde identidad verificada, nunca desde userId enviado por cliente.
## Tests
Success/failure, logout, back button, session expired y múltiples pestañas.
## DoD
No es posible seguir consumiendo endpoints protegidos después de logout efectivo.

## Criterios de aceptación
- Login válido abre sesión y carga proyectos del usuario; Logout invalida/termina la sesión según proveedor y rutas protegidas dejan de ser accesibles. (declarado)
- DERIVADO: `POST /api/v1/auth/login` (email + contraseña) emite la cookie de Identity (HttpOnly, SameSite=Lax; `Secure`/`__Host-` según `Auth:Cookie`); credenciales inválidas, cuenta inexistente y cuenta bloqueada devuelven el MISMO 401 y cuerpo (T5); bloqueo tras 5 fallos / 15 min (T6).
- DERIVADO: `POST /api/v1/auth/logout` borra la cookie; `GET /api/v1/auth/me` devuelve el usuario actual (id interno, email, nombre) solo desde la identidad verificada de la cookie; 401 sin sesión. Nada que venga del cliente decide quién es el usuario (RS10/T13).
- DERIVADO: tras logout, una copia robada de la cookie anterior sigue válida hasta caducar o hasta rotar el SecurityStamp (limitación conocida del ADR, D3.7). Decisión: logout rota el `SecurityStamp` de la cuenta ("cerrar sesión" invalida también copias) o se documenta explícitamente la limitación; el implementador elige y lo declara. DoD: tras logout efectivo, `GET /api/v1/auth/me` y los endpoints protegidos responden 401 con la cookie del navegador.
- DERIVADO: CSRF (T3): en modo `Authenticated`, todo método no seguro exige la cabecera `X-Vectorify-Request` y un `Origin` permitido (403 si falta/ajeno). En modo `Development` (sin sesiones) el guard NO se aplica para no romper el flujo de desarrollo ni los E2E anónimos.
- DERIVADO: CORS añade `X-Vectorify-Request` a las cabeceras permitidas.
- DERIVADO (frontend): `frontend/src/api/httpClient.ts` (`request` y `uploadFile`) envía `credentials: "include"` y la cabecera `X-Vectorify-Request`; se añade un `authApi` mínimo (register/login/logout/me) y manejo de 401 sin pantallas. Las pantallas de login/registro, el contexto React de sesión y las rutas protegidas son de M3.1-S05: FUERA de alcance aquí.
- DERIVADO: los tests existentes (1833 backend, ~3260 frontend) siguen verdes; `npm run build` verde.

## Referencias visuales / de marca
No aplica (la UI de auth es M3.1-S05).

## Contexto técnico vinculante
`docs/ADR_AUTH_MVP31.md`: D3 (cookie vs token, CSRF), amenazas T1–T6/T13/T15, «Impacto concreto en S03». Lo construido en S02: `.sprint/3e8d77b2-6398-81c8-835c-fb711ce83b9d/IMPL.md` (AuthRegistration, AuthOptions, AuthEndpoints, UserProvisioningMiddleware, `Auth:Mode`).

## Umbrales de calidad
Sin Lighthouse (no hay UI nueva). `dotnet build` 0 errores; `dotnet test Vectorify.sln` verde (con Docker); `npm test` y `npm run build` del frontend verdes; sin secretos en repo; el flujo de desarrollo (Auth:Mode=Development, sin login) sigue funcionando igual.

## Ambigüedades detectadas
Ninguna que impida empezar. Supuestos por defecto del ADR (preguntas abiertas P9/P12): «recordarme» y duración de sesión son S04 (en S03 la cookie usa la política por defecto de `Auth:Session`); sin verificación de email obligatoria (S08); «múltiples pestañas» y «back button» se prueban en la medida en que son comportamiento de cliente/servidor sin UI (S05 cubre la UI).
