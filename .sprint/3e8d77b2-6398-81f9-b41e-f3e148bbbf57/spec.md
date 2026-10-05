# spec.md — M2.2-S10 · Integración E2E de persistencia + backup básico

## Contexto

Décima y última tarjeta de MVP 2.2: **cerrar el milestone verificando que lo construido en S01–S09
funciona junta y sobrevive a reinicios**. Es una tarjeta de *verificación + endurecimiento + docs*:
poca funcionalidad nueva; si la verificación encuentra un bug real, **se corrige en esta tarjeta** (y
se reproduce primero con un test rojo). Criterio (Notion): "Create → Upload → Vectorize → Colors/
Layers → Save → restart stack → Open → Edit → Autosave → Version → Restore funciona sin pérdida de
datos." DoD: "MVP 3 puede asumir que Project y VectorDocument son persistentes."

Estado de partida (rama apilada sobre `sprint/3e8d77b2-user-ownership`, PR #45 aún abierto): existen
Postgres+EF+migrations (S01), modelo (S02), CRUD v2 (S03), Assets/IFileStorage local (S04),
Save/reapertura (S05), versionado+restore+PATCH inmutable (S06), autosave+idempotencia (S07),
Mis Proyectos (S08), ownership (S09). `docker-compose.yml` ya define volúmenes nombrados
`vectorify_postgres_data` (Postgres) y `vectorify_backend_data` (App_Data: originales, SVG/assets,
registros clásicos en JSON). Ya existe `tests/e2e/docker_stack_test.py` (levanta la pila con Docker) y
`frontend/spike-editor-engine/scripts/run-mvp21-live-qa.mjs`: **leelos antes de escribir** y extendé en
vez de duplicar.

## 1. E2E automatizado en el backend (release gate — Testcontainers, sin InMemory)

Un test de integración "release gate" (uno o pocos tests grandes, nombrados claramente, p. ej.
`PersistenceReleaseGateTests`) que recorre por HTTP, con la factory real, el camino completo:
upload → detección/confirmación de paleta → capas → (dimensiones mm) → asignar operaciones
(CUT/ENGRAVE/IGNORE, al menos las tres presentes) → **Save** (primer Save crea Project) →
**"reinicio"**: dispone la factory y levanta una NUEVA sobre **la misma base Postgres y la misma raíz
de storage/registros en disco** (simula `docker compose down/up` conservando volúmenes; nada en memoria
sobrevive) → **Open** (`GET /document`, descarga de cada SVG por `SvgUrl`, thumbnail, listado en
`/api/v2/projects`) → **Edit** (PATCH de layer: rename/visible/lock/operation/orden) → autosave
(Save con idempotencyKey; replay no duplica) → **lista de versiones** → **Restore** de una versión
anterior (crea versión nueva, no borra historia) → reabrir de nuevo.
Verificar en cada punto, comparando contra lo guardado ANTES del reinicio: original (descargable y
mismos bytes), SVG por capa (mismos bytes), paleta (hex/coverage/orden), layers (Ids = groupId, name,
order, visible, locked, pathCount), dimensiones mm (width/height/viewBox), operaciones
CUT/ENGRAVE/IGNORE por capa, current version y número de versión, thumbnail presente y descargable.
"Cero pérdida silenciosa": cualquier diferencia debe hacer fallar el test con un mensaje legible.

## 2. Fallos recuperables

Auditar y cubrir con tests (si hay un hueco: test rojo → fix):
- **DB no disponible** (Postgres detenido/conexión inválida): los endpoints v2 responden un error
  controlado y estable (p. ej. 503 con `ApiErrorResponse` y `code` claro), nunca 500 con stack ni
  respuesta colgada; `/api/v1/system/health` lo refleja (ya lo hace); la API se recupera sola cuando
  Postgres vuelve (sin reiniciar el proceso).
- **Storage no disponible** (escritura/lectura falla): Save devuelve error controlado y NO deja filas a
  medias (Project/DocumentVersion/Layer sin assets); la descarga de un asset cuyo archivo falta da 404
  uniforme (ya existe) y un documento con un SVG faltante **se puede abrir igual** (la capa informa que
  su SVG no está, no se rompe todo el documento) — verificar el comportamiento actual y, si rompe,
  corregir de forma mínima.
- **Archivo huérfano** (archivo en storage sin fila de Asset, o fila sin archivo): documentar el
  comportamiento y agregar un **verificador** mínimo de consistencia (ver §4) que los detecte y los
  reporte (solo lectura por defecto; no borra nada sin flag explícito).

## 3. Migraciones

- **DB vacía → última migration**: aplica limpio y el modelo queda consistente con el snapshot
  (sin "pending model changes").
- **Upgrade desde la migration anterior con datos**: migrar hasta la migration previa a la última,
  sembrar datos representativos (Project con versiones/capas/assets), aplicar la última y verificar que
  los datos siguen intactos. Ya existen tests de migraciones puntuales en `Vectorify.Api.Tests/Migrations`
  (S06, S08): reusá su infraestructura; generalizá con un test que recorra **todas** las migraciones en
  orden sobre una DB vacía y uno de "upgrade desde N-1".

## 4. Backup/restore mínimo (dev/staging) — documentar y verificar de verdad

No construir infraestructura enterprise. Entregar:
- `docs/BACKUP_RESTORE.md` (en español, como el resto de la documentación): qué hay que respaldar
  (Postgres + volumen `vectorify_backend_data`/App_Data = originales, assets, registros clásicos),
  **comandos exactos** de backup y restore (p. ej. `pg_dump -Fc` vía `docker compose exec`, y copia del
  volumen vía un contenedor efímero con `tar`), orden de restauración, qué esperar tras restaurar,
  límites (sin cifrado, sin retención, sin point-in-time) y la advertencia de que DB y storage deben
  respaldarse **juntos** (un respaldo de uno solo deja referencias huérfanas).
- Scripts mínimos y simples (PowerShell y/o bash; el dueño trabaja en Windows con Docker Desktop):
  `scripts/backup.*` y `scripts/restore.*`, parametrizables por carpeta destino. Deben ser **idempotentes
  y no destructivos por defecto**: restore pide confirmación explícita o flag `-Force` antes de pisar
  datos.
- Verificador de consistencia DB↔storage (solo lectura): p. ej. un modo `--check` (o comando en
  `scripts/`) que liste Assets sin archivo y archivos sin Asset. Puede ser un endpoint interno solo en
  Development o un pequeño comando; elegí lo más simple que no exponga nada en Production. Documentarlo.
- **Verificación real** (no solo texto): con Docker disponible, ejecutar backup → destruir los volúmenes
  (`docker compose down -v`) → restore → comprobar que el proyecto guardado se reabre. Registrar la
  salida real en IMPL.md. Si Docker no está disponible, decirlo explícitamente (no fingir).

## 5. E2E vivo contra la pila Docker (reinicio real)

Extender `tests/e2e/docker_stack_test.py` (o un script hermano, según lo que ya haya) para que, con
Docker disponible, haga el ciclo REAL: `docker compose up` → crear/guardar un proyecto por HTTP →
`docker compose down` (**sin `-v`**, conservando volúmenes) → `up` → verificar que el proyecto aparece
en `GET /api/v2/projects` y que `GET /document` + descarga de SVG/thumbnail devuelven lo mismo → editar
(PATCH), guardar nueva versión, restaurar. Puede usar la imagen/archivo de prueba que ya usan los tests.
Correrlo una vez de verdad y pegar el resultado en IMPL.md. Mantenerlo fuera de la suite por defecto si
tarda mucho o requiere Docker (como ya hace el repo con los E2E de Docker).

## 6. Docs

- `README.md`: sección de persistencia/backup/restore y cómo correr el E2E; ajustar lo que haya quedado
  desactualizado tras S01–S09 (Mis Proyectos como landing, `?view=new`, usuario de desarrollo y su
  guardrail, `DevelopmentUser`).
- Un documento de arquitectura breve (`docs/ARQUITECTURA_PERSISTENCIA.md` o sección en el README):
  diagrama textual del modelo (User → Project → VectorDocument → DocumentVersion → Layer/PaletteColor/
  Asset), qué vive en Postgres vs. en storage vs. en registros clásicos JSON (staging), flujo
  Save/Open/Autosave/Restore, e **invariantes** en las que MVP 3 puede confiar (versiones inmutables,
  restore crea versión nueva, ownership por Project, idempotencia por owner, thumbnail best-effort) y
  **limitaciones conocidas** heredadas (pipeline clásico sin dueño, Assets compartidos por StorageKey
  tras Duplicate, sin backfill de proyectos previos, thumbnail = original reducido).

## Fuera de alcance
Object Storage real (S3/MinIO), backups automáticos/programados/cifrados, restore point-in-time, HA,
cambios de producto en el frontend, login real, ownership de las etapas del pipeline clásico.

## Tests / verificación exigidos
`dotnet build` (0 errores/warnings), `dotnet test` (suite completa), `pytest` (services/python-engine,
sin tocar salvo que extiendas `tests/e2e` en Python), `npm test`, `npm run build`, MÁS la corrida real
del E2E vivo contra Docker (§5) y del ciclo backup→destruir→restore (§4).

## Release gate (Notion)
"Cero pérdida silenciosa de datos en happy path; tests críticos verdes; README/arquitectura actualizados."
