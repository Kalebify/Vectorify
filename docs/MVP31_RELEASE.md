# MVP 3.1 — Release gate de autenticación y multiusuario (M3.1-S10)

Cierra MVP 3.1 («VECTORiZE puede exponerse a usuarios autenticados sin compartir accidentalmente proyectos entre cuentas»). Formato del gate de `docs/MVP3_RELEASE.md`:
qué se verificó, cómo, cuándo y qué **no**. Complementa a `docs/ADR_AUTH_MVP31.md`, `docs/AUTH_SESSION_LIFECYCLE.md`, `docs/AUTH_AUTHORIZATION.md`, `docs/AUTH_RECOVERY.md` y
`docs/AUTH_SECURITY_REVIEW.md` (S09). Regla de este documento, igual que la de S09: **solo está marcado como verificado lo que se ejecutó** (con su comando y fecha); lo demás está en «Límites conocidos».

## 1. Veredicto

> ## NO LISTO PARA RELEASE
>
> **La suite está verde, pero el release sigue BLOQUEADO** mientras exista un hallazgo High abierto: **H-1 · `SixLabors.ImageSharp` 2.1.13** (3 avisos High + 2 Moderate, corrección solo en la versión
> mayor 4.1.2 y bajo otra licencia). Por decisión del usuario H-1 se mantiene como **bloqueante**; este gate **no lo resuelve** (decisión humana de licencia y de versión).
>
> **Qué lo desbloquea (todo lo siguiente, en este orden):**
> 1. Que la persona dueña del producto **decida** H-1 entre las opciones de `docs/AUTH_SECURITY_REVIEW.md` §5.7: (a) aceptar el riesgo documentado con las mitigaciones ya aplicadas, (b) actualizar a ImageSharp 4.1.x cumpliendo la licencia
>    Six Labors Split License (código abierto, empresa < 1 M USD de ingresos anuales o licencia comercial), (c) sustituir ImageSharp (p. ej. validar y generar miniaturas en el motor Python), (d) aislar la decodificación en un proceso/contenedor con límite de memoria.
> 2. Si se elige (b), (c) o (d): implementarlo en una tarjeta propia y repetir `dotnet test` (en particular `SafeImageDecodingTests`, `AssetEndpointsTests`, `ProjectEndpointsTests`), `dotnet list package --vulnerable --include-transitive` (debe quedar sin High) y la suite E2E de este documento.
> 3. Si se elige (a): que la persona dueña **baje explícitamente** la severidad/bloqueo de H-1 en este documento (solo ella puede, porque el usuario lo fijó como bloqueante) y se registre la aceptación (quién, cuándo, hasta cuándo).
> 4. Cerrar o aceptar por escrito las decisiones de §10 que impiden un despliegue real (proveedor de correo P5 y dominio/certificado TLS); no bloquean la verificación técnica, sí la exposición a usuarios.
>
> Aviso nuevo (H-12): `npm audit` marca 1 High en `vite` 8.3.1, **solo dependencia de desarrollo** (no va en la imagen; `--omit=dev` = 0). No lo tratamos como bloqueante, pero la persona dueña debe confirmarlo; se corrige con `npm audit fix` (§9).
>
> No hay **ningún otro** High/Critical abierto con las reservas de §9 (TLS/dominio reales, otros navegadores, proxy real delante de la API). Esta tarjeta **no encontró ningún defecto nuevo de autenticación/autorización**.

Resumen del estado técnico (2026-10-20, rama `sprint/3e8d77b2-m31-s10-e2e-release-gate`):

| Área | Resultado |
|---|---|
| E2E HTTP multiusuario contra `docker compose` real (9 escenarios + cookie manipulada + CSRF) | **11/11 OK**, 204 comprobaciones (§4) |
| Recorrido en navegador real (Chrome 155, dos perfiles A y B) | **12/12 pasos OK**, 0 violaciones de CSP, 0 errores de consola inesperados (§5) |
| E2E anónimos existentes en Development | `mvp3_release` 10/10, `full_pipeline` 6/6, `upload` OK (§6) |
| Los mismos E2E en Authenticated con `E2E_AUTH=1` | 10/10, 6/6, OK (§6) |
| Imagen real del backend: Production + Authenticated por defecto; Production + `Auth__Mode=Development` no arranca | Verificado con la imagen construida (§7) |
| Herramienta de reasignación de datos legados | Probada en pila aislada: dry-run, `--apply`, A los ve (v2 y clásicos), B no; idempotente (§8) |
| `dotnet test Vectorify.sln` | **2224/2224 OK** (0 fallos, 0 omitidas; 24 min; 2026-10-20): 2218 previas + 6 de la herramienta de reasignación |
| `npm test` / `npm run build` | **3732/3732 OK** (158 archivos) / build OK (solo el aviso habitual de tamaño de chunk); 2026-10-20 |
| `npm audit` | `--omit=dev` = 0; completo = **1 High nuevo en `vite` (H-12, solo desarrollo, no bloquea)** |
| H-1 ImageSharp (High) | **ABIERTO — BLOQUEA RELEASE** |

## 2. Cómo se verificó (entorno)

- **Pila de prueba:** `docker compose -p vectorify-s10` (puertos 32xxx; **nunca** el proyecto `vectify` del usuario en 5080/5173/5432), construida desde el repositorio con `tests/e2e/mvp31_stack.sh up`: Postgres 17, motor Python real,
  Web API (imagen `backend/Dockerfile`, `ASPNETCORE_ENVIRONMENT=Development` + `Auth__Mode=Authenticated`), nginx real con la CSP de S09 y Mailpit (perfil `mail-sink`, SMTP real sin TLS). Bajada con `down -v --rmi local`;
  `tests/e2e/mvp31_stack.sh leftovers` quedó vacío (ningún contenedor, volumen, red ni imagen `vectorify-s10-*` del proyecto).
- **Tiempos de sesión de la pila de prueba (intervalo de revalidación usado: 3 s):** `Auth__Cookie__Lifetime=00:00:20`, `Auth__Cookie__RememberMeLifetime=00:00:45`, **`Auth__Session__RevalidationInterval=00:00:03`**, `Auth__Session__ClockSkew=00:00:05`.
  Los límites de login/registro por IP/dirección se subieron a 100000 en esa pila (el E2E registra decenas de cuentas desde una IP; los límites reales los prueban `AuthLoginRegisterRateLimitTests` y `AuthRecoveryRateLimitTests` dentro de `dotnet test`).
- **Navegador:** Chrome 155.0.8059.84 headless por DevTools (`tests/e2e/lib/cdp.mjs`, sin dependencias), dos instancias con perfil temporal propio (A y B) = dos contextos con cookies separadas. Node 24, Docker 29.
- **Cuentas:** cada ejecución registra cuentas con correo `…-<hora>-<aleatorio>@vectorify.test`: la suite se puede repetir sobre la misma pila.

## 3. Matriz de verificación

| Qué | Cómo | Cuándo / dónde | Resultado |
|---|---|---|---|
| Registro, login, cookie (HttpOnly, SameSite=Lax, Path=/, sin Domain, de sesión), respuestas uniformes (registro repetido, login de cuenta inexistente) | Escenario 1 | 2026-10-20, pila `vectorify-s10` | OK |
| Crear y editar un proyecto real (flujo clásico + `workspaces/save` + `editor-save` + PATCH de proyecto y capa) | Escenario 2 | ídem | OK |
| Logout + login y recuperación byte a byte (proyecto, documento, versiones, SVG de capa, export clásico, metadata clásica, listado) | Escenario 3 | ídem | OK |
| Aislamiento A/B: listado, búsqueda (incl. comodines), detalle | Escenarios 4 y 5 | ídem | OK |
| Aislamiento sobre **59 rutas** (flujo clásico: 43 del grupo central; v2: detalle, PATCH, DELETE, duplicar, subir/descargar/borrar asset, miniatura, documento, versiones, versión *n*, restaurar, editor-save, capa, `workspaces/save`) con ids reales de A: B recibe 404 **byte a byte igual** (estado, cabeceras y cuerpo) que con ids inexistentes; el anónimo 401 `unauthenticated`; control positivo (el dueño obtiene 2xx en 23 de las 25 rutas GET); descargas por URL directa (SVG de capa, miniatura, original, export); estado de A idéntico al final | Escenario 6 | ídem | OK |
| Cookie manipulada (7 alteraciones × 3 rutas, otro nombre, `Authorization: Bearer`, query, ids en cabeceras) | Escenario 6b | ídem | OK: siempre 401 |
| CSRF negativo (sin cabecera, `Origin` ajeno, sin `Origin`, otro puerto) × 5 operaciones no seguras | Escenario 6c | ídem | OK: 403 `csrf_rejected` sin efecto |
| Caducidad por inactividad, renovación deslizante (cookie reemitida), «recordarme» con tope absoluto | Escenario 7 (3 subpruebas en paralelo, ≈ 48 s) | ídem | OK |
| Logout efectivo (cookie copiada, otro dispositivo), `logout-all`, idempotencia, CSRF del logout, ventana de revocación | Escenario 8 | ídem | OK |
| Recuperación: confirmación de correo, olvidé, correo en Mailpit, restablecer, enlace reusado, sesiones previas invalidadas, bloqueo limpiado, cambio de contraseña | Escenario 9 | ídem | OK |
| Navegador real: registro/login → proyectos → editor → Mi cuenta → logout; B no ve el proyecto; deep link ajeno; sesión invalidada → login con aviso; CSP y consola | `mvp31_auth_browser_test.mjs` | ídem | OK |
| E2E existentes en Development y con `E2E_AUTH=1` | §6 | ídem | OK |
| Imagen real: defaults y guardarraíles de arranque | §7 | ídem | OK |
| Reasignación de datos legados | §8 | ídem | OK |
| Autorización/seguridad automatizada (UserA/UserB por cada ruta del `EndpointDataSource`, rate limiting, cabeceras, tiempos, logs sin PII...) | `dotnet test` | ver §1 | ver §1 |
| **No verificado** | ver §9 | — | — |

## 4. Resultado de la suite E2E HTTP

`node tests/e2e/mvp31_auth_e2e_test.mjs` contra `http://localhost:32080` (código de salida 0; sale ≠ 0 si cualquier escenario falla; los dependientes de uno que falla se marcan «OMITIDO»):

| # | Escenario de la tarjeta | Resultado | Evidencia clave |
|---|---|---|---|
| 1 | Registrar User A | OK | 202 uniforme (nuevo y repetido, mismo cuerpo); contraseña corta y correo inválido 400; login erróneo = inexistente (mismo cuerpo 401); cookie `HttpOnly; SameSite=Lax; Path=/`, sin `Domain`, sin `Expires`/`Max-Age`; correo de confirmación recibido en Mailpit |
| 2 | Crear Project A y editarlo | OK | upload → … → paleta → capas → `workspaces/save` → `editor-save` (versión 2) + PATCH proyecto/capa (versión final 3) |
| 3 | Logout/Login y recuperar Project A | OK | tras el logout 401 y cookie borrada; tras volver a entrar, 7 vistas del proyecto idénticas byte a byte; el login emite una cookie nueva |
| 4 | Registrar User B | OK | usuario interno y cookie distintos de los de A |
| 5 | B no ve Project A | OK | listado vacío; 6 búsquedas (incl. `%`, `_`) sin el proyecto; detalle 404 con el cuerpo de un id inexistente |
| 6 | Acceso directo a ids/assets/versiones de A → denegado | OK | 59 rutas: 404 idéntico al de un id inexistente; anónimo 401; descargas por URL directa dueño 200 / otro 404 / anónimo 401; un asset de A bajo un proyecto de B también 404; estado de A intacto; ningún duplicado |
| 6b | Cookie manipulada | OK | 401 en todas las variantes |
| 6c | CSRF negativo | OK | 403 `csrf_rejected` (4 variantes × 5 operaciones), GET permitido, sin efecto |
| 7 | Session expiry/renewal | OK | inactiva 23 s → 401 (Lifetime 20 s); uso cada ~7 s durante 33 s → siempre 200 con 5 cookies reemitidas; «recordarme»: `Max-Age` 44 s, viva tras 23 s sin uso, usada a los 40 s (200) y **401 a los 48 s** (tope absoluto de 45 s no prolongable) |
| 8 | Logout efectivo | OK | cookie copiada antes del logout → 401 a los 11 ms; el otro dispositivo de la cuenta 401; `logout-all` cierra 2 dispositivos (401), no afecta a otra cuenta; sin sesión 401, sin cabecera anti-CSRF 403; logout anónimo/basura 204 |
| 9 | Recovery flow | OK | confirmación de correo (reuso 400 `invalid_token`); olvidé: 202 idéntico exista o no la cuenta, solo la existente recibe correo (token en el **fragmento**); token inválido 400, débil 400, OK 204, reuso 400; la contraseña vieja 401, la nueva 200, bloqueo limpiado; sesión previa → 401; `change-password` (400 `invalid_current_password`, 204 con cookie reemitida, otro dispositivo → 401) |

Tiempo total ≈ 70 s (de los cuales ≈ 48 s son las esperas reales del escenario 7).

**Ventana de revocación (intervalo de revalidación usado: 3 s).** Una cookie con más de 3 s de vida se revalida contra la base en su siguiente petición: tras `logout`/`logout-all`/cambio o restablecimiento de contraseña su siguiente uso da 401 (observado: 4–418 ms). Una cookie emitida
**hace menos de 3 s** no se revalida y respondió **200** tras el logout de otro dispositivo (control del escenario 8, informativo) y cayó a los 3 s de emitirse: es exactamente la ventana de `docs/AUTH_SESSION_LIFECYCLE.md` §5 (`RevalidationInterval` + `ClockSkew`, 5 min 30 s por defecto en producción). Con `Auth__Session__RevalidationInterval=00:00:00` se cierra del todo a cambio de una consulta por request (coste no medido).

Qué no demuestra: los límites de frecuencia no se ejercen en esta pila (se subieron a propósito); el tiempo de respuesta frente a enumeración se midió en S09 (`auth_timing_probe.mjs`) y no se repitió.

## 5. Recorrido en navegador real

`node tests/e2e/mvp31_auth_browser_test.mjs` (SPA `http://localhost:32173` servida por nginx, API `:32080`), dos Chrome con perfil propio:

| Paso | Resultado |
|---|---|
| A · 1 Pantalla de inicio de sesión (anónimo) | OK |
| A · 2 Registro por la interfaz («Registro recibido») | OK |
| A · (preparación por HTTP: login por API y proyecto real del dataset guardado) | OK |
| A · 3 Login → «Mis proyectos» con su proyecto y miniatura cargada desde la API (`img-src`) | OK |
| A · 4 Abrir el proyecto en el editor (capas por `fetch` con cookie + `<canvas>`) | OK |
| A · 5 «Mi cuenta» | OK |
| A · 6 «Salir» → login con «Cerraste sesión»; «Atrás» no muestra lo privado | OK |
| B · 7 Registro por la interfaz | OK |
| B · 8 Login: «Mis proyectos» sin el proyecto de A (estado vacío) | OK |
| B · 9 Enlace directo al proyecto de A → «El proyecto de esta URL ya no existe», sin canvas ni contenido | OK |
| A · 10 Vuelve a entrar | OK |
| A · 11 Sesión invalidada desde otro dispositivo (`logout-all`) + una petición de la SPA → login con «Tu sesión terminó» | OK |

**Violaciones de CSP: 0** (evento `securitypolicyviolation`, log del navegador y consola). **Errores de consola: 8, todos esperados** (7 × 401 del navegador: `/auth/me` anónimo y la sesión invalidada; 1 × 404 del enlace directo ajeno); **inesperados: 0**.
El criterio «0 errores de consola salvo los 401 esperados» se cumple con **una salvedad declarada**: el 404 del enlace directo ajeno (la API responde 404 a un proyecto ajeno, y el navegador lo registra por sí mismo) se acepta solo en ese paso.
Limitaciones: Chrome headless únicamente (Firefox/Safari/Edge no probados), 1366×900, un proyecto de dataset, sin recorrer herramientas de dibujo del editor, sin TLS (cookie sin `Secure`/`__Host-`), el registro/login de B no pasa por correo de confirmación (`RequireConfirmedEmail=false`).

## 6. Compatibilidad de los E2E existentes

| Script | Development (sin cambios de comportamiento) | `E2E_AUTH=1` en Authenticated |
|---|---|---|
| `tests/e2e/mvp3_release_e2e_test.mjs` | **10/10** imágenes (pila `vectorify-s10` en Development, 2026-10-20) | **10/10** |
| `tests/e2e/full_pipeline_e2e_test.mjs` | **6/6** fixtures | **6/6** |
| `tests/e2e/upload_e2e_test.mjs` | OK en sus dos modos: API propia en Development (sin `BACKEND_URL`) y contra la pila (`BACKEND_URL`) | OK (`BACKEND_URL` + `E2E_AUTH=1`) |
| `tests/e2e/real_stack_test.py` | **No se ejecutó**: no hay Python en el entorno de esta tarjeta | No aplica (§ abajo) |

Control: `mvp3_release` sin `E2E_AUTH` contra la pila Authenticated falla (403 de la guarda CSRF en el primer `upload`), es decir, la variable hace falta y el cliente anónimo no se cuela.
Cambios a los scripts: una línea `await enableAuthFromEnv(API)` (no-op sin `E2E_AUTH=1`) y, en `upload_e2e_test.mjs`, la lógica pasó a `runChecks(url)` para poder apuntar a una pila ya corriendo; su modo por defecto sigue arrancando su propia API en Development. `real_stack_test.py` no se adapta: arranca sus propios
procesos (FastAPI + Web API en Development, sin Postgres ni Identity) y solo consulta `/health`, `/api/v1/system/health` y CORS, rutas de la lista blanca anónima. Detalle en `tests/README.md`.

## 7. Migración DevelopmentUser: evidencia con la imagen real

Imagen construida por `docker compose -p vectorify-s10` (`backend/Dockerfile`), ejecutada con `docker run` **sin** el compose (2026-10-20). `docker image inspect` → `ASPNETCORE_ENVIRONMENT=Production`, `Auth__Mode=Authenticated`.

| Caso | Resultado literal |
|---|---|
| Sin overrides (`docker run vectorify-s10-backend`) | salida **139**; `Unhandled exception. Microsoft.Extensions.Options.OptionsValidationException: Auth:DataProtection:KeysPath es obligatorio fuera de los entornos de desarrollo: sin un key ring persistente (volumen) cada reinicio invalidaría todas las sesiones.` — arranca en Production + Authenticated y **exige la configuración de producción** |
| Sin overrides + `Auth__DataProtection__KeysPath=/tmp/keys` | arranca (escucha en 8080; Production + Authenticated) |
| Idem + `Postgres__ConnectionString` con `Password=vectorify_dev_password` | salida **139**; `OptionsValidationException: Postgres:ConnectionString usa la contraseña de DESARROLLO publicada en el repositorio (vectorify_dev_password): no se permite fuera de Development/Testing/Test. Defina POSTGRES_PASSWORD…` |
| **`ASPNETCORE_ENVIRONMENT=Production` + `Auth__Mode=Development`** | **NO arranca**: salida **139**; `Unhandled exception. System.InvalidOperationException: Auth:Mode=Development no está permitido en el entorno 'Production': DevelopmentUserContext (identidad fija, sin login) solo puede activarse en los entornos Development, Testing, Test. Fuera de ellos use Auth:Mode=Authenticated (default).` |
| `ASPNETCORE_ENVIRONMENT=Development` / `Testing` / `Test` + `Auth__Mode=Development` | los tres **arrancan** (escuchan en 8080): el usuario de desarrollo sigue disponible; además el compose de desarrollo y los E2E anónimos de §6 corrieron así |

El código de salida es 139 (aborto de .NET por excepción no controlada dentro del contenedor), ≠ 0 y con el mensaje claro; no es un `exit 1` limpio (observación I-2, §8bis). Tests automáticos equivalentes: `UserContextRegistrationTests.Host_InProductionWithDevelopmentMode_*`, `DeploymentDefaultsTests.BackendImage_*`.

## 8. Herramienta de reasignación de datos legados (ADR P10)

**Dónde vive:** `backend/Vectorify.Api/Maintenance/ReassignLegacyDataCommand.cs` (modo del propio ejecutable, `--reassign-legacy-data`, igual que `--check-consistency`; no es un endpoint), envoltorios `scripts/reassign-legacy-data.sh` y `.ps1`, tests `ReassignLegacyDataCommandTests` (6) y comprobación HTTP `tests/e2e/mvp31_legacy_reassign_check.mjs`.
**La decisión de a quién se asignan los datos sigue siendo humana (P10): la herramienta NO se ejecutó sobre el compose `vectify` del usuario ni sobre datos reales; solo sobre la pila aislada `vectorify-s10`.**

Garantías (cada una con test): DRY-RUN por defecto (no escribe nada: ni base, ni JSON, ni copias, ni temporales); `--apply` explícito; destino = correo de una cuenta **existente** con usuario interno (si no, error y no cambia nada; el usuario de desarrollo no puede ser destino); cubre `projects."OwnerId"` del usuario de desarrollo
(`DevelopmentUser:UserId`, por defecto `00000000-0000-0000-0000-000000000001`) de proyectos **no eliminados**, y los sidecars JSON de `ProjectRegistry:RootPath` con `OwnerId` del usuario de desarrollo, `null` o ausente; **nunca** toca registros de otra cuenta, proyectos eliminados, archivos ilegibles ni ningún otro campo (solo se edita `OwnerId`);
idempotente; la base cambia en **una transacción**; los JSON nuevos se preparan como temporales **antes** y solo se mueven a su sitio **después** de confirmar la transacción (si la base falla: salida 2, ningún archivo cambió y los temporales se descartan); antes de modificar cada sidecar deja `…json.pre-reassign.bak`. Salidas: 0 correcto, 1 aplicado a medias (repetir), 2 no se pudo.

Uso (con la pila arriba y las mismas variables de compose exportadas que al levantarla, igual que `scripts/backup.*`):

```bash
scripts/backup.sh -p <proyecto>                                   # 1) COPIA DE SEGURIDAD (obligatoria; el key ring NO va en ella, ver docs/AUTH_SESSION_LIFECYCLE.md §6)
scripts/reassign-legacy-data.sh -p <proyecto> -e persona@ejemplo.com        # 2) DRY-RUN: lista qué cambiaría (la API puede seguir arriba)
scripts/reassign-legacy-data.sh -p <proyecto> -e persona@ejemplo.com -a     # 3) APLICAR: pide confirmar la copia, PARA el backend, corre el comando en un contenedor efímero y lo vuelve a ARRANCAR
```

Se para el backend al aplicar porque guarda los registros clásicos en memoria: si siguiera arriba vería los sidecars con el dueño anterior (y podría reescribirlos). **Rollback:** restaurar la copia (`scripts/restore.*`), o por archivo `mv X.json.pre-reassign.bak X.json` y, para la base,
`UPDATE projects SET "OwnerId" = '00000000-0000-0000-0000-000000000001' WHERE "Id" IN (<ids que listó el dry-run>);` (con la API parada).

**Prueba en pila aislada (2026-10-20)** — flujo exacto pedido:
1. `mvp31_stack.sh up-dev` (Development): se crearon con los E2E anónimos 10 proyectos v2 + 16 registros clásicos (+1 de `upload`), un proyecto v2 manual, uno eliminado; dos sidecars se dejaron **sin dueño** (uno con `"OwnerId": null`, otro con la propiedad ausente, como los anteriores a M2.2-S09).
2. `mvp31_stack.sh stop` (`down` **sin** `-v`: volúmenes conservados) y `mvp31_stack.sh up` en **Authenticated** sobre los mismos volúmenes.
3. `mvp31_legacy_reassign_check.mjs before`: registra A y B; ambos ven 0 proyectos v2 y A recibe 404 en los **17** registros clásicos (huérfanos). Estado de la base: 12 proyectos, todos de `00000000-…-0001`.
4. `scripts/backup.sh -p vectorify-s10` → copia completa (`projects=12 assets=104 document_versions=50 layers=160`).
5. **Dry-run**: `Proyectos v2 … a reasignar: 11` (+ «1 ya ELIMINADO: no se toca»), `Registros clásicos … a reasignar: 17 (sin dueño: 2, del usuario de desarrollo: 15)`, `DRY-RUN: no se modificó nada`. Comprobado: hash del árbol de sidecars y recuento de dueños en la base **idénticos antes y después** del dry-run.
6. **`--apply`**: `Base de datos: 11 proyecto(s) reasignado(s) (transacción confirmada).` / `Registros clásicos: 17 reasignado(s)`; backend parado y vuelto a arrancar por el script.
7. `mvp31_legacy_reassign_check.mjs after`: **A ve los 11 proyectos v2, abre los 17 registros clásicos (200), el documento de los 10 proyectos guardados y el SVG de capa de los 10 con flujo clásico asociado; B ve 0 proyectos y recibe 404 en los 17 registros y en los 10 proyectos.** El proyecto eliminado sigue eliminado y con el dueño de desarrollo; hay 17 copias `.pre-reassign.bak` y 0 temporales.
8. Segunda ejecución: `nada que reasignar` (idempotente).

**Límites / no verificado:** la reasignación entre la base y los archivos no es atómica (por eso el orden y la reejecución idempotente); los sidecars de paleta/capas/vectores no llevan dueño (heredan el del registro clásico); las claves de idempotencia de `document_versions` quedan prefijadas con el dueño anterior (un reintento *antiguo* creará una versión nueva, inofensivo);
no se probó con volúmenes grandes, ni con la API sirviendo tráfico durante el apply (el script la para), ni el envoltorio `.ps1` (solo se verificó que parsea); no cubre «borrar» ni «dejar huérfanos» (las otras alternativas de P10), ni varios destinos a la vez; hace falta que la cuenta destino haya iniciado sesión al menos una vez (si no existe su usuario interno, el comando lo dice).

### 8bis. Hallazgos nuevos de esta tarjeta

Ningún defecto de autenticación/autorización. Observaciones (no bloquean):

| ID | Sev. | Hallazgo |
|---|---|---|
| I-1 | Info | La herramienta de reasignación y los scripts de la pila de prueba dependen de variables de compose exportadas (como `backup.sh`): si faltan, `compose run` usa los defaults (puertos/credenciales de desarrollo) y puede no encontrar la base de otra pila. Documentado en el uso. |
| I-2 | Info | Un fallo de configuración en la imagen sale con código **139** (aborto de .NET) en lugar de `exit 1`; para un orquestador es igualmente «fallo». No se cambió (comportamiento de la plataforma). |
| I-3 | Info | `tests/e2e/mvp31_stack.sh` esperaba la API con `curl` sin tiempo máximo: en Docker Desktop un puerto publicado aún sin servicio detiene `curl` indefinidamente. Corregido (`-m 5` y `127.0.0.1`). Es de las herramientas de prueba, no del producto. |
| I-4 | Info | La imagen escribe `Cannot load library libgssapi_krb5.so.2` en cada arranque (ruido de la imagen base; no afecta). |

## 9. Estado del checklist de seguridad de S09 y de cada hallazgo

Checklist de la tarjeta S09 (`docs/AUTH_SECURITY_REVIEW.md` §2), estado a cierre de S10:

| Ítem | Estado | Evidencia añadida por S10 |
|---|---|---|
| HTTPS en producción | **Parcial por diseño** (TLS/certificado/HSTS reales no verificables sin dominio) | Sin cambios; ver decisiones §10 |
| CORS mínimo | Verificado | El navegador real llamó a la API con credenciales desde otro origen (`:32173` → `:32080`) sin errores de CORS; `Origin` ajeno → 403 (6c) |
| CSP / cabeceras | Verificado en navegador real | **0 violaciones** en 12 pasos con nginx real (navegador, §5) |
| CSRF (cookies) | Verificado | Escenario 6c |
| XSS | Verificado (suites) | Sin cambios |
| Rate limiting | Verificado (suites) | **No** ejercido en el E2E (límites subidos a propósito) |
| Gestión de secretos | Verificado | La imagen rechaza la contraseña de ejemplo fuera de desarrollo (§7) |
| Cookies seguras | Verificado en HTTP | `Secure`/`__Host-` sobre TLS **no** verificados en navegador |
| Higiene de errores / logs sin PII | Verificado (suites) | Sin cambios |
| Fuerza bruta | Verificado | Escenario 9: 6 fallos bloquean la cuenta; el restablecimiento lo limpia |
| Dependencias | Ejecutado en S09 | **H-1 sigue abierto**; repetido en S10: `npm audit --omit=dev` = 0; `npm audit` completo = **1 High nuevo en `vite` 8.3.1 (H-12, solo desarrollo)**. NuGet: los avisos NU1902/NU1903 del build son **solo** ImageSharp 2.1.13 (`dotnet list package --vulnerable` falla con el SDK 10.0.402, «Sequence contains no matching element»; por eso se usó la auditoría del restore/build) |
| Threat review T1–T15 | Ejecutado | T11 (IDOR) re-verificado de punta a punta (escenario 6); T15 (sesión zombi) escenarios 7–9 |

Hallazgos (estado a cierre de S10):

| ID | Sev. | Estado | Nota |
|---|---|---|---|
| **H-1** | **High** | **ABIERTO — BLOQUEA RELEASE** | ImageSharp 2.1.13; decisión humana (§1). Mitigaciones de S09 vigentes (decodificadores PNG/JPEG/WEBP únicamente + tope de píxeles) |
| **H-12** | High (aviso) / sin exposición en producción | **ABIERTO, no bloquea** (decisión tuya) | Nuevo desde S09: `vite` 8.3.0–8.3.2 vía `launch-editor` (ejecución de comandos en Windows con el servidor de desarrollo). Dependencia de **desarrollo**, no va en la imagen; `npm audit --omit=dev` = 0. Corrección: `npm audit fix` (vite 8.3.4, solo `package-lock.json`, como en S09) y repetir `npm test` + `npm run build`. No se aplicó para no cambiar dependencias tras verificar las suites. |
| H-2 | Medium | Corregido, **re-verificado con la imagen real (§7)** | Default Production + Authenticated; Production + Development no arranca |
| H-3 | Medium | Corregido (suites) | Rate limiting de login/registro; no ejercido en el E2E |
| H-4 | Medium | Corregido (suites) | `ForwardedHeaders` seguro; **sin proxy real delante** (no verificado) |
| H-5 | Medium | Corregido (suites) | Path traversal en ids de la URL; el deep link ajeno del E2E usa ids válidos |
| H-6 | Medium | Corregido (suites) | Tiempos del login |
| H-7 | Medium | Corregido, **re-verificado en navegador** | El editor cargó las capas con la cookie (paso 4, `credentials: "include"`) |
| H-8 | Low | Corregido (suites) | Correlation ID |
| H-9 | Medium | Corregido (suites) | Tope de píxeles de subida |
| H-10 | Low | Corregido (suites) | Manejador global y cabeceras de la API |
| H-11 | Low | Corregido (suites) | Puertos en `127.0.0.1` por defecto (`BIND_ADDRESS`) |
| R-1 … R-7 | Low/Info | Aceptados (sin cambios) | R-1 bloqueo como DoS; R-2 límites por instancia; R-3 contenedores como root (**recomendado corregir en el despliegue real**); R-4; R-5; R-6; R-7 `index.lock` |
| I-1 … I-4 | Info | Nuevos de S10 | §8bis |

**Seguimiento recomendado (decisión del usuario, no ejecutado):** el PoC `backend/spikes/AuthPoc` (el ADR preveía retirarlo tras S10) sigue en el repositorio y arrastra su propia copia de ImageSharp 2.1.13 transitivo; se recomienda borrarlo en una tarjeta propia cuando la persona dueña lo confirme.

## 10. Configuración y despliegue

El `docker-compose.yml` del repositorio es la pila de **desarrollo** (Development + `Auth__Mode=Development` por defecto, sin login). **No es una plantilla de producción.** Producción usa la imagen del backend con sus defaults (Production + Authenticated), secretos reales por entorno y un proxy con TLS delante.

### Variables (todas con su nombre en el compose entre paréntesis; formato `Seccion__Clave` = `Seccion:Clave`)

| Variable de la API | Compose | Defecto | Qué controla |
|---|---|---|---|
| `ASPNETCORE_ENVIRONMENT` | `ASPNETCORE_ENVIRONMENT` | imagen: `Production` (compose: `Development`) | Fuera de Development/Testing/Test, `Auth__Mode=Development` impide el arranque |
| `Auth__Mode` | `AUTH_MODE` | imagen: `Authenticated` (compose: `Development`) | `Authenticated` \| `Development` (usuario fijo, sin login, solo entornos de desarrollo) |
| `Auth__Cookie__Name` / `__SecurePolicy` | `AUTH_COOKIE_NAME`, `AUTH_COOKIE_SECURE_POLICY` | `vectorify.session` / `SameAsRequest` | Producción: `__Host-vectorify.session` y `Always` (el prefijo exige `Secure`) |
| `Auth__Cookie__Lifetime` / `__RememberMeLifetime` | `AUTH_COOKIE_LIFETIME`, `AUTH_COOKIE_REMEMBER_ME_LIFETIME` | `08:00:00` / `30.00:00:00` | Inactividad máxima deslizante / tope absoluto de «recordarme» |
| `Auth__Session__RevalidationInterval` / `__ClockSkew` | `AUTH_SESSION_REVALIDATION_INTERVAL`, `AUTH_SESSION_CLOCK_SKEW` | `00:05:00` / `00:00:30` | Ventana máxima de revocación (`00:00:00` = en cada request) / desfase de reloj |
| `Auth__DataProtection__KeysPath` | fijo en el compose | — (**obligatoria** fuera de desarrollo) | Directorio del key ring (volumen propio; es un SECRETO) |
| `Auth__Password__MinLength` | `AUTH_PASSWORD_MIN_LENGTH` | `12` | Largo mínimo (sin reglas de composición) |
| `Auth__Email__Mode` | `AUTH_EMAIL_MODE` | `Disabled` | `Disabled` \| `Log` (solo desarrollo) \| `Smtp` |
| `Auth__Email__PublicBaseUrl`, `__FromAddress`, `__FromName` | `AUTH_EMAIL_PUBLIC_BASE_URL`, `AUTH_EMAIL_FROM_ADDRESS`, `AUTH_EMAIL_FROM_NAME` | —, —, `Vectorify` | Origen de la SPA (https fuera de desarrollo; debe figurar en CORS) y remitente |
| `Auth__Email__Smtp__Host/Port/Security/UserName/Password` | `AUTH_EMAIL_SMTP_*` | —, `587`, `StartTls`, —, — | `Password` es un SECRETO: solo por entorno/gestor de secretos |
| `Auth__Tokens__PasswordResetLifetime` / `__EmailConfirmationLifetime` | `AUTH_TOKENS_*` | `01:00:00` / `1.00:00:00` | Vida de los enlaces (máx. 7 días) |
| `Auth__RequireConfirmedEmail` | `AUTH_REQUIRE_CONFIRMED_EMAIL` | `false` | Decisión P9 (§11) |
| `Auth__RateLimit__*` | `AUTH_RATE_LIMIT_*` | ver `docs/AUTH_SECURITY_REVIEW.md` §5.1 y `docs/AUTH_RECOVERY.md` §6 | `IpPermitLimit/IpWindow`, `AddressSendPermitLimit`, `AddressVerifyPermitLimit`, `AddressWindow`, `Login{Ip,Address}{PermitLimit,Window}`, `Register{Ip,Address}{PermitLimit,Window}` |
| `Auth__ForwardedHeaders__Enabled/KnownProxies/KnownNetworks/ForwardLimit` | `AUTH_FORWARDED_HEADERS_*` | `false`, —, —, `1` | Detrás de un proxy: activar con la IP o red del proxy (nunca `0.0.0.0/0`; `ASPNETCORE_FORWARDEDHEADERS_ENABLED` impide el arranque) |
| `Auth__Hsts__MaxAge` / `__IncludeSubDomains` | `AUTH_HSTS_*` | `180.00:00:00` / `false` | Solo fuera de Development y bajo https visto tras el proxy; sin preload |
| `Cors__AllowedOrigins` | `CORS_ALLOWED_ORIGINS` | `http://localhost:5173,…` | Orígenes **explícitos** de la SPA (credenciales) |
| `Postgres__ConnectionString` | `POSTGRES_*` | contraseña de ejemplo (rechazada fuera de desarrollo) | Definir `POSTGRES_PASSWORD` propia |
| `Upload__MaxPixels`, `Asset__MaxPixels` | — | `64000000` | Tope de píxeles de imágenes subidas |
| `DevelopmentUser__UserId/Email/DisplayName` | — | `…0001`, `dev@vectorify.local`, `Dev User` | Solo Auth:Mode=Development; la herramienta de §8 lo lee como origen |
| (frontend) `API_ORIGIN`, `VITE_API_BASE_URL` | `API_ORIGIN`, `VITE_API_BASE_URL` | `http://localhost:5080` | Origen de la API en la CSP de nginx / en el bundle; deben coincidir |
| (infra) `BIND_ADDRESS` | `BIND_ADDRESS` | `127.0.0.1` | Interfaz donde el compose publica los puertos (`0.0.0.0` solo conscientemente) |

### Pasos de despliegue (orientativos; no se desplegó nada)

1. **Antes:** resolver §1 (H-1) y §10 «decisiones» (dominio, certificado, proveedor de correo). Hacer `scripts/backup.*` (Postgres + `App_Data`) **y** respaldar aparte, cifrado, el volumen del key ring (no va en el backup).
2. Proxy con TLS delante: redirigir http→https, emitir HSTS, enviar `X-Forwarded-For $remote_addr` y `X-Forwarded-Proto $scheme` **sobrescribiendo** los del cliente; configurar `Auth__ForwardedHeaders__*` con la IP/red del proxy. Servir la SPA y la API sobre https; `Auth__Cookie__SecurePolicy=Always` y `Auth__Cookie__Name=__Host-vectorify.session`.
3. Backend: imagen sin `Auth__Mode` ni `ASPNETCORE_ENVIRONMENT` de desarrollo; `Auth__DataProtection__KeysPath` en un volumen propio; `Postgres__ConnectionString` con secreto propio; `Cors__AllowedOrigins` = origen https de la SPA; `Auth__Email__*` con el proveedor elegido (STARTTLS) y `PublicBaseUrl` https; `API_ORIGIN`/`VITE_API_BASE_URL` = origen https de la API.
4. Las migraciones de EF (dominio e Identity) se aplican **solas al arrancar**. Levantar, comprobar `/health` y `/api/v1/system/health`, registrar la primera cuenta y probar login/logout.
5. **Datos legados (P10):** si hay datos creados en Development, decidir el destino y usar la herramienta de §8 (dry-run primero, con copia previa).
6. Contenedores como no-root (R-3) y límites de memoria/CPU para la decodificación de imágenes (relacionado con H-1) son recomendaciones para el despliegue real.

### Rollback

- **Aplicación:** volver a la imagen anterior (conservar la etiqueta anterior). Las migraciones solo avanzan: la aplicación **no** ejecuta migraciones hacia atrás, así que si el esquema nuevo no es compatible con la imagen anterior hay que **restaurar la copia de la base** hecha en el paso 1 (`scripts/restore.*`, ver `docs/BACKUP_RESTORE.md`).
- **Sesiones:** el volumen del key ring no cambia con un rollback; las sesiones sobreviven. Para invalidarlas todas (sospecha de filtración): parar el backend y vaciar ese volumen (todas las personas vuelven a iniciar sesión; los enlaces de recuperación emitidos también caducan).
- **Reasignación de datos legados:** ver rollback en §8.
- No verificado: ensayo real de rollback de una migración en esta tarjeta.

### Cambios a mano en `.env.example` (no se tocó: hay una regla de denegación)

`.env.example` hoy no menciona ninguna variable de MVP 3.1. Añadir (todas opcionales, valores de ejemplo NO secretos; la contraseña SMTP nunca va en este archivo):

```dotenv
# ---- MVP 3.1: autenticación (ver docs/MVP31_RELEASE.md §10) ----
# Interfaz donde se publican los puertos del compose (127.0.0.1 = solo esta máquina).
BIND_ADDRESS=127.0.0.1
# Origen de la API que la CSP de nginx permite (igual que el origen de VITE_API_BASE_URL).
API_ORIGIN=http://localhost:5080
# Development (sin login) en el compose de desarrollo; Authenticated para probar el login real.
AUTH_MODE=Development
AUTH_COOKIE_NAME=vectorify.session
AUTH_COOKIE_SECURE_POLICY=SameAsRequest
AUTH_COOKIE_LIFETIME=08:00:00
AUTH_COOKIE_REMEMBER_ME_LIFETIME=30.00:00:00
AUTH_SESSION_REVALIDATION_INTERVAL=00:05:00
AUTH_SESSION_CLOCK_SKEW=00:00:30
AUTH_PASSWORD_MIN_LENGTH=12
AUTH_REQUIRE_CONFIRMED_EMAIL=false
# Correo (Disabled | Log | Smtp). Con Smtp: AUTH_EMAIL_SMTP_HOST/PORT/SECURITY/USERNAME y, por entorno real, AUTH_EMAIL_SMTP_PASSWORD (SECRETO).
AUTH_EMAIL_MODE=Disabled
AUTH_EMAIL_PUBLIC_BASE_URL=
AUTH_EMAIL_FROM_ADDRESS=
AUTH_EMAIL_FROM_NAME=Vectorify
AUTH_EMAIL_SMTP_HOST=
AUTH_EMAIL_SMTP_PORT=587
AUTH_EMAIL_SMTP_SECURITY=StartTls
AUTH_EMAIL_SMTP_USERNAME=
AUTH_TOKENS_PASSWORD_RESET_LIFETIME=01:00:00
AUTH_TOKENS_EMAIL_CONFIRMATION_LIFETIME=1.00:00:00
# Límites de frecuencia (IP / dirección). Los valores por defecto del compose son los de producción.
AUTH_RATE_LIMIT_LOGIN_IP_PERMIT_LIMIT=20
AUTH_RATE_LIMIT_LOGIN_ADDRESS_PERMIT_LIMIT=10
AUTH_RATE_LIMIT_REGISTER_IP_PERMIT_LIMIT=10
AUTH_RATE_LIMIT_REGISTER_ADDRESS_PERMIT_LIMIT=5
# Proxy de confianza (detrás de un proxy con TLS): activar con la IP o red del proxy.
AUTH_FORWARDED_HEADERS_ENABLED=false
AUTH_FORWARDED_HEADERS_KNOWN_PROXIES=
AUTH_FORWARDED_HEADERS_KNOWN_NETWORKS=
AUTH_HSTS_MAX_AGE=180.00:00:00
# Sumidero de correo de desarrollo (perfil mail-sink)
MAILPIT_UI_PORT=8025
MAILPIT_SMTP_PORT=1025
```

(S10 no añade variables de compose nuevas; las de arriba son las acumuladas de S02–S09. Los tiempos cortos de la pila de prueba están en `tests/e2e/mvp31_stack.sh`.)

## 11. Decisiones humanas pendientes

| # | Decisión | Estado | Efecto |
|---|---|---|---|
| 1 | **H-1 ImageSharp** (licencia/versión): aceptar, actualizar a 4.1.x, sustituir o aislar | **Abierta — bloquea el release** | §1 |
| 2 | **Proveedor de correo transaccional en la UE (P5)** con DPA, SPF/DKIM/DMARC y STARTTLS | Abierta | Sin proveedor no hay correo de recuperación/confirmación en producción (solo se probó contra Mailpit sin TLS) |
| 3 | **Verificación de correo obligatoria (P9)** (`Auth__RequireConfirmedEmail`) | Abierta (hoy `false`) | Si se activa, hace falta el correo del punto 2 |
| 4 | **Datos legados (P10)**: a quién reasignar, o borrar/dejar huérfanos | Abierta; herramienta entregada y probada, **no ejecutada sobre datos reales** | §8 |
| 5 | **Supresión y exportación de cuenta (P11)** | Abierta, **sin código** (propuesta en `docs/AUTH_AUTHORIZATION.md` §8) | Derechos UE; tarjeta propia |
| 6 | **Dominio y certificado TLS**, HSTS (incl. preload) | Abierta | Sin ellos `Secure`/`__Host-`/HSTS no son verificables |
| 7 | R-1 (bloqueo de cuenta como DoS), R-3 (contenedores sin root), R-2 (límites por instancia si se escala) | Abiertas (riesgos aceptados) | `docs/AUTH_SECURITY_REVIEW.md` §9 |
| 8 | Retirar `backend/spikes/AuthPoc` | Recomendado; **no se borró** | §9 |
| 9 | Aplicar a mano los cambios de `.env.example` | Pendiente | §10 |

## 12. Límites conocidos (qué NO se verificó)

- **TLS, dominio y certificado reales**; cookie `Secure`/`__Host-` en navegador sobre https; HSTS en navegador. La pila de prueba es http en `localhost` y entorno Development.
- **Proxy real delante de la API** (`Auth__ForwardedHeaders__*` solo con tests de host).
- **Proveedor de correo real**; STARTTLS con certificado; entregabilidad (solo Mailpit sin TLS).
- **Navegadores:** solo Chrome 155 headless, 1366×900; no Firefox/Safari/Edge/móvil; no se recorrió el editor completo (herramientas de dibujo, booleanas), ni zoom/teclado/lector de pantalla.
- **Límites de frecuencia** en el E2E (se subieron); **tiempos de enumeración** contra un atacante en red.
- **Ventana de revocación real de producción (5 min 30 s)**: se probó la lógica con 3 s; el valor de producción no se esperó.
- **Varias instancias del backend**, key ring compartido, rotación/restauración del key ring tras perder el volumen.
- **`real_stack_test.py`** (no hay Python en el entorno) y el envoltorio `reassign-legacy-data.ps1` (solo parseo).
- **Rollback de una migración** y la reasignación con volúmenes grandes o con tráfico.
- Perfiles ICC maliciosos contra ImageSharp 2.1.13 y los decodificadores PNG/JPEG/WEBP (H-1).
- Concurrencia entre dos sesiones de la misma cuenta sobre el mismo recurso (409 `xmin`) conserva el comportamiento anterior.
- Una cuenta bloqueada o con «recordarme» robado: ver `docs/AUTH_SESSION_LIFECYCLE.md` §9.

## 13. Orden de merge de la cadena de PRs apilados

Cada rama parte de la anterior; solo existe hoy el PR **#65** (abierto, `sprint/3e8d77b2-m31-net10-migracion` → `main`; el #64, S01, ya está mergeado). Los PR de S02…S10 se abren apilados sobre el anterior. Orden obligatorio (cada uno después del anterior; al mergear uno, reorientar el siguiente a `main`):

| Orden | PR / rama | Contenido |
|---|---|---|
| 1 | **#65** `sprint/3e8d77b2-m31-net10-migracion` | Migración a .NET 10 (LTS) + ADR de auth confirmado |
| 2 | `sprint/3e8d77b2-m31-s02-registro-user` | Registro + creación/vinculación de `User` (Identity) |
| 3 | `sprint/3e8d77b2-m31-s03-login-logout` | Login, logout y `me` con cookie; CSRF |
| 4 | `sprint/3e8d77b2-m31-s04-sesiones` | Sesiones, «recordarme», key ring y frontera 401 |
| 5 | `sprint/3e8d77b2-m31-s05-react-auth` | Estado de auth en React y rutas protegidas |
| 6 | `sprint/3e8d77b2-m31-s06-autorizacion` | Autorización y aislamiento multiusuario |
| 7 | `sprint/3e8d77b2-m31-s07-perfil` | Perfil y configuración básica de cuenta |
| 8 | `sprint/3e8d77b2-m31-s08-recuperacion` | Recuperación de acceso y verificación de correo |
| 9 | `sprint/3e8d77b2-m31-s09-hardening` | Hardening de seguridad |
| 10 | `sprint/3e8d77b2-m31-s10-e2e-release-gate` (este) | E2E, herramienta de reasignación y este gate |

**Mergear la cadena NO equivale a liberar:** el veredicto de §1 sigue siendo NO LISTO PARA RELEASE mientras H-1 esté abierto. Los números de PR de S02…S10 no existían al escribir este documento.

## 14. Cómo reproducir

```bash
tests/e2e/mvp31_stack.sh up                       # pila aislada Authenticated + Mailpit (construye imágenes)
node tests/e2e/mvp31_auth_e2e_test.mjs            # 9 escenarios (+6b, 6c)
node tests/e2e/mvp31_auth_browser_test.mjs        # Chrome real, dos perfiles
E2E_AUTH=1 BACKEND_URL=http://localhost:32080 SPA_ORIGIN=http://localhost:32173 node tests/e2e/mvp3_release_e2e_test.mjs   # idem full_pipeline_e2e_test / upload_e2e_test
tests/e2e/mvp31_stack.sh down && tests/e2e/mvp31_stack.sh leftovers          # down -v --rmi local; debe quedar vacío

# Datos legados (§8): up-dev -> crear datos (E2E anónimos) -> stop -> up -> before -> backup -> dry-run -> -a -> after
tests/e2e/mvp31_stack.sh up-dev && … && tests/e2e/mvp31_stack.sh stop && tests/e2e/mvp31_stack.sh up
node tests/e2e/mvp31_legacy_reassign_check.mjs before    # y `after` con EXPECT_V2=<n>

# Suites (sin otras cargas en paralelo)
dotnet test backend/Vectorify.sln                 # ~30 min
cd frontend && npm test && npm run build
```
