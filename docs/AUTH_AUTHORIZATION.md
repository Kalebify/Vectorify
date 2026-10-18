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
| `GET /api/v1/auth/me` | En Development la SPA necesita 200 sin cookie; en Authenticated responde 401 por sí mismo sin identidad verificada. |
| Swagger / Swagger UI | No son endpoints: son *middleware* previo a la autorización y **solo se montan en Development**. |

`POST /api/v1/auth/logout-all` **no** es anónima (`RequireAuthorization`). La lista está fijada por `EndpointAuthorizationAudit.AnonymousAllowlist` (§5).

## 3. Matriz de recursos protegidos

Inventario real del `EndpointDataSource` (**72** rutas `/api/*` + `/health`; ver §5): **43** en el grupo central del flujo clásico, **13** con dueño en el
repositorio/servicio, **10** sin recurso ajeno que direccionar y **6** anónimas.

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
| Regla de dueño (unidad) | `ProjectRecord.IsAccessibleBy` y `ClassicProjectAccess` por modo, dueño y sesión. | `Projects/ClassicProjectAccessTests.cs`, `Projects/PersistentProjectRegistryTests.cs` |

**Cómo añadir una ruta nueva.** Del flujo clásico: mapearla con path **relativo** dentro de `classicProject` en `Program.cs` (queda protegida sola). De `/api/v2` o sin
recurso: añadirla a la lista blanca de `EndpointAuthorizationAudit` **con su justificación** y, si direcciona un proyecto, a la matriz v2 de `MultiUserIsolationTests`
(`V2Matrix_CoversEveryServiceEnforcedRoute…` lo exige). Una ruta anónima nueva requiere además tocar `AnonymousAllowlist`: es una decisión de revisión.

## 6. Qué no está verificado

- Rendimiento bajo carga real: se verifica por conteo que hay **una** resolución de dueño por request y una sola consulta a `projects` en `/api/v2/projects/{id}`; no se midieron latencias.
- Los E2E de `tests/e2e` solo se ejecutan en `Auth:Mode=Development` (anónimos). Con `Authenticated` esperan 401 sin sesión; adaptarlos a cookie jar es S10.
- Canales fuera de la API (acceso directo a Postgres o al disco `App_Data`, backups) no pasan por esta autorización; su control es operativo.
- Concurrencia entre dos sesiones del mismo usuario sobre el mismo recurso (conflictos `xmin`/409) conserva el comportamiento anterior; no se alteró.
- Tiempo de respuesta como oráculo de existencia (el 404 de un ajeno y de un inexistente del flujo clásico cuestan lo mismo —un lookup en memoria—; en v2 ambos hacen la misma consulta indexada): no medido.
