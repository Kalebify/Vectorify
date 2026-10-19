# M3.1-S10 · E2E Auth + multiusuario + release gate
URL: https://app.notion.com/p/3e8d77b26398816385c2d0163224465a
Stack declarado: Frontend, ASP.NET Core, Infra (propiedad Área). ASP.NET Core Identity + cookie (S02-S09), React 19 + TypeScript + Vite, nginx, docker compose, .NET 10, runner Node existente (`tests/e2e/*.mjs`).

## Requerimiento (transcripción del cuerpo de la tarjeta)
Objetivo: Cerrar MVP 3.1 verificando registro, sesión, ownership y aislamiento con varios usuarios reales de prueba.

## Escenarios E2E
1. Registrar User A.
2. Crear Project A y editarlo.
3. Logout/Login y recuperar Project A.
4. Registrar User B.
5. User B no ve Project A.
6. Intentar acceso directo a IDs/assets/versiones de A → denegado.
7. Session expiry/renewal.
8. Logout efectivo.
9. Recovery flow si aplica.
## Migración DevelopmentUser
Desactivar DevelopmentUserContext fuera de Development/Test. Verificar que Production no arranca en modo bypass.
## Datos existentes
Definir cómo asignar proyectos creados antes de Auth al usuario de desarrollo/owner de migración.
## Release gate
Suite E2E verde, security checklist S09 cerrada y documentación de configuración/deploy.
## DoD
VECTORiZE puede exponerse a usuarios autenticados sin compartir accidentalmente proyectos entre cuentas.

## Criterios de aceptación
- Register/Login → Projects → Editor → Logout y UserA/UserB isolation funcionan E2E; no existen fallos bloqueantes de Auth/authorization. (declarado)
- DERIVADO (E2E HTTP con cookie jar, ADR «Impacto concreto en S10»): un helper compartido `tests/e2e/lib/authClient.mjs` (cookie jar, cabecera `X-Vectorify-Request` y `Origin` permitido, registro/login/logout, lectura del correo en Mailpit) y un script `tests/e2e/mvp31_auth_e2e_test.mjs` que ejecuta los 9 escenarios de la tarjeta contra el `docker compose` REAL (Postgres, Python, backend en `AUTH_MODE=Authenticated`, nginx, Mailpit con el perfil `mail-sink`): registro de A y B (cuentas distintas por ejecución), creación y edición de un proyecto real (flujo clásico del dataset + guardado v2/`editor-save`), logout/login y recuperación del proyecto, B no lo ve (listado) y recibe el mismo 404 que ante un id inexistente en TODA la superficie (detalle, assets, documento, versiones, restauración, exports, descargas por URL directa, etapas del flujo clásico), cookie manipulada ⇒ 401, CSRF negativo (sin cabecera / Origin ajeno ⇒ 403), caducidad y renovación de la sesión (compose con tiempos cortos configurables `Auth__Cookie__Lifetime`, `Auth__Session__RevalidationInterval` o equivalente; sin dormir minutos de más), logout efectivo (la cookie anterior da 401 tras la revalidación; «cerrar sesión en todos lados»), y recuperación de acceso extremo a extremo (olvidé → correo en Mailpit → restablecer → login con la nueva, el enlace reusado falla, sesiones previas invalidadas). Sale con código ≠ 0 si algo falla y resume escenario por escenario.
- DERIVADO (E2E en navegador real): un recorrido con el cliente DevTools de S09 (`tests/e2e/lib/cdp.mjs`, sin dependencias nuevas) que cubra, con dos perfiles/contextos de navegador distintos: Register/Login → Mis proyectos → Editor con un proyecto → Mi cuenta → Logout → (otra cuenta) B no ve el proyecto de A, deep link al proyecto de A como B ⇒ mensaje de no encontrado (no el contenido), sesión expirada ⇒ pantalla de login con aviso, 0 violaciones de CSP y 0 errores de consola distintos de los 401 esperados. Si no hay navegador disponible, decirlo y no darlo por cubierto.
- DERIVADO (compatibilidad): los E2E existentes (`mvp3_release_e2e_test.mjs`, `full_pipeline_e2e_test.mjs`, `upload_e2e_test.mjs`, y lo que corresponda de `real_stack_test.py`) siguen pasando en modo Development sin cambios de comportamiento, y aceptan opcionalmente `E2E_AUTH=1` (o equivalente) para ejecutarse en modo Authenticated con el cookie jar; documentar en `tests/README.md`.
- DERIVADO (migración DevelopmentUser): pruebas con la IMAGEN real del backend: sin overrides arranca en Production + Authenticated y exige la configuración de producción; `ASPNETCORE_ENVIRONMENT=Production` + `Auth__Mode=Development` NO arranca (código de salida ≠ 0 y mensaje claro); en Development/Testing/Test sigue disponible. Evidencia registrada en el documento de gate.
- DERIVADO (datos existentes): el destino de los proyectos del usuario de desarrollo y de los registros clásicos sin dueño es decisión humana (ADR P10), pero la tarjeta pide «definir cómo asignarlos»: entregar una herramienta de reasignación SEGURA y PROBADA (la propuesta de S06 en `docs/AUTH_AUTHORIZATION.md` §6/§8 no se había ejecutado ni probado): idempotente, DRY-RUN POR DEFECTO (solo informa qué cambiaría), `--apply` explícito, destino indicado por correo de una cuenta existente, transaccional en base, cubre `Projects.OwnerId` del usuario de desarrollo (`00000000-0000-0000-0000-000000000001`) y los registros clásicos de `App_Data` sin dueño, con copia de seguridad previa o instrucción de respaldo, y sin tocar nada más. Probarla contra una pila ASLADA con datos creados en modo Development (antes de Auth) y luego reasignados a una cuenta real (A los ve, B no). NUNCA ejecutarla contra el proyecto compose `vectify` del usuario ni contra datos reales: el usuario decide cuándo y a quién.
- DERIVADO (release gate): documento `docs/MVP31_RELEASE.md` con: veredicto explícito del gate; matriz de verificación (qué se probó, cómo, cuándo y qué NO); resultado de la suite E2E; estado del checklist de seguridad de S09 (`docs/AUTH_SECURITY_REVIEW.md`) y de CADA hallazgo; documentación de configuración y despliegue (variables `Auth__*`/`Auth__Email__*`/`Auth__RateLimit__*`/`Auth__ForwardedHeaders__*`, `API_ORIGIN`, `BIND_ADDRESS`, key ring, SMTP, TLS/proxy, backups, pasos de despliegue y de rollback); lista de decisiones humanas pendientes (ImageSharp H-1, proveedor de correo UE P5, verificación de correo obligatoria P9, datos legados P10, supresión/exportación de cuenta P11, dominio y certificado TLS, cambios a mano de `.env.example`); límites conocidos; orden de merge de la cadena de PRs apilados (PR #65 migración .NET 10 → S02 … S09 → S10). Actualizar `README.md` (sección MVP 3.1).
- DERIVADO (veredicto honesto): el hallazgo H-1 (SixLabors.ImageSharp 2.1.13, High) sigue ABIERTO y BLOQUEA EL RELEASE por decisión del usuario de mantenerlo como bloqueante en el gate; el documento de gate debe decir con todas las letras «NO LISTO PARA RELEASE» mientras exista un High/Critical abierto, aunque toda la suite esté verde, y listar qué desbloquea. No intentar resolver H-1 aquí (decisión humana de licencia).
- DERIVADO: los tests existentes (2218 backend, 3732 frontend) siguen verdes; `npm run build` verde; sin cambios de comportamiento de producto salvo lo imprescindible para poder testear (documentar cualquier cambio); no se borra el PoC `backend/spikes/AuthPoc` (el ADR preveía retirarlo tras S10: recomendarlo en el documento como seguimiento y dejar la decisión al usuario).

## Referencias visuales / de marca
No aplica (sin pantallas nuevas).

## Contexto técnico vinculante
`docs/ADR_AUTH_MVP31.md`, `docs/AUTH_SESSION_LIFECYCLE.md`, `docs/AUTH_AUTHORIZATION.md`, `docs/AUTH_RECOVERY.md`, `docs/AUTH_SECURITY_REVIEW.md`, `docs/MVP3_RELEASE.md` (formato del gate de MVP 3) y los IMPL de S02-S09 en `.sprint/`. Código/herramientas: `tests/e2e/*` (incl. `lib/cdp.mjs`, `csp_browser_check.mjs`, `auth_timing_probe.mjs`), `tests/README.md`, `docker-compose.yml` (perfil `mail-sink`, `BIND_ADDRESS`, `API_ORIGIN`), `scripts/` (backup), `backend/Dockerfile`.

## Umbrales de calidad
Suite E2E HTTP verde (9 escenarios) y recorrido en navegador real verde, ambos contra compose aislado `docker compose -p vectorify-s10` (puertos 32xxx; nunca el proyecto `vectify` del usuario en 5080/5173/5432; bajar con `down -v --rmi local`); `dotnet test Vectorify.sln` y `npm test`/`npm run build` verdes, ejecutados sin otras cargas en paralelo; E2E existentes en Development verdes.

## Ambigüedades detectadas
Ninguna que impida empezar. Decisiones del usuario ya tomadas: mantener ImageSharp como bloqueante abierto en el gate. Decisiones humanas que NO se resuelven aquí: ImageSharp (licencia/versión), proveedor de correo (P5), P9, P10 (la herramienta de reasignación se entrega pero no se ejecuta sobre datos reales), P11, dominio y certificado.
