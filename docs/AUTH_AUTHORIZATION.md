# Autorización y aislamiento multiusuario (M3.1-S06)

Complementa a `docs/ADR_AUTH_MVP31.md` (T11 IDOR, T13, «Impacto concreto en S06») y a `docs/AUTH_SESSION_LIFECYCLE.md`. Describe **lo que está
implementado**, la matriz de recursos protegidos, la lista blanca anónima, el tratamiento de los datos legados y **qué no está verificado**.
Principio: **autenticación ≠ autorización**. Tener sesión no concede acceso a un `projectId`.

## 1. Cómo se decide quién accede a qué

Orden del pipeline (`Program.cs`): `CorrelationId → DependencyFailure → CORS → CsrfGuard → (Swagger solo Development) → UseAuthentication →
UserProvisioningMiddleware → UseAuthorization → ClassicProjectOwnerMiddleware → endpoint`.

| Capa | Qué hace | Dónde |
|---|---|---|
| **Denegar por defecto** | `FallbackPolicy` = «hay un usuario efectivo resuelto» (`ResolvedUserRequirement` sobre `IUserContext.IsAuthenticated`). Todo endpoint sin `AllowAnonymous` explícito la hereda; sin usuario ⇒ **401** `{ "code": "unauthenticated" }`. | `Authorization/ResolvedUserAuthorization.cs`, `Authorization/UnauthenticatedJsonResultHandler.cs` |
| **Dueño del flujo clásico (central)** | Un único grupo `MapClassicProjectGroup()` (`/api/v1/projects/{projectId}/images/{imageId}`) lleva una *metadata*; `ClassicProjectOwnerMiddleware` la lee, resuelve el registro **una vez** y, si no existe **o** no es del usuario efectivo, responde el **mismo 404** (cuerpo `{"code":"not_found","message":"No existe un proyecto/imagen con esos IDs."}` y cabeceras). El handler no se ejecuta: no se enlaza el cuerpo, no se llama al motor Python. | `Authorization/ClassicProjectScope.cs`, `Authorization/ClassicProjectOwnerMiddleware.cs` |
| **Regla de dueño única** | `IClassicProjectAccess` (`FindAccessible`/`IsAccessible`) la usan el middleware, el replay de idempotencia de la carga y el puente clásico → v2. `ProjectRecord.IsAccessibleBy(userId, allowOwnerless)`. | `Projects/ClassicProjectAccess.cs`, `Projects/ProjectRecord.cs` |
| **Dueño en `/api/v2`** | Cada operación del repositorio filtra por `OwnerId = IUserContext.GetEffectiveUserId()` (404 uniforme). **Una sola consulta por request**; no se añade una comprobación central extra para no duplicarla. | `ProjectRepository`, `VectorDocumentRepository`, `AssetService` |
| **El dueño lo pone el servidor (RS10)** | `OwnerId` sale siempre de `IUserContext`; ningún `ownerId`/`userId` del body, query o cabeceras se respeta (los contratos de entrada ni siquiera tienen el campo). | `ProjectService`, `AssetService`, `VectorDocumentService`, `ProjectUploadService` |

`UserProvisioningMiddleware` pasa a ir **antes** de `UseAuthorization` (la política se evalúa sobre el usuario ya resuelto). El `UnauthenticatedUserMiddleware` de
S03 (red de seguridad que traducía la excepción a 401) **se retira**: la política responde 401 antes de llegar a ningún handler y, si algún día un endpoint llegara a
`GetEffectiveUserId()` sin sesión, fallaría cerrado con un 500 visible (error de cableado) en lugar de ejecutar trabajo para nadie.

### Modo `Auth:Mode=Development` (usuario de desarrollo, sin login)

`DevelopmentUserContext.IsAuthenticated` es `true`, así que **la política queda satisfecha por el usuario de desarrollo**: el flujo actual y los E2E anónimos de
`tests/e2e` siguen igual (sin cookie ni cabecera anti-CSRF). El dueño sigue aplicándose: un registro con **otro** `OwnerId` es 404 también para el usuario de
desarrollo. Este modo solo existe en `Development/Testing/Test` (guardrail de arranque de S02).

## 2. Lista blanca anónima (única)

| Ruta | Por qué es anónima |
|---|---|
| `GET /health` | Liveness para Docker/orquestador; sin datos. |
| `GET /api/v1/system/health` | Estado API/Postgres/Python que consume la SPA antes de iniciar sesión; sin datos de usuarios. |
| `POST /api/v1/auth/register`, `POST /api/v1/auth/login` | Nadie tiene sesión antes de entrar; respuestas uniformes (T5/T6). |
| `POST /api/v1/auth/logout` | Idempotente (204 con o sin sesión); no expone datos. |
| `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/resend-confirmation` | M3.1-S08. Quien olvidó la contraseña o no confirmó el correo no tiene sesión. **202 uniforme** exista o no la cuenta; el correo sale en segundo plano; límites por IP (429) y por dirección hasheada. Ver `docs/AUTH_RECOVERY.md`. |
| `POST /api/v1/auth/reset-password`, `POST /api/v1/auth/confirm-email` | M3.1-S08. Los autoriza el **token nativo de Identity** (un solo uso, vida corta, ligado al SecurityStamp); error genérico único para token inválido/caducado/reusado/cuenta inexistente; límites por IP y dirección. |
| `GET /api/v1/auth/me` | En Development la SPA necesita 200 sin cookie; en Authenticated responde 401 por sí mismo sin identidad verificada. |
| Swagger / Swagger UI | No son endpoints: son *middleware* previo a la autorización y **solo se montan en Development**. |

`POST /api/v1/auth/logout-all` y `POST /api/v1/auth/change-password` (S08) **no** son anónimas (`RequireAuthorization`; la cuenta sale de la cookie, nunca del cuerpo). La lista está fijada por `EndpointAuthorizationAudit.AnonymousAllowlist` (§5).

## 3. Matriz de recursos protegidos

Inventario real del `EndpointDataSource` (**74** rutas `/api/*` + `/health`; ver §5): **43** en el grupo central del flujo clásico, **13** con dueño en el
repositorio/servicio, **12** sin recurso ajeno que direccionar (incluye `GET`/`PATCH /api/v1/me`, S07) y **6** anónimas.

| Recurso | Rutas | Mecanismo | Ajeno / inexistente |
|---|---|---|---|
| **Imagen/proyecto clásico**: metadata, `…/original` (descarga) | `GET …/images/{imageId}`, `GET …/original` | Grupo central | 404 uniforme |
| **Pipeline clásico**: preview, threshold, vectorize, simplify, check, dimensions, export | 13 rutas (`preview`, `previews/{id}`, `threshold`, `masks/{id}`, `vectorize`, `vectors/{id}`, `simplify/preview|apply`, `simplifications/{id}`, `check`, `dimensions/apply`, `dimensions/{id}`, `export`) | Grupo central | 404 uniforme |
| **Paleta**: detect, merge, unmerge, rename, exclude, confirm, GET, preview, máscara | 9 | Grupo central | 404 uniforme |
| **Capas** (generar, listar, consolidadas), **layout** (visibilidad, bloqueo, renombrar, reordenar, GET), **operaciones** (asignar, listar) | 2 + 1 + 5 + 2 | Grupo central | 404 uniforme |
| **Componentes**, **grupos**, **unión física** (preview/confirm/GET) | 2 + 4 + 3 | Grupo central | 404 uniforme |
| **Project v2**: GET, PATCH, DELETE, **duplicate** | 4 | `OwnerId` en el repositorio | 404 uniforme |
| **Assets** (subir, **descargar por URL**, borrar) | 3 | Proyecto propio + asset **de ese proyecto** | 404 uniforme |
| **VectorDocument / DocumentVersion**: documento, versiones, versión *n*, **restaurar versión**, editor-save, **mutación de capa** (`PATCH layers/{id}`) | 6 | `OwnerId` en el repositorio | 404 uniforme |
| **Alta y listado** (`POST /api/v1/projects`, `POST|GET /api/v2/projects`, `POST /api/v2/workspaces/save`) | 4 | Dueño = `IUserContext`; en `workspaces/save` tanto `ProjectId` como el triple clásico del body se resuelven con el dueño del servidor | 404 uniforme (el triple clásico **inexistente** y el **ajeno** responden igual) |
| **Geometría sin estado** (`/api/v2/geometry/*`) | 5 | Solo `FallbackPolicy` (no leen ni escriben recursos) | — |
| **Perfil propio** (`GET`/`PATCH /api/v1/me`, S07) | 2 | `FallbackPolicy` + usuario SOLO de `IUserContext`; la ruta no recibe ids y el cuerpo no puede nombrar a otro usuario | — (no direcciona recursos ajenos) |

**404 uniforme, no 403:** no se revela que un `projectId` ajeno existe. Para el flujo clásico el cuerpo y las cabeceras son idénticos por construcción (los emite el mismo
middleware); para `/api/v2` los verifica la suite (§5). Quien sí recibe un 403/409 es siempre el **dueño** (p. ej. conflicto de concurrencia), nunca un tercero.

### Descargas y URL directas

`<img src>`, previews, miniaturas y export se piden por URL directa y **viajan con la cookie de sesión** (`SameSite=Lax`): pasan por la misma política y el mismo
filtro de dueño que cualquier otra petición (anónimo ⇒ 401, otro usuario ⇒ 404). **No se introducen URLs firmadas** (decisión del ADR D3: con cookie no hacen falta);
si en el futuro se añadieran (p. ej. CDN), tendrían que generarse solo después de pasar este filtro y con expiración corta. Consecuencia conocida: una URL de descarga
copiada fuera del navegador no funciona sin la cookie.

## 4. Datos legados y datos del usuario de desarrollo (decisión humana abierta — ADR P10)

| Dato | Estado tras S06 en `Authenticated` | En `Development` |
|---|---|---|
| `ProjectRecord` clásico **con** `OwnerId` | Solo su dueño | Solo ese dueño (si es el usuario de desarrollo) |
| `ProjectRecord` clásico con `OwnerId == null` (sidecars anteriores a M2.2-S09) | **Nadie** puede accederlo (falla cerrado, 404) | Accesible para el usuario de desarrollo |
| `projects.OwnerId = 00000000-0000-0000-0000-000000000001` (usuario de desarrollo) | Accesible solo si alguien inicia sesión **como ese usuario**, y nadie puede (no tiene cuenta de Identity) ⇒ **huérfanos** | Accesibles para el usuario de desarrollo |

**No se migró ni se borró nada.** El destino definitivo (reasignar a una persona real, borrar o dejar huérfanos) lo decide la persona dueña del producto. Los datos
huérfanos siguen en disco/base, intactos, y son recuperables con lo propuesto abajo. Efectos secundarios a conocer: las claves de idempotencia de `document_versions` están
prefijadas con el dueño (`{ownerId:N}:clave`); tras reasignar, un reintento *antiguo* con la misma clave del nuevo dueño no será reconocido (inofensivo: crea una versión nueva).

> **Actualización M3.1-S10:** la propuesta de abajo quedó **implementada y probada** como `scripts/reassign-legacy-data.sh|.ps1` (comando `--reassign-legacy-data` de la API; dry-run por defecto, `--apply` explícito, idempotente, transaccional en la base, copia `.pre-reassign.bak` de cada sidecar). Úsela en lugar del SQL y del script `.mjs` de este apartado, que se conservan solo como explicación del modelo. Uso, prueba en pila aislada y límites: `docs/MVP31_RELEASE.md` §8. **El destino sigue siendo una decisión humana (P10).**

### Reasignación PROPUESTA (NO ejecutada; revisar, hacer copia de seguridad antes — ver `docs/BACKUP_RESTORE.md`)

1. Elegir el `Users.Id` destino (la persona ya registrada): `SELECT "Id", "Email", "CreatedAt" FROM users ORDER BY "CreatedAt";`

2. **Proyectos v2 (Postgres).** Los `assets`, `vector_documents`, `document_versions` y `layers` cuelgan del proyecto: basta cambiar `projects."OwnerId"`.

```sql
-- Inspección (solo lectura): cuántos proyectos tiene cada usuario, y cuáles son del usuario de desarrollo.
SELECT u."Id", u."Email", count(p."Id") AS projects
FROM users u LEFT JOIN projects p ON p."OwnerId" = u."Id"
GROUP BY u."Id", u."Email" ORDER BY projects DESC;

-- PROPUESTA (no ejecutar sin decisión humana). :target = Users.Id de la persona destino.
BEGIN;
UPDATE projects
   SET "OwnerId" = :'target'::uuid
 WHERE "OwnerId" = '00000000-0000-0000-0000-000000000001'   -- usuario de desarrollo (DevelopmentUser:UserId por defecto)
   AND "DeletedAt" IS NULL;                                 -- omitir los borrados lógicos; quitar la línea para incluirlos
-- Verificar el recuento y recién entonces: COMMIT;   (o ROLLBACK;)
```

3. **Registros clásicos (sidecars JSON en `ProjectRegistry:RootPath`, por defecto `App_Data/projects/{projectId}/{imageId}.json`).** No son SQL: hay que reescribir el campo
   `OwnerId` (`null` o el id del usuario de desarrollo) con el mismo `Users.Id` destino, **con la API parada** (rehidrata los sidecars al arrancar):

```js
// node reassign-classic-owner.mjs <carpeta App_Data/projects> <Users.Id destino> [--apply]   (PROPUESTA; por defecto solo lista, no escribe)
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
const [root, target, flag] = process.argv.slice(2);
const DEV = "00000000-0000-0000-0000-000000000001";
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".json") ? [p] : []; });
let changed = 0;
for (const file of walk(root)) {
  const rec = JSON.parse(readFileSync(file, "utf8"));
  if (rec.OwnerId == null || rec.OwnerId === DEV) {
    changed++;
    console.log(`${flag === "--apply" ? "reasigna" : "reasignaría"} ${file} (OwnerId=${rec.OwnerId})`);
    if (flag === "--apply") writeFileSync(file, JSON.stringify({ ...rec, OwnerId: target }, null, 2));
  }
}
console.log(`${changed} registro(s)`);
```

   Los demás sidecars versionados (paleta, capas, vectores, …) se direccionan por `(projectId, imageId)` y **no llevan dueño**: heredan el del registro clásico.

4. Alternativas: **borrar** (`DELETE` por la API de cada dueño no es posible sin cuenta; sería un script administrativo propio) o **dejarlos huérfanos** (estado actual, sin acceso).

## 5. Tests

| Suite | Qué prueba | Archivo |
|---|---|---|
| **Aislamiento UserA/UserB** (Postgres real, tres cuentas reales por `/register` + `/login`, cookies emitidas por el servidor, `WithCsrf()`) | Matriz por **cada ruta del `EndpointDataSource`** del flujo clásico (B y C sobre ids reales de A, ids inexistentes y A sobre B: 404 con estado/cabeceras/cuerpo idénticos y estado de A intacto), la misma matriz para `/api/v2` (GET, PATCH, DELETE, descarga, duplicado, restauración, mutaciones de capa, editor-save, assets), listado y búsquedas con comodines, `workspaces/save` con proyecto o triple ajeno, descargas por URL directa (dueño 200 / otro 404 / anónimo 401), anónimo ⇒ 401 en **todas** las rutas protegidas, cookie basura, tras logout, `ownerId` del cliente ignorado, registro legado sin dueño inaccesible, una sola resolución de dueño por request. | `EndToEnd/MultiUserIsolationTests.cs` |
| **Modo Development** | Flujo anónimo completo intacto, política satisfecha por el usuario de desarrollo en toda ruta, dueño ajeno ⇒ 404, legado sin dueño accesible solo para él. | `EndToEnd/DevelopmentModeAuthorizationTests.cs` |
| **Arquitectura** (reflexión sobre el `EndpointDataSource`) | Toda ruta `/api/*` hereda la denegación por defecto y tiene dueño (grupo central) o figura en una lista blanca justificada; las listas no pueden quedar desactualizadas. Con **controles** que demuestran que el auditor detecta una ruta nueva sin proteger, una ruta que pierde la metadata del grupo, una ruta convertida en anónima y una entrada de lista obsoleta. | `EndToEnd/EndpointAuthorizationArchitectureTests.cs`, `TestSupport/EndpointAuthorizationAudit.cs` |
| **Perfil propio** (S07) | `GET`/`PATCH /api/v1/me`: lectura, edición, validación 1–80/unicode/control, campos prohibidos sin efecto (contra la base), 401, CSRF 403, `no-store`, sin filtrar identidad interna, aislamiento (C no toca a A ni a B ni con ids en cuerpo/query/cabeceras) y modo Development (`/auth/me` lee `Users.DisplayName`; sobrevive a un reinicio). | `EndToEnd/ProfileEndpointsTests.cs`, `EndToEnd/ProfileDevelopmentModeTests.cs`, `EndToEnd/MultiUserIsolationTests.cs` (`Profile_*`) |
| **Recuperación y verificación** (S08) | Rutas anónimas nuevas y `change-password` en las listas del auditor; flujos completos, tokens inválidos/caducados/reusados, límites, SMTP real contra un servidor falso. Ver `docs/AUTH_RECOVERY.md` §9. | `EndToEnd/AuthRecovery*Tests.cs` |
| Regla de dueño (unidad) | `ProjectRecord.IsAccessibleBy` y `ClassicProjectAccess` por modo, dueño y sesión. | `Projects/ClassicProjectAccessTests.cs`, `Projects/PersistentProjectRegistryTests.cs` |

**Cómo añadir una ruta nueva.** Del flujo clásico: mapearla con path **relativo** dentro de `classicProject` en `Program.cs` (queda protegida sola). De `/api/v2` o sin
recurso: añadirla a la lista blanca de `EndpointAuthorizationAudit` **con su justificación** y, si direcciona un proyecto, a la matriz v2 de `MultiUserIsolationTests`
(`V2Matrix_CoversEveryServiceEnforcedRoute…` lo exige). Una ruta anónima nueva requiere además tocar `AnonymousAllowlist`: es una decisión de revisión.

## 6. Qué no está verificado

- Rendimiento bajo carga real: se verifica por conteo que hay **una** resolución de dueño por request y una sola consulta a `projects` en `/api/v2/projects/{id}`; no se midieron latencias.
- ~~Los E2E de `tests/e2e` solo se ejecutan en `Auth:Mode=Development`~~ (M3.1-S10): `E2E_AUTH=1` los ejecuta en `Authenticated` con cookie jar (`tests/e2e/lib/authClient.mjs`), y `tests/e2e/mvp31_auth_e2e_test.mjs` prueba el aislamiento de punta a punta contra el compose real (59 rutas). Ver `docs/MVP31_RELEASE.md`.
- Canales fuera de la API (acceso directo a Postgres o al disco `App_Data`, backups) no pasan por esta autorización; su control es operativo.
- Concurrencia entre dos sesiones del mismo usuario sobre el mismo recurso (conflictos `xmin`/409) conserva el comportamiento anterior; no se alteró.
- Tiempo de respuesta como oráculo de existencia (el 404 de un ajeno y de un inexistente del flujo clásico cuestan lo mismo —un lookup en memoria—; en v2 ambos hacen la misma consulta indexada): no medido.

## 7. Perfil propio (M3.1-S07)

`GET /api/v1/me` y `PATCH /api/v1/me` (distintos de `GET /api/v1/auth/me`, la consulta de sesión de S03/S05). El usuario sale SOLO de `IUserContext`; no hay ids en la ruta.

| | |
|---|---|
| Respuesta (ambos métodos) | `{ id, email, displayName, createdAt, managedFields }`. `id` = `Users.Id` interno; `email` es de **solo lectura**; `managedFields = ["email"]` indica qué gestiona la cuenta/identidad. Nunca proveedor, subject, hash ni stamp. `Cache-Control: no-store`. |
| `PATCH` | Acepta SOLO `displayName`: recortado, 1–80 caracteres (unidades UTF-16, igual que el cliente), sin caracteres de control (U+0000–U+001F, U+007F–U+009F). Error: `400 { "code": "invalid_display_name", "message": "…" }` en español. |
| **Decisión: campos ajenos IGNORADOS, no 400** | `id`, `userId`, `ownerId`, `email`, `provider`, `subject`, `createdAt`, `authMode`… no se enlazan ni tienen efecto (el contrato de entrada `UpdateProfileRequest` solo declara `displayName`); un cuerpo sin `displayName` es 400. Se ignoran (en vez de rechazar) para que un cliente que reenvíe el perfil completo no falle, y está demostrado contra la base. |
| Seguridad | 401 sin sesión (`FallbackPolicy`); 403 `csrf_rejected` sin cabecera anti-CSRF u Origin permitido (modo Authenticated, como el resto de métodos no seguros); el log no incluye nombre ni correo. |
| Lista del auditor | `NoProjectResourceAllowlist`: perfil PROPIO, el usuario no es un parámetro. |
| Nombre compartido | `Users.DisplayName` (dominio, no Identity). `GET /api/v1/auth/me` lo lee de ahí también en `Auth:Mode=Development` (no del valor de configuración `DevelopmentUser:DisplayName`, que solo siembra la fila la primera vez), así que el nombre editado sobrevive a una recarga y a un reinicio de la API. |
| Cambio de contraseña (S08) | `POST /api/v1/auth/change-password` (sesión + CSRF + contraseña actual), ver `docs/AUTH_RECOVERY.md`. Lista del auditor: `NoProjectResourceAllowlist`. |
| No implementado (declarado) | Cambio de correo, avatar, locale/preferencias. |

## 8. Pendiente de decisión: supresión de cuenta y exportación de datos (P11) — SIN CÓDIGO

El ADR asignaba a S07 la **supresión de cuenta** y la **exportación de datos** (derechos UE de supresión y portabilidad). No están en el texto de la tarjeta, son destructivas
e irreversibles, y dependen de la pregunta abierta **P11** (plazo de retención, qué se borra y qué se conserva, destino de los `Project` por la FK `Restrict`). **No se
implementaron** ni hay endpoint, UI ni migración para ellas. Diseño PROPUESTO para decidir (no vinculante hasta que lo apruebe la persona dueña del producto):

**Exportación (portabilidad).** `GET /api/v1/me/export` (solo el propio usuario; reautenticación reciente con contraseña): un archivo (JSON + los assets referenciados, en ZIP) con
perfil, proyectos, documentos vectoriales, versiones y capas. Si el volumen lo exige, generación asíncrona con descarga de un solo uso. Va a la lista del auditor de rutas.

**Supresión.** `DELETE /api/v1/me` con confirmación explícita (reautenticación + escribir el correo):
1. Inmediato: cuenta bloqueada para entrar y todas las sesiones invalidadas (rotación del `SecurityStamp`, como `logout-all`).
2. Plazo de gracia (propuesta: 30 días, **a decidir**) en el que se puede cancelar (el enlace de cancelación depende del envío de correo de S08).
3. Purga, **en este orden por las FK**: assets en el storage y sidecars JSON clásicos con su `OwnerId` → `projects` (con `vector_documents`, `document_versions`, `layers`) → `user_identities` (Cascade) y la cuenta de Identity → la fila de `users` al final (la FK `Project → User` es `Restrict`, por eso los proyectos van antes).
4. Se conservan solo registros mínimos sin datos personales (p. ej. un hash del id y la fecha de borrado) y los logs de seguridad con retención corta; las copias de seguridad caducan según `docs/BACKUP_RESTORE.md`. El usuario de desarrollo no es borrable.

**Preguntas que decidir (P11):** plazo de gracia y de retención; qué se conserva (logs, auditoría) y por cuánto; si los backups deben purgarse o caducar; si se exige correo de confirmación;
formato de la exportación y si incluye los binarios; qué pasa con los datos legados sin dueño (ADR P10). Cuando se decida, se implementa en una tarjeta propia con su matriz UserA/UserB (el borrado de A no puede tocar a B).
