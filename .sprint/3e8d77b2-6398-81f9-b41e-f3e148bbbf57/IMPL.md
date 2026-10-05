# IMPL.md — M2.2-S10 · Integración E2E de persistencia + backup básico

## Resumen

Décima y última tarjeta de MVP 2.2: verificación + endurecimiento + docs. Spec: `spec.md` de esta
carpeta. Rama apilada sobre `sprint/3e8d77b2-user-ownership` (PR #45 aún abierto al arrancar).

## Qué se entregó

- **Release gate** (`PersistenceReleaseGateTests`): recorre por HTTP upload → paleta → capas →
  dimensiones mm → operaciones CUT/ENGRAVE/IGNORE → Save → **reinicio real** (host nuevo sobre la MISMA
  base Postgres y la MISMA carpeta de datos; sin estado en memoria compartido, motor Python apagado) →
  Open → Edit (PATCH) → autosave con idempotencyKey (replay no duplica) → versiones → Restore → reabrir.
  Compara **bytes** de original, thumbnail y cada SVG, y valores de paleta/layers/IDs/dimensiones/
  operaciones/current version. Cualquier diferencia falla con un mensaje legible
  ("PÉRDIDA O CAMBIO SILENCIOSO DE DATOS en …"). Dos tests de sensibilidad permanentes exigen que el gate
  se ponga rojo si el segundo host apunta a otro storage o a otra base.
- **Fallos recuperables**: `DependencyFailureMiddleware` traduce a **503** con `ApiErrorResponse`
  `database_unavailable` (Postgres caído; solo fallas de conectividad: SQLSTATE 08xxx/53300/57P01-03/
  `NpgsqlException` sin código SQL; una violación de constraint sigue siendo 500; limpia los pools de
  Npgsql para recuperarse sola) y `storage_failure` (`FileStorageException` no traducida).
  `LocalFileStorage.OpenReadAsync` envuelve `IOException`/`UnauthorizedAccessException` en
  `FileStorageException` (igual que Save/Delete); un archivo faltante sigue siendo `FileNotFoundException`.
- **Verificador de consistencia DB↔storage** (solo lectura): modo CLI
  `dotnet Vectorify.Api.dll --check-consistency` (no es un endpoint: nada expuesto en ningún entorno).
  Detecta filas de Asset sin archivo y archivos huérfanos bajo `projects/`; `--verify-checksums`
  compara SHA-256; solo borra con `--delete-orphan-files` (únicamente archivos, edad mínima 10 min).
  Códigos de salida 0/1/2. `Storage/IFileStorageInventory` es una interfaz opcional (no toca
  `IFileStorage`).
- **Migraciones** (`MigrationChainTests`): DB vacía → última migration sin "pending model changes", y
  upgrade desde la migration N-1 con datos sembrados (los datos sobreviven). `LatestMigration`/
  `PreviousMigration` están fijadas a propósito como alarma al agregar una migration.
- **Backup/restore**: `scripts/backup|restore|check-consistency` (`.ps1` y `.sh`), no destructivos por
  defecto (`restore` exige `-Force`/escribir RESTAURAR; sin TTY y sin `-Force` aborta sin tocar nada).
  `docs/BACKUP_RESTORE.md` y `docs/ARQUITECTURA_PERSISTENCIA.md` (modelo, qué vive dónde, flujos,
  invariantes en las que MVP 3 puede confiar y limitaciones heredadas). README y `tests/README.md`
  actualizados.
- **E2E vivo contra Docker**: `tests/e2e/docker_persistence_test.py` (`docker compose up` → guardar →
  `down` SIN `-v` → `up` → reabrir → editar/autosave/restaurar → verificador → opcionalmente
  backup → `down -v` → restore → reabrir). Proyecto Compose propio (`vectorify-s10-e2e-<hex>`) y puertos
  libres; el único `down -v` es sobre ese proyecto; nunca prune. `docker_stack_test.py` recibió
  `POSTGRES_PORT` propio (chocaba con la pila del usuario) y `down -v` de su proyecto aleatorio.
- `backend/.dockerignore` gana `**/App_Data`: sin eso la imagen traía el App_Data local del
  desarrollador (originales, SVG, registros) y esos datos viajaban a los volúmenes nuevos y a los
  respaldos. `.gitattributes` (`*.sh eol=lf`, necesario con `core.autocrlf=true`), `backups/` en
  `.gitignore`.

## Bugs reales encontrados (rojo → verde)

1. **Postgres caído devolvía 500 con stack** (3 de 6 tests rojos antes; incluía la variante sin requests
   durante la caída). Verde con el middleware.
2. **Un storage que lanza al leer (Save y descarga de asset) daba 500.** Rojo
   (`Expected: ServiceUnavailable / Actual: InternalServerError`). Verde con el wrap de `OpenReadAsync`
   + middleware.
3. **Imagen Docker con datos locales dentro** (`App_Data` en el contexto de build): detectado al
   inspeccionar el tamaño del volumen (el tar de un volumen "vacío" pesaba 3.2 MB y pasó a 6 KB).

Sin hueco (comportamiento correcto, ahora cubierto): Save con falla de escritura en storage ya daba 422
sin filas a medias; descarga de asset sin archivo → 404; documento con un SVG faltante abre igual.

## Decisiones menores

- El verificador limita la búsqueda de huérfanos a `projects/` (assets v2): los originales/SVG del
  pipeline clásico no tienen fila de Asset por diseño.
- SVG faltante: el documento abre y solo esa descarga da 404 (sin campo `svgAvailable`, para no tocar
  el contrato del frontend).
- `PaletteColor.Order` se renumera al autoguardar tras reordenar una capa (Save lo deriva del orden de
  capas): mismos colores y coberturas, no es pérdida y no se expone por API; documentado.

## Verificación

Ver el reporte de QA en la tarjeta de Notion y el PR: los 5 comandos corridos de forma independiente por
el orquestador, más la corrida real del E2E vivo y del ciclo backup/restore.
