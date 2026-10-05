# Arquitectura de la persistencia (MVP 2.2)

Resumen de cómo se guarda, se reabre y se versiona un proyecto de Vectorify tras MVP 2.2 (tarjetas S01–S10), y
**en qué puede confiar MVP 3**. Complementa a `README.md` (arranque, variables) y a `docs/BACKUP_RESTORE.md`
(respaldos). Si algo de acá contradice al código, manda el código: abrí un issue.

## 1. Modelo de datos

```
User ──< Project ──1:1── VectorDocument ──< DocumentVersion ──< Layer >── PaletteColor
              │                                   │               │
              │                                   └── (SvgAssetId)└── SvgAssetId ──> Asset
              ├──< Asset                (assets del proyecto: SVG de capa, thumbnail, ...)
              ├── CurrentVersionId ──> DocumentVersion   (la versión vigente)
              └── ThumbnailAssetId ──> Asset              (best-effort, puede ser null)
```

| Tabla (EF) | Qué guarda |
|---|---|
| `users` | Dueño de los proyectos. Hoy solo el usuario de desarrollo (ver §5). |
| `projects` | Nombre, descripción, `OwnerId`, `CurrentVersionId`, `ThumbnailAssetId`, soft-delete (`DeletedAt`), token de concurrencia (`xmin`) y el **triple clásico** (`ClassicProjectId`/`ClassicImageId`/`ClassicPaletteId`) para reabrir el Workspace desde Mis Proyectos. |
| `vector_documents` | Un documento por proyecto (hoy 1:1). |
| `document_versions` | **Una fila por checkpoint**: `VersionNumber` (1, 2, 3…), dimensiones físicas (`WidthMm`/`HeightMm`), `ViewBox`, `SchemaVersion`, `Origin` (`MANUAL_EDIT`/`RESTORE`/…), `IdempotencyKey`, `MetadataJson`. |
| `layers` | Capas de ESA versión: `GroupId` (estable entre versiones, es el `id` que ve la API), nombre, orden, visible, bloqueada, operación (`Cut`/`Engrave`/`Ignore`/null), `PathCount`, `SvgAssetId`. |
| `palette_colors` | Paleta de ESA versión: `Hex`, `Coverage`, `IsBackground`, `Order`. Cada capa apunta a su color. |
| `assets` | Metadatos de cada archivo guardado: tipo (`layer-svg`, `thumbnail`), `StorageKey`, MIME, tamaño, **SHA-256**. El binario NO está en la base. |

Los cambios de esquema se versionan con migraciones de EF Core que se aplican solas al arrancar la API
(`Database.Migrate()`, nunca `EnsureCreated()`). Las pruebas `MigrationChainTests` recorren toda la cadena sobre una
base vacía y un upgrade N-1 → N con datos.

## 2. Qué vive dónde

| Dato | Dónde | Volumen Docker |
|---|---|---|
| Proyectos, versiones, capas, paleta, metadatos de assets, usuarios | **PostgreSQL** | `vectorify_postgres_data` |
| Binarios de los assets v2 (SVG de cada capa, thumbnail): `projects/{projectId}/{tipo}/{assetId}.{ext}` | **Storage** (`LocalFileStorage`, `App_Data/uploads/`) | `vectorify_backend_data` |
| Original subido (`{projectId}/{imageId}/original.png`), previews, máscaras y SVG de las etapas del pipeline clásico | **Storage** (mismo `App_Data/uploads/`, claves sin prefijo `projects/`) | `vectorify_backend_data` |
| Registros del pipeline clásico en **JSON** (proyecto/imagen, thresholds, vectorizaciones, simplificaciones, dimensiones, paleta de colores, capas, componentes, uniones, operaciones, layout) — sidecars bajo `App_Data/<carpeta>/` | **Disco** (`Persistent*Registry`) | `vectorify_backend_data` |
| Historial de configuraciones de preprocesado | **Memoria** (`InMemoryPreprocessConfigRegistry`): se pierde al reiniciar; el preview ya generado sí está en el storage | — |

Consecuencia clave: **la base y el volumen `vectorify_backend_data` son dos mitades del mismo estado.** Una fila de
`assets` sin su archivo es un SVG que no se puede descargar; un archivo sin fila es un huérfano inofensivo pero que
ocupa espacio. Por eso los respaldos siempre se hacen y se restauran juntos (ver `docs/BACKUP_RESTORE.md`) y existe un
verificador (`--check-consistency`).

El pipeline clásico (`/api/v1/...`: upload → paleta → capas → dimensiones → operaciones) es el **staging** de un
documento: ahí se arma el trabajo, y recién **Save** lo congela en el modelo persistente de arriba. Después de
guardar, el documento se reabre y se edita solo por `/api/v2/...`, sin volver a pasar por Python.

## 3. Flujos

**Save** (`POST /api/v2/workspaces/save`, primer guardado o guardados siguientes)
1. Si trae `idempotencyKey` y ya existe una versión de ese dueño con esa key → devuelve ESA versión (200), no crea nada.
2. Primer Save (`projectId` null): crea el `Project` con el triple clásico. Siguientes: valida que el proyecto sea del usuario.
3. Resuelve el estado clásico vigente del triple (paleta confirmada, capas, layout, operaciones, dimensiones mm) —
   nunca confía en geometría mandada por el cliente.
4. Por cada capa: lee su SVG, lo sube como `Asset` (primero el archivo, después la fila) y arma su `Layer`/`PaletteColor`.
5. Escribe `DocumentVersion` + capas + paleta **en una transacción** y repunta `Project.CurrentVersionId`.
6. Solo en el primer Save, y después de confirmado: genera el thumbnail (best-effort).
Si algo falla antes del paso 5 no queda ningún documento a medias; un primer Save fallido descarta (soft-delete) el
proyecto creado para que no aparezca vacío en Mis Proyectos.

**Open** (`GET /api/v2/projects/{id}/document`): lee la versión vigente (capas ordenadas, paleta, dimensiones). Cada capa
trae `svgUrl` para descargar su SVG por `GET /api/v2/projects/{id}/assets/{assetId}`. Abrir **no** toca el storage:
si el archivo de una capa falta, el documento abre igual y esa descarga responde 404 (la señal de "SVG perdido").

**Edit** (`PATCH /api/v2/projects/{id}/layers/{layerId}`): nombre / orden / visible / bloqueada / operación. **Cada PATCH
es un checkpoint**: crea una `DocumentVersion` completa nueva con el cambio (reusa los mismos `Asset`), nunca muta la versión actual.

**Autosave**: en una sesión *sin guardar todavía* el Workspace dispara un Save automático (debounce de 2 s) con una
`idempotencyKey` por intento — un reintento por red lenta no duplica versiones. Una vez guardado, cada edición va por PATCH.

**Versiones**: `GET .../versions` (lista, más nueva primero), `GET .../versions/{n}` (cualquiera, completa).
**Restore** (`POST .../versions/{n}/restore`): copia fresca de esa versión como versión NUEVA (`Origin = RESTORE`), repunta
`CurrentVersionId`; no borra ni modifica ninguna versión intermedia. Reusa los mismos `Asset`.

## 4. Invariantes en las que MVP 3 puede confiar

1. **Las versiones son inmutables.** Una `DocumentVersion` (y sus capas/paleta) nunca se modifica después de creada;
   Save, PATCH y Restore **agregan** una versión nueva. `VersionNumber` es secuencial por documento y no se reutiliza.
2. **Restore crea una versión nueva** con el contenido de la elegida; la historia queda completa.
3. **`Project.CurrentVersionId` siempre apunta a una versión existente** del propio proyecto cuando hay documento guardado.
4. **Ownership por Project.** Todo se resuelve por el dueño del proyecto (`IUserContext`): proyecto/versión/asset de otro
   usuario responde el mismo 404 que uno inexistente (nunca 403). Los assets heredan el dueño de su proyecto.
5. **Idempotencia por dueño.** La `idempotencyKey` se guarda prefijada con el dueño (`{ownerId}:{key}`): dos usuarios con la
   misma key no colisionan ni se ven.
6. **Los IDs de capa son estables entre versiones** (`Layer.GroupId`, lo que la API expone como `id`); la PK real de la fila cambia en cada versión.
7. **Integridad de assets.** Cada `Asset` guarda el SHA-256 de lo escrito; el verificador lo contrasta con los bytes del storage.
8. **Fallos controlados.** Postgres caído → `503 database_unavailable`; storage que no responde → `503 storage_failure`;
   ambos con `ApiErrorResponse`, sin stack. La API se recupera sola cuando el servicio vuelve (sin reiniciar).
9. **Thumbnail best-effort.** Su ausencia o fallo nunca hace fallar un Save ni impide abrir el proyecto (`thumbnailUrl` puede ser null).
10. **Sobrevive a reinicios** (`docker compose down`/`up` conservando volúmenes): comprobado por el release gate
    (`PersistenceReleaseGateTests`, byte a byte) y por el E2E vivo contra Docker (`tests/e2e/docker_persistence_test.py`).

## 5. Identidad de usuario (desarrollo)

Aún no hay login (MVP 3.1). `IUserContext` se resuelve con `DevelopmentUserContext`: **siempre el mismo usuario**
configurable (`DevelopmentUser:UserId`/`Email`/`DisplayName`, por defecto `00000000-0000-0000-0000-000000000001`),
sembrado en `users` al arrancar. Su registro vive en un solo lugar (`UserContextRegistration`) que **falla el arranque
fuera de los entornos `Development`/`Testing`/`Test`**: no se puede desplegar sin reemplazarlo por una implementación
autenticada. El resto del código ya depende de `IUserContext`, no del usuario fijo.

## 6. Limitaciones conocidas

- **El pipeline clásico no tiene dueño por etapa** (preprocess, threshold, vectorize, simplify, check, export, componentes…).
  Solo el *upload* tiene dueño desde S09 (y un registro anterior sin dueño sigue accesible). Las etapas siguen abiertas dentro del proyecto clásico.
- **Assets compartidos por `StorageKey` tras Duplicate.** Duplicar un proyecto crea filas de `Asset` propias que apuntan al
  MISMO archivo; borrar el asset de uno solo borra la fila (el archivo se conserva mientras otra fila lo use).
- **Sin backfill de proyectos previos.** Los proyectos del flujo clásico anteriores a MVP 2.2 no se migran a Postgres ni
  tienen triple clásico (no se pueden "reabrir desde Mis Proyectos"); solo existen los guardados con Save desde S05.
- **Thumbnail = original reducido** (≤ 320 px), no un render del SVG (no hay rasterizador de SVG en el backend).
- **Las dimensiones físicas las manda el cliente en cada Save** (`dimensionId`): un Save sin `dimensionId` vuelve al
  default 1 px = 1 mm; PATCH y Restore las copian de la versión de origen.
- **`PaletteColor.Order` refleja el orden de las capas en el momento de un Save**; PATCH y Restore copian la paleta tal cual
  (reordenar una capa y volver a guardar renumera el orden de la paleta; los colores y coberturas no cambian).
- **Un Save que falla a mitad de subir los SVG** deja subidos los de las capas anteriores (fila + archivo) colgando de un
  proyecto descartado; no es una inconsistencia DB↔storage (el verificador no los marca) y no se ven desde la API.
- **Tras reiniciar Postgres sin que nadie toque la API**, las conexiones ociosas del pool quedan muertas: la primera request
  puede dar un 503 controlado y la siguiente ya funciona (la API vacía el pool al detectar la caída).
- **Backups manuales**, sin cifrado, sin retención ni punto en el tiempo (ver `docs/BACKUP_RESTORE.md`). Storage solo local
  (S3/MinIO diferido): `IFileStorage` ya es la costura para sustituirlo.
- Los SVG de cada Save se **suben de nuevo** como assets nuevos (mismos bytes, otro `assetId`); Restore/PATCH, en cambio, reusan los existentes.
