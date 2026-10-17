# M3.1-S05 · React Auth State + rutas protegidas
URL: https://app.notion.com/p/3e8d77b2639881e1ac16f85c9543a936
Stack declarado: Frontend (propiedad Área); React 19 + TypeScript + Vite existentes. Backend ya construido en S02-S04 (Identity + cookie).

## Requerimiento (transcripción del cuerpo de la tarjeta)
Objetivo: Integrar autenticación en React sin mezclar lógica de sesión con cada pantalla.

## Componentes
AuthProvider/useAuth o abstracción equivalente, ProtectedRoute/AuthBoundary y User menu.
## Estados
Unknown/loading, authenticated, unauthenticated y auth error. Evitar flash de contenido privado.
## Rutas protegidas
Projects, Editor y futuras páginas de cuenta.
## API client
Credenciales/config centralizadas; manejo 401/403 diferenciado.
## UX
Mantener returnUrl interno validado; evitar open redirect.
## Tests
Deep link, refresh browser, expired session, logout y error de red.
## DoD
Las pantallas de producto no implementan autenticación ad hoc.

## Criterios de aceptación
- Rutas privadas esperan resolución de sesión, redirigen al login cuando corresponde y restauran navegación tras autenticación. (declarado)
- DERIVADO (ADR «Impacto concreto en S05»): pantallas de registro y login (formularios accesibles: etiquetas, foco, ARIA, loading, mensajes uniformes sin revelar si la cuenta existe), contexto de sesión en React que consulta `GET /api/v1/auth/me`, rutas protegidas, botón/menú de usuario con «Salir» y «Cerrar sesión en todos lados», manejo global de 401 vía `onSessionExpired` (S04). «Olvidé mi contraseña»/verificación de email = S08: FUERA (no mostrar enlaces muertos ni prometer correos que no se envían).
- DERIVADO: estados Unknown/loading, authenticated, unauthenticated y auth error (red/5xx distinto de 401); sin flash de contenido privado mientras la sesión está Unknown; un error de red NO se interpreta como «sesión cerrada» (reintento controlado).
- DERIVADO: `returnUrl` interno validado (solo rutas/consultas del mismo origen de la propia app; rechazar `//`, `http(s):`, `javascript:`, backslashes, etc.); tras login se restaura la navegación original (deep link al Workspace con sus query params incluidos); evitar open redirect, con tests de payloads maliciosos.
- DERIVADO: 401 vs 403 diferenciados en el cliente (401 ⇒ sesión; 403 ⇒ prohibido/CSRF, no cierra sesión ni redirige a login).
- DERIVADO (Development): el modo de desarrollo del backend (`Auth:Mode=Development`, sin login, usuario de desarrollo) debe seguir usable sin pantallas de login. Hoy `GET /me` da 401 sin cookie incluso en Development, lo que dejaría la SPA bloqueada: el implementador debe resolverlo (propuesta: en modo Development `/me` devuelve 200 con el usuario de desarrollo y un indicador de modo para ocultar «Salir»/login; actualizar los tests de S03 que lo fijan) y declarar la decisión.
- DERIVADO: pantallas de producto (Projects dashboard, Editor/Workspace, flujo clásico) no importan `authApi` ni gestionan 401 ad hoc: toda la lógica vive en el módulo de auth; test de arquitectura que lo haga cumplir.
- DERIVADO: los tests existentes (1926 backend, 3308 frontend) siguen verdes; `npm run build` verde.

## Referencias visuales / de marca
No hay marca declarada para las pantallas de auth: seguir el lenguaje visual existente del frontend (frontend/src/App.css, index.css, componentes de projects/). Sin nuevas dependencias de UI. Diseño: `.sprint/3e8d77b2-6398-81e1-ac16-f85c9543a936/DESIGN.md` (web-design-architect).

## Contexto técnico vinculante
`docs/ADR_AUTH_MVP31.md` (D3, T1/T3/T4/T5, «Impacto concreto en S05»), `docs/AUTH_SESSION_LIFECYCLE.md`, IMPL de S02/S03/S04 en `.sprint/`. Cliente: `frontend/src/api/{httpClient,authApi,sessionBoundary}.ts`, `frontend/src/types/auth.ts`. Navegación actual: SIN react-router, ruteo a mano con query string (`frontend/src/lib/workspaceLocation.ts`, `App.tsx`); no añadir react-router salvo justificación fuerte documentada.

## Umbrales de calidad
Defaults del sistema para UI: accesibilidad axe sin violaciones serious/critical en las pantallas nuevas; sin errores de consola; layouts 360/768/1280/1920 px sin roturas. Lighthouse solo si es viable en local (se declara si no). `npm test` y `npm run build` verdes; `dotnet test` verde si se toca el backend.

## Ambigüedades detectadas
Ninguna que impida empezar. Supuestos: tras `register` (202 uniforme, sin sesión y sin email hasta S08) la UI invita a iniciar sesión sin afirmar que se envió un correo; no hay «recordarme» obligatorio (checkbox opcional que envía `rememberMe`); texto en español (como el resto de la app); «futuras páginas de cuenta» (perfil) = S07, aquí solo el contenedor protegido/menú.
