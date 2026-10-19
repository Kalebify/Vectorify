# Ciclo de vida de la sesión (M3.1-S04)

Complementa a `docs/ADR_AUTH_MVP31.md` (D3 punto 7, T1/T2/T9/T15). Describe **lo que está implementado**, con sus valores por defecto,
qué ocurre en cada caso límite y **qué no está verificado**. La implementación está en `Users/SessionCookie.cs`, `Users/AuthRegistration.cs`,
`Endpoints/AuthEndpoints.cs` y `Options/AuthOptions*.cs` (backend) y `frontend/src/api/sessionBoundary.ts` (frontend).

## 1. Modelo: cookie, no tokens

- La sesión es **una cookie HttpOnly** con un *ticket* cifrado por ASP.NET Core Data Protection (Identity + cookie, ADR D1). El navegador no ve ni guarda ningún token:
  **nada en `localStorage`/`sessionStorage`**, ni en memoria de la SPA (el frontend solo conserva en memoria si ya avisó de la caducidad; ver §8).
- **No hay refresh tokens.** «Renovar» significa que **el servidor reemite la cookie** (renovación deslizante, §3) cuando la usa. No existe un endpoint de refresco ni una petición de refresco concurrente que serializar.
- **Issuer / audience / firma** (la tarjeta los menciona «cuando aplique»): no aplican a una cookie de Identity. La integridad y la confidencialidad del ticket las da Data Protection (cifrado autenticado con el key ring, §6); un ticket alterado no se descifra ⇒ 401.
- Atributos (siempre): `HttpOnly`, `SameSite=Lax`, `Path=/`, sin `Domain`; `Secure` según `Auth__Cookie__SecurePolicy` (`Always` fuera de desarrollo; el validador de arranque lo exige) y nombre `__Host-vectorify.session` por defecto (el prefijo exige `Secure`).
  CSRF: cabecera `X-Vectorify-Request` + `Origin` permitido en todo método no seguro (S03); `logout` y `logout-all` también.

## 2. Valores por defecto (todo configurable, validado al arrancar)

| Variable de entorno | Default | Qué controla |
|---|---|---|
| `Auth__Cookie__Lifetime` | `08:00:00` | **Inactividad máxima** de una sesión normal (deslizante). |
| `Auth__Cookie__RememberMeLifetime` | `30.00:00:00` | **Tope absoluto** de «recordarme», contado desde el login. Máx. 400 días (tope que los navegadores respetan) y ≥ `Lifetime`. |
| `Auth__Session__RevalidationInterval` | `00:05:00` | Cada cuánto se revalida el `SecurityStamp` contra la base = **ventana máxima de revocación** (§5). `00:00:00` = en cada request. Máx. `Lifetime`. |
| `Auth__Session__ClockSkew` | `00:00:30` | Desfase de reloj tolerado entre instancias (§5). 0 a 5 min. |
| `Auth__DataProtection__KeysPath` | *(vacío)* | Directorio del key ring (§6). **Obligatorio fuera de Development/Testing/Test.** |
| `Auth__Cookie__Name`, `Auth__Cookie__SecurePolicy` | ver ADR | Sin cambios respecto a S02/S03. |

Un valor inválido (negativo, `RememberMeLifetime` < `Lifetime`, intervalo > `Lifetime`, ruta relativa o no escribible…) **impide el arranque** con un `OptionsValidationException` que nombra la variable (`AuthOptionsValidator`).
`docker-compose.yml` expone los cuatro tiempos como `AUTH_COOKIE_LIFETIME`, `AUTH_COOKIE_REMEMBER_ME_LIFETIME`, `AUTH_SESSION_REVALIDATION_INTERVAL` y `AUTH_SESSION_CLOCK_SKEW`.

## 3. Expiración y renovación

**Sesión normal** (login sin `rememberMe`, o `rememberMe: false`/ausente/`null`):
- Cookie **de sesión del navegador** (sin `Expires` ni `Max-Age`): el navegador la descarta al cerrarse (según el navegador: algunos restauran sesiones al reabrir, §9).
- El ticket caduca a las 8 h **de inactividad**. Es deslizante: cuando el servidor revalida el `SecurityStamp` (cada 5 min de uso) o pasa de la mitad de la ventana, reemite el ticket con otras 8 h desde ese momento.
  Mientras haya uso, la sesión no caduca **sin tope absoluto** (límite conocido, §9).

**«Recordarme»** (`POST /api/v1/auth/login` con `"rememberMe": true`; campo opcional, ausente = `false`; un valor no booleano ⇒ 400):
- Cookie **persistente** con `Expires` y `Max-Age` = `RememberMeLifetime` (30 días). `Max-Age` va en el login para no depender del reloj del navegador.
- **Tope absoluto**: el instante límite viaja *dentro* del ticket cifrado (`vectorify.session.absolute-expiry`); ni el uso ni la revalidación del `SecurityStamp` lo prolongan. Cada vez que el validador reemite la cookie se acota a ese instante.
  Esta acotación es necesaria: Identity reemite el ticket en cada revalidación con otra vida completa, así que sin ella el «tope» se renovaría cada 5 min. Pasado el tope ⇒ 401 aunque la cookie se haya usado un minuto antes.
- **No hay caducidad por inactividad** dentro de los 30 días: es lo que se espera de «recordarme». El ticket no se puede alargar desde el cliente (no hay dato en claro que adelantar; editar la cookie la invalida).
- La cookie reemitida en una revalidación lleva `Expires` (el mismo tope) pero **no** `Max-Age`; el navegador ya tenía el `Max-Age` del login y el tope no cambia.

Sin «refresh» explícito: la SPA no hace nada para renovar; basta con seguir usando la API.

## 4. Qué pasa en cada caso

| Situación | Resultado | Notas |
|---|---|---|
| Sin cookie | 401 `unauthenticated` en endpoints protegidos; `GET /auth/me` ⇒ 401 | `me` ⇒ 401 es el estado normal «no hay sesión», no una caducidad. |
| Cookie caducada (inactividad o tope absoluto) | 401 | El servidor no reemite cookie. La SPA ve el 401 (§8). |
| Cookie manipulada, truncada o de otro key ring | 401 | No se descifra: no hay forma de saber «quién es». Probado con varias alteraciones. |
| `logout` | 204; borra la cookie de este navegador y **rota el `SecurityStamp`** | Idempotente y tolerante a anónimo. Decisión de S03: cerrar sesión en un sitio la cierra en todos (con la ventana de §5). |
| `logout-all` (`POST /api/v1/auth/logout-all`) | 204; rota el `SecurityStamp` de **la cuenta autenticada** y borra la cookie | **Exige sesión** (401 sin ella), mismo CSRF. Si la rotación falla: cookie borrada y 503 `logout_incomplete` (reintentar). Nada del cliente decide qué cuenta se rota. |
| Cambio / reset de contraseña (S08) | Rota el `SecurityStamp` (ADR T15) | `reset-password` y `change-password` usan `ResetPasswordAsync`/`ChangePasswordAsync`, que rotan el stamp: toda cookie anterior deja de valer al revalidarse (misma ventana de §5). `change-password` **re-emite la cookie de la sesión actual** con el stamp nuevo (conserva el tope absoluto de «recordarme»); `reset-password` además limpia el bloqueo. Probado en `AuthRecoveryEndpointsTests`. Ver `docs/AUTH_RECOVERY.md`. |
| Cuenta bloqueada por intentos fallidos | No revoca sesiones abiertas | El bloqueo (S03) impide *nuevos* logins. |
| Reinicio del backend | **Las sesiones sobreviven** si el key ring está en un volumen (§6) | Verificado con dos hosts sobre el mismo directorio; con claves distintas la sesión se pierde (control). |
| Pérdida del key ring | Todas las sesiones dejan de valer (401) | Las personas vuelven a iniciar sesión; no se pierden datos. Desde S08 también invalida enlaces de recuperación emitidos. |

## 5. Revalidación del `SecurityStamp`, revocación y desfase de reloj

- Cada `Auth__Session__RevalidationInterval` (5 min) el servidor compara el `SecurityStamp` del ticket con el de la base. Si no coincide (logout, `logout-all`, cambio de contraseña…) rechaza la cookie ⇒ 401. Mientras no pase el intervalo **no consulta la base** (rendimiento).
- **Ventana de revocación = como máximo `RevalidationInterval` + `ClockSkew`** desde la emisión/última revalidación de *cada copia* de la cookie. Una cookie robada **sigue funcionando hasta ese límite** después de que la víctima cierre sesión. Es la consecuencia de no consultar la base en cada request. Para cerrarla del todo,
  poner `Auth__Session__RevalidationInterval=00:00:00` (una consulta por request a la tabla de usuarios de Identity; coste no medido). Con la copia robada dentro de la ventana, la sesión está **viva**: esto no se puede cerrar sin consultar la base o sin un almacén de sesiones en servidor (`ITicketStore`, no evaluado).
- **Desfase de reloj** (varias instancias, NTP mal ajustado): el validador de Identity decide si toca revalidar con `ahora - IssuedUtc > intervalo`. Un ticket emitido por una instancia con el reloj *adelantado* daría un valor negativo y **no se revalidaría hasta que el reloj local lo alcanzara** (horas): el desfase alargaría la ventana de revocación.
  `SessionCookie.ValidatePrincipalAsync` lo acota: un ticket «emitido en el futuro» más allá de `ClockSkew` (30 s) **se revalida en esa misma request**. Dentro de la tolerancia rige el intervalo normal. Un reloj *atrasado* en el validador solo hace revalidar antes (inocuo). La caducidad del ticket (`ExpiresUtc`) se compara con el reloj de quien valida, sin tolerancia adicional.
  Con una sola instancia no hay desfase entre emisor y validador. El reloj del *navegador* solo afecta a `Expires` de la cookie persistente; por eso el login añade `Max-Age`.
- Todo usa un único `TimeProvider` del host (`TimeProvider.System` en producción), que es lo que permite probar expiración y renovación con un reloj controlado.

## 6. Data Protection: key ring persistente

- Qué cifra: la cookie de sesión (y, desde S08, los tokens de recuperación/verificación). **Es un secreto**: quien lea el key ring puede forjar cookies de cualquier cuenta.
- Dónde: `Auth__DataProtection__KeysPath` (ruta absoluta de un directorio escribible). En `docker-compose.yml` es `/var/lib/vectorify/dataprotection-keys`, un **volumen nombrado propio** (`vectorify_dataprotection_keys`), separado de `App_Data` y de Postgres.
  El nombre de aplicación de Data Protection es fijo (`Vectorify`): cambiarlo en código invalidaría todas las sesiones.
- **Decisión sobre «sin ruta persistente»**: **fuera de `Development`/`Testing`/`Test` el arranque FALLA** (no solo avisa) si falta `KeysPath`, no es absoluta o no se puede escribir. Razón: un aviso en el log se ignora hasta que un reinicio ya deslogueó a todo el mundo.
  En Development/Testing/Test sin ruta se usa el default de ASP.NET (perfil del usuario del SO, **fuera del repositorio**); ahí no se garantiza nada entre máquinas ni contenedores. El compose (que corre en Development por defecto) sí fija la ruta y el volumen.
- Sin claves en el repositorio ni en la imagen: el directorio nace vacío en el volumen y las claves las genera la API en el primer uso. `.gitignore` no necesita reglas nuevas porque el key ring no vive en el árbol del repo.
- **Rotación**: Data Protection genera una clave nueva automáticamente (por defecto cada 90 días) y **conserva las anteriores** para descifrar lo ya emitido; basta con que el directorio persista. No hace falta tocar nada para rotar, salvo no borrar las claves viejas mientras haya cookies que dependan de ellas (la cookie más longeva dura 30 días, menos que la vida de una clave).
  **Rotación forzada** (sospecha de filtración): parar el backend, vaciar el volumen y arrancar ⇒ se crea un key ring nuevo y **todas las sesiones caducan** (aceptable y deseable en ese caso). Rotar el `SecurityStamp` de todos los usuarios es la alternativa sin tocar el key ring (SQL sobre `auth."AspNetUsers"`; no automatizado).
- **Respaldo**: `scripts/backup.*` y `restore.*` **no** incluyen este volumen (solo Postgres y `App_Data`). Es deliberado: son datos secretos con otra política. Si se quiere sobrevivir a la pérdida del volumen, respaldar `vectorify_dataprotection_keys`
  por separado, cifrado y con acceso restringido (p. ej. `docker run --rm -v <proyecto>_vectorify_dataprotection_keys:/k:ro alpine tar czf - -C /k .`). Restaurar el volumen *sin* el backup de la base no causa problemas; restaurar la base sin el volumen solo cuesta que la gente vuelva a iniciar sesión.
- **Límite conocido**: las claves se guardan en XML **sin cifrar en reposo** (no hay certificado ni DPAPI en Linux; ASP.NET lo advierte en el log). La protección es el control de acceso al volumen. Cifrarlas (`ProtectKeysWithCertificate`) exige gestionar un certificado: queda para S09/operación.
- Varias instancias del backend pueden compartir el mismo directorio (probado con dos hosts a la vez); en un clúster hace falta un almacenamiento compartido real (no probado).

## 7. API

| Método y ruta | Auth | Cuerpo | Respuesta |
|---|---|---|---|
| `POST /api/v1/auth/login` | anónimo | `{email, password, rememberMe?}` | 200 `CurrentUserResponse` + `Set-Cookie`; 401 uniforme; 400 si `rememberMe` no es booleano |
| `POST /api/v1/auth/logout` | opcional | — | 204 (rota el stamp si había sesión) / 503 `logout_incomplete` |
| `POST /api/v1/auth/logout-all` | **sesión** | — | 204 / 401 / 503 `logout_incomplete` |
| `GET /api/v1/auth/me` | sesión (en modo Development, anónimo) | — | 200 `CurrentUserResponse` (incluye `authMode`) / 401 |
| `POST /api/v1/auth/change-password` (S08) | **sesión** | `{currentPassword, newPassword}` | 204 + cookie re-emitida / 400 `invalid_current_password` (NUNCA 401) o `weak_password` / 401 sin sesión |
| `forgot-password`, `reset-password`, `confirm-email`, `resend-confirmation` (S08) | anónimo | ver `docs/AUTH_RECOVERY.md` | 202 uniforme / 204 / 400 genérico / 429 |

**`/me` en modo Development (M3.1-S05).** Con `Auth:Mode=Development` no hay login: `/me` es anónimo y devuelve SIEMPRE el usuario de `IUserContext` (el usuario de desarrollo, dueño real de los datos en ese modo) con `authMode="Development"`, ignorando cualquier cookie.
Así la SPA no queda bloqueada en la pantalla de login en desarrollo y puede ocultar «Salir» y mostrar la pastilla «Modo desarrollo». En modo `Authenticated` nada cambia: 401 sin identidad verificada. `login` también devuelve `authMode`.

## 8. Frontend: frontera de autenticación

`frontend/src/api/sessionBoundary.ts`, usada por `httpClient` (fetch y subidas con XHR):
- Ante un **401 de un endpoint que NO es de auth** (`/api/v1/auth/*` queda excluido: login, register, me, logout, logout-all) se notifica **una sola vez** «sesión expirada» a los suscriptores de `onSessionExpired(handler)` (devuelve la función de baja).
  N requests concurrentes con 401 ⇒ **un único evento**. El error 401 se propaga igual a quien hizo la request: **no hay reintento automático ni bucles**.
- El aviso se vuelve a armar (`rearmSessionBoundary`) tras un **login correcto** o un `GET /auth/me` con usuario (sesión nueva o restaurada). Un login fallido no lo rearma.
- `me` ⇒ 401 es el estado normal sin sesión (`getCurrentUser` devuelve `null`) y no emite evento.
- Si nadie está suscrito, un 401 no consume el aviso. Un suscriptor que lance una excepción no impide avisar a los demás.
- Esta frontera no navega por sí sola: la consume el `AuthProvider` de M3.1-S05 (`frontend/src/auth/`), que al recibir el evento pasa a «sin sesión» y lleva a `?view=login&returnUrl=…` con el aviso «Tu sesión terminó». Sin persistencia: el estado vive en memoria y se pierde al recargar (correcto: el servidor es la fuente de verdad).
- **Estados de sesión en React (S05):** `unknown` (no se monta contenido privado: sin flash), `authenticated`, `unauthenticated` y `error`. Un fallo de red o 5xx al consultar `/me` es `error` («No pudimos comprobar tu sesión», con «Reintentar»; no cierra la sesión), nunca `unauthenticated`. 401 ⇒ sesión; 403 ⇒ prohibido/CSRF (no redirige a login).
- **`returnUrl`**: solo ruta y consulta de la propia app (mismo origen), ≤ 2048 caracteres, sin `//`, esquemas, barras invertidas, fragmento ni vistas de login/registro; cualquier otro valor se ignora. Test de arquitectura: las pantallas de producto no importan `auth/` ni gestionan 401.
- `authApi.login` envía `rememberMe` tal cual; `authApi.logoutAll()` llama al endpoint nuevo.

## 9. Límites conocidos y qué NO está verificado

- **Ventana de revocación** de hasta `RevalidationInterval` + `ClockSkew` (5 min 30 s por defecto): una cookie robada sobrevive ese tiempo al logout (§5).
- **Sin tope absoluto para sesiones normales**: la sesión de 8 h se desliza indefinidamente mientras haya uso. Solo «recordarme» tiene tope absoluto. Añadir uno a la sesión normal es posible con el mismo mecanismo (no pedido).
- **«Recordarme» sin inactividad**: una cookie persistente robada vale hasta 30 días o hasta rotar el stamp.
- **El logout de este navegador cierra todos los demás** (rota el stamp). Si se quisiera cerrar solo el actual hay que dejar de rotar en `logout`; decisión de S03 mantenida.
- **No se probó en navegadores reales**: `Secure`/`__Host-`/`SameSite=Lax` sobre `http://localhost`, comportamiento de `Max-Age`/`Expires` por navegador y restauración de sesión del navegador al reabrir. Solo se verificaron las cabeceras `Set-Cookie` y el comportamiento del servidor con `TestServer`.
- **Verificado a mano con un compose aislado** (proyecto `vectorify-s04`, puertos distintos, `AUTH_MODE=Authenticated`): login con `rememberMe` ⇒ cookie con `expires` y `max-age=2591999`; `docker compose restart backend` y la **misma cookie** sigue dando 200 en `/auth/me`; el volumen contiene el key ring. En el mismo experimento, `logout-all` ⇒ 204 pero `/auth/me` con esa cookie seguía dando **200** justo después: es la ventana de §5 (la cookie se revalidó hace segundos), no un fallo.
  Con el compose en modo Development (sin login) los E2E anónimos `mvp3_release_e2e_test.mjs` (10/10) y `full_pipeline_e2e_test.mjs` (6/6) siguen pasando.
- **Recorrido manual de S05** (2026-10-18, navegador integrado de Claude Desktop, compose aislado `vectorify-s05`, `AUTH_MODE=Authenticated`, SPA `:25173` contra API `:25080`): deep link sin sesión ⇒ login con aviso y `returnUrl`; registro ⇒ «Registro recibido» (sin mencionar correo); credenciales erróneas ⇒ mensaje uniforme; login ⇒ vuelta a la app (el deep link, con ids inexistentes, mostró el aviso propio del producto «el proyecto de esta URL ya no existe»); recargar mantiene la sesión; «Salir» ⇒ login con «Cerraste sesión» y Atrás no muestra contenido privado; sesión invalidada en el servidor + una petición de la SPA ⇒ 401 ⇒ login con «Tu sesión terminó»; backend detenido ⇒ «No pudimos comprobar tu sesión / Reintentar» (no login); `returnUrl=//evil.example.com/x` ⇒ ignorado; login a 375 px sin desbordamiento horizontal. Solo Chromium del panel; la consola solo muestra los 401/404 esperados que el navegador registra por sí mismo.
  **No se verificó** en ese recorrido: «Cerrar sesión en todos lados» (diálogo), «Recordarme», registro con correo ya existente, axe/Lighthouse, 360/768/1920 px, zoom 200 %, teclado completo del menú, el Workspace/Editor real con sesión, ni otros navegadores.
- **No se probó** un clúster con almacenamiento compartido, ni cambio de contraseña (no existe aún), ni carga/rendimiento de `RevalidationInterval=0`, ni `docker compose` con `ASPNETCORE_ENVIRONMENT=Production`.
- El rate limiting del login y las cabeceras de seguridad (HSTS, CSP) se implementaron en S09 (`docs/AUTH_SECURITY_REVIEW.md`); el key ring sin cifrar en reposo, ver §6.
- `Auth__Session__ClockSkew` solo acota el desfase *hacia el futuro* de los tickets emitidos; no corrige un reloj del servidor mal ajustado en general.
