# M3.1-S07 · Perfil y configuración básica de cuenta
URL: https://app.notion.com/p/3e8d77b26398812a8c0ec7f89f52d2cf
Stack declarado: Frontend, ASP.NET Core (propiedad Área). ASP.NET Core Identity + cookie (S02-S06), React 19 + TypeScript + Vite, .NET 10.

## Requerimiento (transcripción del cuerpo de la tarjeta)
Objetivo: Permitir consultar y modificar datos básicos de perfil que pertenecen a VECTORiZE sin confundirlos con credenciales del proveedor.

## Perfil mínimo
DisplayName, avatar opcional si se decide, locale/preferences básicas solo si aportan valor.
## Separación
Datos de dominio VECTORiZE vs identidad/credenciales externas.
## API
GET/PATCH /api/v1/me o equivalente.
## UX
Account/Profile desde menú de usuario.
## Seguridad
No permitir cambiar UserId/ExternalSubject desde cliente.
## Tests
Read/update, validación, unauthorized y provider-managed fields.
## Fuera de alcance
Planes, billing, organizaciones y equipos.

## Criterios de aceptación
- Usuario autenticado ve su perfil y puede editar campos permitidos; email/identidad siguen reglas del proveedor elegido. (declarado)
- DERIVADO (ADR «Impacto concreto en S07»): `GET /api/v1/me` y `PATCH /api/v1/me` (distintos de `GET /api/v1/auth/me`, que es la consulta de sesión de S03/S05). El perfil expone `id` (User interno), `email` (SOLO LECTURA), `displayName`, `createdAt` y un indicador de qué campos están gestionados por la cuenta/identidad (`email`). `PATCH` acepta SOLO `displayName` (recortado, 1–80 caracteres, sin caracteres de control; mensajes de validación en español); cualquier otro campo del cuerpo (`id`, `userId`, `email`, `provider`, `subject`, `createdAt`, `authMode`…) NO tiene efecto, con test que lo demuestre (decidir y declarar si se rechaza con 400 o se ignora).
- DERIVADO: el usuario se resuelve SOLO desde `IUserContext` (identidad verificada), nunca de un id del cliente; 401 sin sesión; con CSRF (cabecera + Origin) como el resto de métodos no seguros en modo Authenticated; `Cache-Control: no-store`; las respuestas no filtran datos de identidad interna (provider/subject/hash/stamp).
- DERIVADO: nombre de visualización compartido: tras `PATCH`, `GET /api/v1/auth/me` y el menú de usuario muestran el nombre nuevo; el campo vive en `Users.DisplayName` (dominio), no en Identity.
- DERIVADO (decisión de alcance, declarar en el informe): el CAMBIO DE EMAIL requiere reverificación por correo y el envío de correo no existe hasta M3.1-S08: el email queda de solo lectura en S07 (UI lo muestra con la explicación «se gestiona con tu cuenta»). El CAMBIO DE CONTRASEÑA y la recuperación son S08. NO se implementan avatar ni locale/preferencias (no aportan valor demostrado hoy; declarar «no implementado» explícitamente).
- DERIVADO (decisión humana pendiente, NO implementar): la SUPRESIÓN DE CUENTA y la EXPORTACIÓN DE DATOS (derecho UE; el ADR las asignaba a esta tarjeta) dependen de la pregunta abierta P11 (plazo de retención, qué se borra y qué se conserva, destino de los `Project` por la FK Restrict) y son destructivas e irreversibles. No están en el texto de la tarjeta. Se documentan como pendientes de decisión (docs/AUTH_AUTHORIZATION.md o doc nuevo breve) con el diseño propuesto, sin código.
- DERIVADO (frontend): pantalla «Mi cuenta» (perfil) accesible desde el menú de usuario (ítem «Mi cuenta», que S05 dejó pendiente) y como ruta protegida bajo el `AuthBoundary`/`AccountLayout` de S05, sin que las pantallas de producto importen auth. Formulario accesible (label, errores con aria-live, estado guardando, confirmación de guardado, foco), nombre actualizado en el menú tras guardar, en modo Development la pantalla funciona para el usuario de desarrollo (indicando «Modo desarrollo»), errores 401/403/red/5xx distintos, sin perder lo escrito si falla el guardado.
- DERIVADO: aislamiento: PATCH nunca puede modificar el perfil de otro usuario (matriz UserA/UserB en la suite de aislamiento de S06, extendida con las rutas nuevas; el test de arquitectura de rutas de S06 debe seguir verde con la ruta nueva en la lista correcta).
- DERIVADO: los tests existentes (1967 backend, 3454 frontend) siguen verdes; `npm run build` verde.

## Referencias visuales / de marca
Seguir el lenguaje visual existente y los tokens `--auth-*` de S05 (frontend/src/auth/auth.css, DESIGN.md de S05 en .sprint/3e8d77b2-6398-81e1-ac16-f85c9543a936/). Diseño de esta pantalla: `.sprint/3e8d77b2-6398-812a-8c0e-c7f89f52d2cf/DESIGN.md` (web-design-architect).

## Contexto técnico vinculante
`docs/ADR_AUTH_MVP31.md` («Impacto concreto en S07», «Modelo definitivo del vínculo de identidad»), `docs/AUTH_AUTHORIZATION.md`, `docs/AUTH_SESSION_LIFECYCLE.md` y los IMPL de S02-S06 en `.sprint/`. Backend: `Data/User.cs`, `Endpoints/AuthEndpoints.cs`, `Users/*`, test de arquitectura de rutas de S06 (`EndpointAuthorizationArchitectureTests`, `RouteInventory`). Frontend: `frontend/src/auth/*` (AuthProvider, AccountLayout, UserMenu, authLocation), `frontend/src/AppRoot.tsx`, `api/authApi.ts`.

## Umbrales de calidad
UI: accesibilidad (axe no está en el repo: verificar con testing-library y declararlo), sin errores de consola, layouts 360/768/1280/1920 sin roturas (verificación real en navegador con pila local aislada en modo Authenticated). `dotnet test Vectorify.sln` y `npm test`/`npm run build` verdes.

## Ambigüedades detectadas
Ninguna que impida empezar. Decisiones abiertas con valor por defecto: email de solo lectura (cambio = S08); sin avatar ni locale; supresión/exportación de cuenta fuera hasta decidir P11.
