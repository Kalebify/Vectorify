# IMPL.md — M3.1-S05 · React Auth State + rutas protegidas

Informe del implementador (frontend + cambio pequeño de backend), revisado y re-verificado por el orquestador. Spec: `spec.md`. Diseño: `DESIGN.md`.

## Resumen
Módulo `frontend/src/auth/`: `AuthProvider`/`useAuth` (estados unknown/authenticated/unauthenticated/error, sin flash de contenido privado), `AuthBoundary` (alias `ProtectedRoute`), pantallas de registro y login, `UserMenu` («Salir», «Cerrar sesión en todos lados» con confirmación), `AccountLayout` (contenedor para futuras páginas de cuenta),
`returnUrl` validado (anti open redirect), clasificación de fallos (401/403/429/5xx/red), integración con `onSessionExpired` (S04). `AppRoot.tsx` es la raíz de composición; `App.tsx` solo recibe el menú por slot (`userMenu`) y no importa auth. Sin dependencias nuevas, sin react-router.
Backend: `GET /api/v1/auth/me` es anónimo y en modo Development devuelve el usuario de desarrollo con `authMode` (la SPA no se bloquea en login); `login` también devuelve `authMode`. En modo Authenticated nada cambia.

## Archivos
Backend: `Endpoints/AuthEndpoints.cs`, `Contracts/AuthContracts.cs` (`AuthMode`), `Vectorify.Api.Tests/EndToEnd/AuthLoginLogoutTests.cs` (test de Development actualizado a la nueva decisión + 1 nuevo).
Frontend nuevo `src/auth/`: `authContext.ts`, `AuthProvider.tsx`, `AuthBoundary.tsx`, `SessionStates.tsx`, `LoginScreen.tsx`, `RegisterScreen.tsx`, `UserMenu.tsx`, `LogoutAllDialog.tsx`, `AccountLayout.tsx`, `AuthUi.tsx`, `returnUrl.ts`, `authLocation.ts`, `authErrors.ts`, `authCopy.ts`, `validation.ts`, `useDocumentTitle.ts`, `auth.css`, `authTestSupport.ts`.
Frontend modificado: `AppRoot.tsx` (nuevo) + `main.tsx`, `App.tsx` (prop `userMenu`), `ProjectsDashboard.tsx` y `EditorShell.tsx`/`EditorHeader.tsx` (prop `accountSlot`), `types/auth.ts`.
Tests: 146 nuevos de frontend (returnUrl, provider, AppRoot integración, login, registro, menú, test de arquitectura `authBoundary.architecture.test.ts`); casos aditivos en `EditorHeader.test.tsx` y `ProjectsDashboard.test.tsx`. Ningún test existente se debilitó.
Docs: `docs/AUTH_SESSION_LIFECYCLE.md` (decisión de `/me`, estados de sesión, `returnUrl`, recorrido manual).

## Resultados (re-ejecutados por el orquestador)
- `dotnet test Vectorify.sln`: **1927/1927** (1926 + 1 nuevo), 15 min 55 s. Implementador: una corrida con 6 timeouts sin relación (pasan solos 8/8), que en la mía no se repitieron.
- Frontend `npm test`: 3453/3454 en mi corrida completa; el único fallo, `ManufacturingOperations.test.tsx` («marcar una capa como Ignorar…»), es un archivo NO tocado por S05 y pasa 5/5 las 3 veces que lo reejecuté solo (flake sensible al tiempo bajo carga, ya visto en `EditorShell.history.test.tsx` en S03/S04). Implementador: 3454/3454. `npm run build`: correcto (JS gzip +6,95 kB, CSS +1,6 kB).
- Recorrido real en el navegador integrado sobre pila aislada en modo Authenticated: ver `docs/AUTH_SESSION_LIFECYCLE.md` §9 (deep link ⇒ login ⇒ vuelta, registro, error uniforme, recarga, logout + Atrás, sesión expirada, backend caído ⇒ reintento, returnUrl malicioso, 375 px).

## Supuestos y desviaciones del DESIGN
1. `AppRoot` construye el `UserMenu`; `App` recibe `userMenu` por prop (las pantallas de producto y los ~3300 tests de `<App />` no se tocan).
2. Las vistas `?view=login|register` y `returnUrl` viven en `src/auth/authLocation.ts`, sin extender `workspaceLocation.ts`.
3. `returnUrl` válido = misma ruta de la app (solo cambia la consulta), ≤ 2048 caracteres, sin fragmento, ni login/registro; la raíz sola se omite.
4. Con sesión `unknown` la pantalla de login espera a `/me` (no muestra el formulario a quien sí tiene sesión).
5. Copy no definido en DESIGN para errores sin código: «El servidor no pudo responder. Intentá de nuevo en unos minutos.».
6. `ArrivalFocus` mueve el foco al h1/h2 de destino (máx. ~3 s); el Workspace real no tiene `<main>`, así que ahí no se mueve (solo probado con stub).
7. Registro con campo «Repetí la contraseña» (no hay recuperación hasta S08); tras 202 «Registro recibido» sin prometer correo; sin «olvidé mi contraseña».

## No verificado
- axe, Lighthouse, 360/768/1920 px, zoom 200 %, teclado completo del menú en navegador real, otros navegadores: no se corrieron (axe no está en el repo y no se añadió). Verificados con testing-library: roles, nombres accesibles, `aria-*`, landmarks, un único h1, orden de foco, trampa de Tab del diálogo.
- En el recorrido manual no se probaron «Cerrar sesión en todos lados» (diálogo), «Recordarme», el registro con un correo ya existente ni el Workspace/Editor real con sesión; el slot del menú en `EditorShell` solo con stub y tests de `EditorHeader`.
- Ratios de contraste de `auth.css` no recalculados (valores de DESIGN §2.2).
