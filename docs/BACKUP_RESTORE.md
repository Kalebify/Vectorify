# Backup y restore (dev/staging)

Respaldo **mínimo y manual** de la pila Docker Compose de Vectorify. No es infraestructura de producción: sin
cifrado, sin retención, sin respaldos programados, sin restauración a un punto en el tiempo (ver "Límites").

> **DB y storage se respaldan JUNTOS.** El estado de un proyecto vive en dos mitades que se referencian entre sí:
> filas en PostgreSQL (proyectos, versiones, capas, `assets`) y los archivos que esas filas apuntan (SVG, thumbnails,
> originales y registros JSON) en el volumen `vectorify_backend_data`. Respaldar o restaurar solo una de las dos deja
> **filas sin archivo** (un SVG que no se puede descargar) o **archivos sin fila** (huérfanos). Los scripts hacen
> siempre las dos cosas, y `--check-consistency` (más abajo) detecta lo que haya quedado desparejo.

## Qué hay que respaldar

| Qué | Dónde está | Cómo se respalda |
|---|---|---|
| Base de datos (proyectos, versiones, capas, paleta, metadatos y SHA-256 de assets, usuarios, historial de migraciones) | volumen `vectorify_postgres_data` (servicio `postgres`) | `pg_dump -Fc` (lógico, formato custom) |
| Originales, assets/SVG, thumbnails, máscaras/previews y registros clásicos en JSON | volumen `vectorify_backend_data` = `/app/App_Data` del servicio `backend` | `tar.gz` del volumen desde un contenedor efímero |

El nombre real de cada volumen lleva el prefijo del proyecto Compose (`<proyecto>_vectorify_backend_data`): se ve con
`docker volume ls`. No hace falta respaldar imágenes ni el código (se reconstruyen con `docker compose up --build`).

## Scripts

Viven en `scripts/`, hay una variante PowerShell (Windows + Docker Desktop) y una bash de cada uno. Se corren desde
cualquier carpeta; usan `docker compose` sobre el `docker-compose.yml` del repo.

| Script | Qué hace |
|---|---|
| `scripts/backup.ps1` / `scripts/backup.sh` | Crea `<destino>/vectorify-backup-<fecha>/` con `db.dump`, `backend_data.tar.gz` y `manifest.txt` (conteos de filas, versión de Postgres, SHA-256). |
| `scripts/restore.ps1` / `scripts/restore.sh` | Restaura un respaldo sobre la pila. **Destructivo: pide confirmación** (`-Force` / `-f` para omitirla). |
| `scripts/check-consistency.ps1` / `scripts/check-consistency.sh` | Verificador DB↔storage de solo lectura (ver abajo). |

```powershell
# Windows (PowerShell)
.\scripts\backup.ps1                                   # destino por defecto: .\backups   (carpeta ignorada por git)
.\scripts\backup.ps1 -OutDir D:\respaldos
.\scripts\restore.ps1 -BackupDir .\backups\vectorify-backup-20261005-120000          # pide escribir RESTAURAR
.\scripts\restore.ps1 -BackupDir .\backups\vectorify-backup-20261005-120000 -Force   # sin preguntar
```

```bash
# bash (Linux/macOS/Git Bash)
scripts/backup.sh                                      # destino por defecto: ./backups
scripts/backup.sh -o /mnt/respaldos
scripts/restore.sh -b backups/vectorify-backup-20261005-120000                       # pide escribir RESTAURAR
scripts/restore.sh -b backups/vectorify-backup-20261005-120000 -f                    # sin preguntar
```

Garantías de los scripts:

- **`backup`** solo lee (no detiene nada, no borra nada) y **nunca pisa** un respaldo anterior: cada corrida crea su
  propia carpeta con la fecha. Requiere Postgres corriendo.
- **`restore` no hace nada hasta confirmar**: sin `-Force`/`-f` muestra qué va a reemplazar y pide escribir
  `RESTAURAR`; sin consola interactiva y sin `-Force`/`-f` aborta sin tocar nada.
- Ambos aceptan `-ProjectName` (`-p` en bash) o la variable `COMPOSE_PROJECT_NAME` para elegir **qué** proyecto Compose
  respaldar/restaurar. Si la pila se levantó con puertos o variables propios (`POSTGRES_PORT`, `BACKEND_PORT`, ...),
  definí las mismas variables de entorno al correr el script, para que Compose no recree contenedores con otra configuración.
- Son idempotentes en el sentido útil: repetir `backup` solo genera otro respaldo; repetir `restore` deja el mismo estado.

### Orden y motivo

- **Backup**: primero `pg_dump`, después el `tar` del volumen. Así un archivo guardado entre los dos pasos queda como
  archivo sin fila (huérfano inofensivo), nunca como fila sin archivo. Para un respaldo con la API sin tráfico
  (recomendado si se está editando), detené el backend antes: `docker compose stop backend` / `start backend`.
- **Restore**: (1) levanta Postgres y detiene el backend (nadie escribe mientras se restaura); (2) vacía el esquema
  `public` y hace `pg_restore` del dump (incluye `__EFMigrationsHistory`); (3) crea el volumen si no existe, vacía su
  contenido y extrae el tar; (4) levanta toda la pila (`up -d --wait`): el backend aplica las migraciones que falten
  (si el respaldo es de un esquema más viejo) y lee todo del disco y la base.

## Comandos exactos (sin los scripts)

Es lo que hacen los scripts. Todos los `docker compose` se corren desde la raíz del repo (agregá `-p <proyecto>` si
corresponde); `<VOLUMEN>` es `<proyecto>_vectorify_backend_data`.

```bash
# --- BACKUP ---
# 1) Base (el dump se genera dentro del contenedor y se copia en binario; no uses ">" en PowerShell: corrompe el archivo)
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/vectorify.dump'
docker compose cp postgres:/tmp/vectorify.dump ./backups/db.dump
# 2) Volumen App_Data (contenedor efímero; la imagen de Postgres ya está descargada y trae tar)
docker run --rm -v <VOLUMEN>:/data:ro -v "$PWD/backups":/backup postgres:17-alpine \
  tar czf /backup/backend_data.tar.gz -C /data .

# --- RESTORE (pisa lo que haya) ---
docker compose up -d --wait postgres
docker compose stop backend
docker compose cp ./backups/db.dump postgres:/tmp/vectorify.dump
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"'
docker compose exec -T postgres sh -c 'pg_restore --no-owner --exit-on-error -U "$POSTGRES_USER" -d "$POSTGRES_DB" /tmp/vectorify.dump'
docker run --rm -v <VOLUMEN>:/data -v "$PWD/backups":/backup postgres:17-alpine \
  sh -c 'find /data -mindepth 1 -delete && tar xzf /backup/backend_data.tar.gz -C /data'
docker compose up -d --wait
```

## Qué esperar tras restaurar

- Los proyectos guardados aparecen en **Mis proyectos** (`GET /api/v2/projects`) con sus versiones, capas, SVG, thumbnail
  y operaciones; `GET /api/v2/projects/{id}/document` devuelve lo mismo que antes del respaldo (el E2E vivo lo comprueba
  byte a byte).
- El backend arranca solo y aplica cualquier migración pendiente. Los registros clásicos (`App_Data/*.json`) vuelven con el volumen.
- Todo lo que se guardó **después** del respaldo se pierde (no hay punto en el tiempo ni log incremental).
- Se pierde también lo que vive solo en memoria: el historial de configuraciones de preprocesado (el preview ya generado sí está en el volumen).
- Verificá siempre el resultado con el verificador (siguiente sección). Si lo restaurado vino de dos respaldos distintos
  de DB y storage, va a reportar las diferencias.

## Verificador de consistencia DB ↔ storage (solo lectura)

Compara las filas de `assets` con los archivos de `App_Data/uploads/projects/` y lista, sin tocar nada:

- **Assets sin archivo** (fila sin contenido: la descarga da 404; típico de restaurar solo la base o de borrar un archivo a mano);
- **Archivos sin asset** (huérfanos: típico de un Save cortado entre guardar el archivo y su fila, de restaurar solo el
  storage, o de un `.tmp` abandonado);
- con `-VerifyChecksums` / `-v`: **assets con checksum distinto** (el archivo existe pero sus bytes ya no son los subidos; lee todos los archivos).

Los originales y SVG del pipeline clásico (`{projectId}/{imageId}/...`) no tienen fila de `assets` por diseño y no se reportan como huérfanos.

```powershell
.\scripts\check-consistency.ps1                    # solo lectura
.\scripts\check-consistency.ps1 -VerifyChecksums   # + SHA-256 de cada archivo
.\scripts\check-consistency.ps1 -DeleteOrphanFiles # BORRA archivos huérfanos de más de 10 min (nunca filas)
```

```bash
scripts/check-consistency.sh            # -v checksums, -d borrar huérfanos
```

Es un modo de línea de comandos del propio backend (`dotnet Vectorify.Api.dll --check-consistency [--verify-checksums]
[--delete-orphan-files] [--orphan-min-age-minutes=N]`) ejecutado con `docker compose exec` dentro del contenedor: **no es un
endpoint HTTP**, así que no expone nada en ningún entorno. Código de salida: `0` consistente, `1` hay inconsistencias,
`2` no se pudo verificar (base inaccesible, etc.). **No borra nada sin `--delete-orphan-files`**, y aun con el flag solo
borra archivos huérfanos (nunca filas) con más de 10 minutos de antigüedad (un archivo recién subido todavía puede estar
esperando su fila); usalo con la API sin tráfico.

Qué hacer según el reporte: huérfanos → borrarlos con el flag, o ignorarlos (solo ocupan espacio); assets sin archivo →
restaurar el storage del mismo respaldo que la base, o eliminar ese asset/proyecto si el archivo es irrecuperable.

## Probar el ciclo completo (sin riesgo para tus datos)

`tests/e2e/docker_persistence_test.py --backup-cycle` levanta un proyecto Compose **aislado** (nombre
`vectorify-s10-e2e-<hex>` y puertos libres propios), guarda un proyecto, ejecuta `scripts/backup.*`, destruye los volúmenes
de ESE proyecto con `docker compose down -v`, ejecuta `scripts/restore.*` y comprueba que el proyecto se reabre idéntico
(SVG, original y thumbnail byte a byte) y que el verificador queda en verde. Nunca toca otros proyectos Compose ni usa
`docker system prune`/`volume prune`.

```bash
python tests/e2e/docker_persistence_test.py --backup-cycle --shell powershell    # o --shell bash
```

## Límites

- **Manual**: nada se respalda solo; no hay programación ni rotación/retención (borrá los respaldos viejos a mano).
- **Sin cifrado**: `db.dump` y `backend_data.tar.gz` contienen los datos en claro. Guardalos como datos sensibles.
- **Sin punto en el tiempo**: se restaura el instante del respaldo; no hay WAL archivado ni respaldos incrementales.
- **Misma versión mayor de Postgres** (`pg_restore` del dump custom de PG 17 a PG 17). Para cambiar de versión mayor, restaurá en una
  instancia nueva de la versión destino.
- Un respaldo tomado con la API recibiendo escrituras puede incluir archivos sin fila (inofensivos); detené el backend si querés un corte limpio.
- Es para **dev/staging**. Producción (Postgres administrado, object storage, backups programados y cifrados) está fuera de alcance de MVP 2.2.
