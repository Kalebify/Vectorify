# M3.1-S02 · Registro + creación/vinculación de User
URL: https://app.notion.com/p/3e8d77b2639881c8835cfb711ce83b9d
Stack declarado: ASP.NET Core, Frontend, Infra (propiedad Área). Decisión de identidad confirmada: ASP.NET Core Identity + cookie (docs/ADR_AUTH_MVP31.md, «Decisión confirmada»). .NET 10 (PR #65).

## Requerimiento (transcripción del cuerpo de la tarjeta)
Objetivo: Permitir crear una identidad y vincularla de forma idempotente con el User interno de VECTORiZE.

## Flujo
Sign up → verificación si aplica → callback/session → resolver identidad externa → crear/vincular User local → entrar en aplicación.
## Datos
Nunca guardar contraseña en claro. Si el proveedor gestiona credenciales, VECTORiZE no almacena password hash. ExternalIdentity debe ser única por provider+subject.
## UX
Formulario/redirect según proveedor, loading, errores de email existente y verificación pendiente.
## Backend
Identity resolver idempotente y transaccional.
## Privacidad
Guardar solo datos necesarios; timestamps y estado de cuenta.
## Tests
Registro correcto, callback repetido, identidad ya vinculada, error proveedor y email conflictivo.
## DoD
Existe User local estable listo para ownership.

## Criterios de aceptación
- Un usuario nuevo completa registro soportado, obtiene User interno único y no se crean duplicados al repetir callback/evento. (declarado)
- DERIVADO: `UserIdentity` única por (Provider, Subject); resolución idempotente y transaccional, correcta con peticiones concurrentes.
- DERIVADO: respuesta de registro uniforme exista o no el correo (T5 del ADR).
- DERIVADO: política de contraseña ≥ 12 caracteres; hash adaptativo de Identity; nunca se loguea ni se devuelve.
- DERIVADO: `Production` no puede arrancar con `Auth:Mode=Development`; el dominio (`Project`, servicios, repositorios, `IUserContext`) no cambia.
- DERIVADO: los 5 casos de la sección Tests (registro correcto, callback repetido, identidad ya vinculada, error de proveedor, email conflictivo).

## Referencias visuales / de marca
No aplica a esta tarjeta (backend de identidad; la UI de auth es M3.1-S05).

## Contexto técnico vinculante
`docs/ADR_AUTH_MVP31.md`, secciones «Modelo definitivo del vínculo de identidad», «Cambios exactos que harán S02», «Impacto concreto en S02» y D2. PoC de referencia: `backend/spikes/AuthPoc/` (copiar a `Vectorify.Api/Users/`, no referenciarlo).

## Umbrales de calidad
Defaults de Lighthouse/axe NO aplican (sin UI). Aplica: `dotnet build` 0 errores; `dotnet test Vectorify.sln` verde (con Docker); migraciones reversibles (Up/Down); sin secretos en repo/imagen; `npm test` y `npm run build` del frontend sin cambios.

## Ambigüedades detectadas
Ninguna que impida empezar. Preguntas abiertas del ADR sin respuesta, se aplican sus valores propuestos por defecto y se declaran como supuestos:
- P9: verificación de email NO obligatoria en S02 (el envío de email y la verificación son S08); contraseña ≥ 12 caracteres.
- P5: proveedor de email (UE) sin decidir → fuera de S02 (S08).
- P10: destino de los datos del usuario de desarrollo → fuera de S02 (S06/S07).
- P12: bloqueo 5 intentos / 15 min, sesión 8 h → S03/S04.
- La tarjeta menciona «callback/proveedor externo»: con Identity propio no hay callback OIDC; «idempotencia ante callback repetido» se interpreta como idempotencia del resolver `(Provider, Subject)` y del registro repetido.
