# IMPL.md — M3.1-S07 · Perfil y configuración básica de cuenta

Informe del implementador (backend + frontend), revisado y re-verificado por el orquestador. Spec: `spec.md`. Diseño: `DESIGN.md`. Documentación: `docs/AUTH_AUTHORIZATION.md` (§7 perfil, §8 pendiente de decisión P11).

## Resumen
`GET /api/v1/me` y `PATCH /api/v1/me`: el perfil (`id`, `email` de SOLO lectura, `displayName`, `createdAt`, `managedFields: ["email"]`) se resuelve solo desde `IUserContext`; `PATCH` acepta únicamente `displayName` (recortado, 1–80 caracteres UTF-16, sin caracteres de control; `invalid_display_name`); el resto de campos del cuerpo se ignoran; `Cache-Control: no-store`; sin filtrar provider/subject/hash/stamp.
Frontend: pantalla «Mi cuenta» en `?view=account` (ruta protegida con `AuthBoundary`/`AccountLayout` de S05, sin que las pantallas de producto importen auth), ítem «Mi cuenta» en el menú de usuario (en Development el nombre pasa a ser un enlace), formulario con validación al enviar, guardado, errores que conservan lo escrito y actualización del nombre del menú sin volver a pedir `/auth/me` (`updateDisplayName`). Sin dependencias nuevas, sin migración (el límite de 80 se aplica en la aplicación).

## Archivos
Backend nuevos: `Contracts/ProfileContracts.cs`, `Users/DisplayNameRules.cs`, `Endpoints/ProfileEndpoints.cs`; modificados: `Program.cs` (`MapProfileEndpoints`), `AuthEndpoints.cs` (comentario).
Tests backend: `EndToEnd/ProfileEndpointsTests.cs` (40), `ProfileDevelopmentModeTests.cs` (4), 2 tests `Profile_*` en `MultiUserIsolationTests`, `TestSupport/EndpointAuthorizationAudit.cs` (las 2 rutas entran en la lista de rutas sin recurso ajeno, con justificación).
Frontend nuevos: `types/profile.ts`, `api/profileApi.ts`, `auth/ProfileScreen.tsx`, `auth/ProfileForm.tsx`, tests `ProfileScreen.test.tsx` (57) y `UserMenu.account.test.tsx` (10); modificados: `AppRoot.tsx`, `auth/{AccountLayout,UserMenu,AuthUi,AuthProvider,authContext,authLocation,authCopy,validation}`, `auth.css`, `authTestSupport.ts`. Tests ajustados sin debilitar: `UserMenu.test.tsx` (ahora 3 menuitems y foco en «Mi cuenta», el cambio pedido por el DESIGN).

## Resultados (re-ejecutados por el orquestador)
- `dotnet test Vectorify.sln`: **2014/2014** (1967 + 47 nuevos), 15 min 39 s. Frontend `npm test`: **3523/3523** (149 archivos; 3454 + 69 nuevos). `npm run build`: correcto (JS +2956 B gzip, CSS +464 B gzip).
- Recorrido real en el navegador integrado sobre pila aislada `vectorify-s07` en modo Authenticated (SPA `:27173`, API `:27080`; ya desmontada): `?view=account` sin sesión ⇒ login con `returnUrl` ⇒ tras entrar vuelve a «Mi cuenta»; la pantalla muestra nombre editable, correo como texto con la explicación y fecha de alta; nombre en blanco ⇒ «Escribí un nombre para mostrar.»; guardar «Ana Gómez ✨» ⇒ `/api/v1/me` 200 con el nombre nuevo, el menú lo muestra y sobrevive a recargar; `GET /me` solo devuelve `id, email, displayName, createdAt, managedFields` con `no-store`; `PATCH` con `email`, `id`, `provider`, `subject` en el cuerpo ⇒ 200 y ni el correo ni el id cambian; sin cabecera CSRF ⇒ 403; 81 caracteres ⇒ 400; menú con tres ítems (Mi cuenta como enlace real `/?view=account` con el foco al abrir, Salir, Cerrar sesión en todos lados); a 375 px sin desbordamiento, input a 16 px, un solo h1.

## Supuestos y desviaciones del DESIGN
1. Campos ajenos en el PATCH: se ignoran. Cuerpo sin `displayName` (`{}`, `null`, solo `id`/`email`) ⇒ 400 `invalid_display_name`; JSON mal formado ⇒ 400 genérico del framework.
2. `/auth/me` en Development ya leía `Users.DisplayName` (desde S05): no hizo falta cambio; los tests nuevos prueban edición, recarga y reinicio de la API.
3. Desviación del DESIGN (aviso de trabajo sin guardar): navegar a «Mi cuenta» desmonta Editor y Workspace; antes de navegar, `confirmLeaveIfUnsaved` dispara un `beforeunload` sintético cancelable (que ya registran el Editor y `useWorkspaceSave` con cambios sin guardar) y, si alguien lo cancela, pide `window.confirm`. Truco pragmático, no toca código de producto ni el test de arquitectura; se puede quitar.
4. `AppRoot` pone `key` en cada `ArrivalFocus` para que el foco llegue al h2 al volver a Mis proyectos.
5. Sin cambio de email ni de contraseña (S08), sin avatar ni locale/preferencias, y SIN supresión ni exportación de cuenta: decisión humana P11 pendiente; solo documentación con el diseño propuesto en `docs/AUTH_AUTHORIZATION.md` §8.

## No verificado
- axe, Lighthouse, 360/768/1920 px, zoom 200 %, contraste real y recorrido solo con teclado en navegador real (el recorrido manual usó el navegador integrado: consultas DOM y fetch; las capturas de pantalla fallaron por timeout de render, así que no hay revisión visual de la pantalla). Un objetivo táctil del botón del menú de usuario mide 32 px de alto en móvil (preexistente de S05; el DESIGN pedía 44 px en el nuevo botón de guardar, que mide 44).
- El aviso de trabajo sin guardar con el Editor/Workspace real; E2E de `tests/e2e`; la guarda de varias pestañas.
- Flake preexistente visto por el implementador: `LoginScreen.test`/`RegisterScreen.test` fallaron una vez en `document.title` en una corrida paralela de `src/auth`; pasaron en las siguientes y en la completa.
