# Vectorify

Base ejecutable, testeable y reproducible sobre la que se construyen los MVP
de vectorización. Estado actual:

- **M1-S01**: el "esqueleto" y la comunicación entre los tres servicios.
- **M1-S02**: primer flujo funcional de entrada — cargar una imagen
  (PNG/JPG/WEBP) crea un proyecto y guarda el original sin procesarlo.
- **M1-S03**: preprocesamiento de imagen (escala de grises, contraste,
  brillo, reducción de ruido) con OpenCV en el motor Python, orquestado por
  la Web API, con preview cacheado por parámetros. Ver más abajo.
- **M1-S04**: threshold B/N (umbral global, con inversión opcional) sobre el
  preview ya preprocesado, con métricas de porcentaje foreground/background
  y advertencia de máscara "casi vacía/casi llena".
- **M1-S05**: vectorización raster → SVG con VTracer, sobre la máscara B/N ya
  generada por threshold. Ver más abajo.
- **M1-S06**: visualizador del SVG resultante (`VectorCanvas`) con zoom/pan y
  comparación contra el raster de origen. Ver más abajo.
- **M1-S07**: simplificación de nodos (Douglas-Peucker) sobre el SVG ya
  vectorizado, con presets Bajo/Medio/Alto, preview reversible y aplicar que
  crea una nueva versión. Ver más abajo.
- **M1-S08**: Laser Checker de paths abiertos y duplicados/casi-duplicados,
  análisis de solo lectura con panel de issues y resaltado en el canvas. Ver
  más abajo.
- **M1-S09**: dimensiones físicas en mm sobre un SVG ya vectorizado o
  simplificado, con proporción bloqueada/desbloqueada. Ver más abajo.
- **M1-S10**: exportación (descarga) del SVG de cualquier etapa ya generada
  del pipeline, sin modificar su geometría. Ver más abajo.
- **M1-S11**: gate de calidad/integración del MVP 1 — dataset de imágenes
  reales y automatización E2E que ejercita el pipeline completo (upload →
  preprocesamiento → threshold → vectorización → simplificación → Laser
  Checker → dimensiones → export) vía HTTP contra la pila real, sin agregar
  features nuevas. Ver "Flujo E2E completo" más abajo.
- **M2.2-S01**: primera tarjeta de MVP2.2 — introduce PostgreSQL/EF Core como
  base de datos relacional real del proyecto (antes toda la persistencia era
  en memoria o sidecars de archivos JSON, que siguen sin tocarse). Migración
  inicial mínima aplicada automáticamente al arrancar, health check extendido
  y tests de integración contra una PostgreSQL real y efímera (Testcontainers).
  Ver "PostgreSQL + EF Core" más abajo.
- **M2.2-S02 a S10** (cierre de MVP 2.2, "Project y VectorDocument persistentes"):
  modelo relacional (`User → Project → VectorDocument → DocumentVersion →
  Layer/PaletteColor/Asset`), CRUD de proyectos (`/api/v2/projects`), Assets con
  `IFileStorage`, **Save/reapertura** del documento, **versionado inmutable +
  Restore**, **autosave idempotente**, **Mis proyectos** como landing, **ownership**
  por usuario, y en S10 la verificación de punta a punta: release gate de
  persistencia con reinicio real, fallos recuperables (Postgres/storage caídos →
  503 controlado), cadena de migraciones, **backup/restore** y un verificador de
  consistencia DB↔storage. Ver "Persistencia, backup y restore" más abajo,
  `docs/ARQUITECTURA_PERSISTENCIA.md` y `docs/BACKUP_RESTORE.md`.

## Arquitectura

```
React (TypeScript + Vite)  --HTTP-->  ASP.NET Core Web API  --HTTP-->  Python + FastAPI
      frontend/                            backend/                services/python-engine/
```

Regla no negociable: **el navegador nunca llama directamente a Python.** Todo
pasa por la Web API de ASP.NET Core, que expone un cliente tipado
(`IPythonVectorizationClient`, vía `IHttpClientFactory`) hacia FastAPI y
compone un estado global (`online` / `degraded`) que consume React.

Como React y la Web API se sirven en orígenes distintos (puertos 5173 y 5080),
la Web API aplica una política CORS con los orígenes configurados en
`Cors__AllowedOrigins`. Si abres React desde otra URL o puerto, añádela ahí.

- **Frontend** (`frontend/`): React + TypeScript + Vite. Diagnóstico
  ("Home/Diagnostics") que consulta el estado de la Web API y del motor
  Python cada 5 segundos (`loading`, `online`, `degraded`, `error`), más el
  flujo de carga de imagen (M1-S02) y el panel de preprocesamiento (M1-S03)
  una vez que hay un proyecto creado.
- **Backend/orquestador** (`backend/`): ASP.NET Core Web API (Minimal APIs).
  Expone `/health` (liveness propio), `/api/v1/system/health` (estado
  compuesto) y `/api/v1/projects` (M1-S02: crea un proyecto a partir de una
  imagen y expone su original en `/api/v1/projects/{id}/images/{id}/original`).
  Nunca deja de responder aunque Python esté caído: si Python falla, el estado
  global pasa a `degraded` en vez de que la API se rompa.
- **Motor de procesamiento** (`services/python-engine/`): Python + FastAPI.
  Expone `/health`, `/api/v1/info`, `/api/v1/preprocess` (M1-S03: pipeline
  determinista con OpenCV — escala de grises, contraste, brillo, denoise),
  `/api/v1/threshold` (M1-S04: umbral B/N global con inversión opcional),
  `/api/v1/vectorize` (M1-S05: trazado raster → SVG con VTracer, encapsulado
  detrás de `app.core.vector_engine`, con el SVG resultante sanitizado por
  `app.core.svg_processing` antes de devolverlo — ver "Vectorización" más
  abajo), `/api/v1/simplify` (M1-S07: reducción de nodos con Douglas-Peucker
  sobre un SVG ya vectorizado, ver "Simplificación de nodos" más abajo) y
  `/api/v1/check` (M1-S08: Laser Checker de solo lectura, paths abiertos y
  duplicados, ver "Laser Checker" más abajo). Estructura por `api/`,
  `services/`, `models/` y `core/`.

## Requisitos

- [.NET SDK 9.0](https://dotnet.microsoft.com/download) (backend)
- [Node.js 24.x](https://nodejs.org/) y npm (frontend)
- [Python 3.12+](https://www.python.org/) (motor)
- [Docker](https://www.docker.com/) + Docker Compose (para levantar todo junto, incluyendo
  PostgreSQL) -- también requerido para correr `dotnet test` desde M2.2-S01 (Testcontainers
  levanta una PostgreSQL real y efímera para los tests de integración)

## Arranque con Docker (recomendado)

```bash
cp .env.example .env
docker compose up --build
```

Con la configuración por defecto:

- Frontend: http://localhost:5173
- Backend (Web API): http://localhost:5080 (`/health`, `/api/v1/system/health`, Swagger en `/swagger`)
- Motor Python: http://localhost:8001 (`/health`, `/api/v1/info`, docs en `/docs`)
- PostgreSQL: `localhost:5432` (puerto publicado solo para inspección manual con un
  cliente externo, ej. `psql`/pgAdmin; la Web API se conecta por el nombre de servicio
  interno `postgres`, ver "PostgreSQL + EF Core" más abajo)

`docker-compose.yml` monta un volumen nombrado (`vectorify_backend_data`) en
`/app/App_Data` del contenedor `backend`, así que los originales
(`LocalFileStorage`) y los sidecars de metadata de proyecto/threshold/
vectorización/simplificación (`PersistentProjectRegistry`,
`PersistentThresholdConfigRegistry`, `PersistentVectorVersionRegistry`,
`PersistentSimplificationVersionRegistry`) sobreviven a `docker compose
down`/restart. El Laser Checker (M1-S08) no tiene registro propio: es de
solo lectura y no persiste ningún resultado. Desde M2.2-S01, otro volumen
nombrado (`vectorify_postgres_data`) cumple el mismo rol para los datos de
PostgreSQL -- ver "PostgreSQL + EF Core" más abajo.

Abrir http://localhost:5173 muestra **Mis proyectos** (la landing por defecto
desde M2.2-S08): la lista de proyectos guardados, con thumbnail, y desde ahí se
reabren, duplican o eliminan. El flujo clásico de carga ("Nuevo proyecto": upload
→ paleta → capas → Workspace, más el diagnóstico de servicios) vive en
**http://localhost:5173/?view=new**; en esa pantalla debería verse "API Online" y
"Python Online".

Todavía no hay login: toda la API actúa como un único **usuario de desarrollo**
(`DevelopmentUser__UserId`/`Email`/`DisplayName`, por defecto
`00000000-0000-0000-0000-000000000001`), que la API siembra en la tabla `users` al
arrancar. Esa identidad fija solo se activa en los entornos `Development`,
`Testing` y `Test`: en cualquier otro (`Production`, `Staging`...) la API **se
niega a arrancar** hasta que MVP 3.1 aporte un `IUserContext` autenticado (ver
`docs/ARQUITECTURA_PERSISTENCIA.md`). El `Dockerfile` del backend fija
`ASPNETCORE_ENVIRONMENT=Development`; `docker-compose.yml` lo expone como
`ASPNETCORE_ENVIRONMENT` (default `Development`).

Para probar la recuperación ante fallos:

```bash
docker compose stop python-engine   # React debe mostrar Python offline/degradado; el backend sigue respondiendo
docker compose start python-engine  # React debe volver a mostrar Python online
```

## Arranque en local (sin Docker)

En tres terminales separadas:

```bash
# 1) Motor Python
cd services/python-engine
python -m venv .venv
.venv/Scripts/activate        # en Windows; en Linux/macOS: source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8001

# 2) Backend
cd backend/Vectorify.Api
# Postgres__ConnectionString no tiene default en appsettings.*.json (ver "PostgreSQL +
# EF Core" más abajo) -- si querés migraciones automáticas/health check en online
# corriendo así, sin Docker, exportá la variable primero apuntando a una PostgreSQL
# real (por ejemplo, la de `docker compose up postgres` en el puerto publicado):
# export Postgres__ConnectionString="Host=localhost;Port=5432;Database=vectorify;Username=vectorify;Password=vectorify_dev_password"
# Sin esa variable, la API arranca igual (omite la migración, Postgres queda "unavailable"
# en el health check) -- mismo criterio de tolerancia a fallos que el motor Python.
dotnet run
# Sirve en http://localhost:5080 (ver Properties/launchSettings.json).
# PythonEngine:BaseUrl por defecto en appsettings.json apunta a http://localhost:8001.

# 3) Frontend
cd frontend
cp .env.example .env
npm install
npm run dev
# Sirve en http://localhost:5173 (o el puerto que informe Vite).
```

## Tests

```bash
# Backend (xUnit): cliente Python, integración HTTP con motor simulado,
# validación/almacenamiento/dimensiones, el endpoint de carga de imágenes,
# los registros persistentes de proyecto/threshold/vectorización/
# simplificación y los endpoints de preprocesamiento (M1-S03),
# threshold (M1-S04), vectorización (M1-S05), simplificación de nodos
# (M1-S07) y el Laser Checker de paths (M1-S08). Desde M2.2-S01 también
# incluye tests contra una PostgreSQL real y efímera vía Testcontainers
# (migraciones, round-trip de escritura/lectura, health check) -- REQUIERE
# Docker disponible y tarda más que antes por eso mismo.
cd backend
dotnet test

# Motor Python (pytest)
cd services/python-engine
pip install -r requirements-dev.txt
pytest

# Smoke HTTP (con la pila arriba, Docker o local; no verifica la UI)
BACKEND_URL=http://localhost:5080 PYTHON_URL=http://localhost:8001 \
  bash tests/e2e/smoke-test.sh

# E2E de carga de imágenes (M1-S02): arranca solo la Web API real (Python no
# participa en este sprint) y ejercita HTTP real de carga válida e inválida.
dotnet build backend/Vectorify.sln
node tests/e2e/upload_e2e_test.mjs

# E2E del pipeline completo (M1-S11): requiere la pila YA arriba (backend
# :5080, motor Python :8001, ver "Arranque en local" arriba o Docker) --
# a diferencia del E2E de arriba, este NO levanta los servicios. Sube 6
# fixtures reales (tests/e2e/fixtures/) y ejercita upload -> preview ->
# threshold -> vectorize -> simplify -> check -> dimensions -> export.
BACKEND_URL=http://localhost:5080 node tests/e2e/full_pipeline_e2e_test.mjs
```

Desde `frontend/`, ejecutar `npm ci`, `npm test`, `npm run build` y `npm run lint`.
Para verificar FastAPI real, desde la raíz y con el entorno Python activo:
`dotnet build backend/Vectorify.sln` y `python tests/e2e/real_stack_test.py`.
Con Docker disponible: `python tests/e2e/docker_stack_test.py` construye una pila
isolada y verifica health, CORS y recuperación. Para smoke sin Bash:
`python tests/e2e/smoke_test.py`.

**Persistencia (M2.2-S10)** — dos niveles:

```bash
# 1) Release gate automatizado (dentro de `dotnet test`, Docker requerido para Testcontainers):
#    upload -> paleta -> capas -> mm -> operaciones -> Save -> REINICIO (host nuevo sobre la misma
#    base y la misma carpeta de datos) -> Open -> Edit -> Autosave -> versiones -> Restore -> reabrir.
dotnet test backend/Vectorify.sln --filter "FullyQualifiedName~PersistenceReleaseGateTests"
#    Fallos recuperables, migraciones y verificador de consistencia:
dotnet test backend/Vectorify.sln --filter "FullyQualifiedName~PersistenceFailureModesTests|FullyQualifiedName~MigrationChainTests|FullyQualifiedName~StorageConsistencyCheckerTests"

# 2) E2E VIVO contra la pila Docker real (fuera de la suite por defecto: tarda minutos y construye imágenes).
#    Levanta un proyecto Compose AISLADO (nombre y puertos propios), guarda un proyecto, hace
#    `docker compose down` SIN -v + `up`, y comprueba que todo (SVG, original, thumbnail) vuelve idéntico;
#    luego edita, autoguarda, restaura y corre el verificador de consistencia.
python tests/e2e/docker_persistence_test.py
#    Con --backup-cycle añade backup -> `down -v` (solo de ese proyecto aislado) -> restore -> reabrir:
python tests/e2e/docker_persistence_test.py --backup-cycle --shell powershell   # o --shell bash
```

Ver `tests/README.md` para cobertura, comandos y resultados. **Docker y la
comprobación en navegador real siguen pendientes de verificación**; los tests
de React usan jsdom. El estado administrativo Done no acredita esos criterios.

## Persistencia, backup y restore (MVP 2.2)

Qué sobrevive a un `docker compose down`/`up` (sin `-v`) y cómo se respalda — el modelo completo, los flujos
Save/Open/Autosave/Restore y las invariantes en `docs/ARQUITECTURA_PERSISTENCIA.md`:

| Estado | Dónde | Volumen |
|---|---|---|
| Proyectos, versiones, capas, paleta, metadatos de assets | PostgreSQL | `vectorify_postgres_data` |
| Original subido, SVG de capas, thumbnails, registros JSON del pipeline clásico | `App_Data/` del backend | `vectorify_backend_data` |

- **Reiniciar la pila sin perder nada**: `docker compose down` y `docker compose up -d`. **`docker compose down -v`
  BORRA ambos volúmenes** (todos los proyectos): usalo solo si querés empezar de cero o inmediatamente antes de un restore.
- **Backup / restore** (dev/staging, manual): `scripts/backup.ps1|sh` crea una carpeta con `db.dump` (pg_dump) y
  `backend_data.tar.gz` (el volumen); `scripts/restore.ps1|sh` los restaura y **pide confirmación** (`-Force`/`-f` para
  omitirla). **La base y el storage se respaldan y restauran juntos**: uno solo deja referencias huérfanas. Comandos
  exactos, orden, qué esperar y límites (sin cifrado, retención ni punto en el tiempo) en `docs/BACKUP_RESTORE.md`.
- **Verificador de consistencia** DB↔storage (solo lectura; lista assets sin archivo y archivos huérfanos):
  `scripts/check-consistency.ps1|sh` (`-VerifyChecksums` además compara SHA-256). No es un endpoint HTTP: corre dentro del contenedor.
- **Fallos controlados**: con PostgreSQL caído los endpoints v2 responden `503` con `{"code":"database_unavailable",...}` (el
  health lo refleja como `degraded`) y la API se recupera sola cuando vuelve; si el storage no responde, `503` con
  `{"code":"storage_failure",...}`. Nunca un 500 con stack.
- **Cómo correr el E2E**: ver "Tests" arriba (`dotnet test` para el release gate automatizado con reinicio real, y
  `python tests/e2e/docker_persistence_test.py [--backup-cycle]` para el E2E vivo contra Docker).

## Variables de entorno

Cada servicio tiene su propio `.env.example`; la raíz tiene uno adicional
que alimenta `docker-compose.yml`. Ningún archivo `.env.example` contiene
secretos reales.

| Variable | Dónde | Default | Qué controla |
|---|---|---|---|
| `VITE_API_BASE_URL` | `frontend/.env` | `http://localhost:5080` | URL de la Web API que usa el navegador |
| `PythonEngine__BaseUrl` | `backend` (appsettings o env) | `http://localhost:8001` | URL del motor Python vista por ASP.NET Core |
| `PythonEngine__TimeoutSeconds` | `backend` (appsettings o env) | `5` | Timeout del cliente HTTP hacia Python |
| `Cors__AllowedOrigins` | `backend` (appsettings o env) | `http://localhost:5173,http://127.0.0.1:5173` | Orígenes del navegador (separados por comas) autorizados a llamar a la Web API |
| `Upload__MaxFileSizeBytes` | `backend` (appsettings o env) | `15728640` (15 MB) | Tamaño máximo aceptado en `POST /api/v1/projects` (supuesto: el spec no cuantifica un límite) |
| `Upload__AllowedContentTypes` | `backend` (appsettings o env) | `image/png,image/jpeg,image/webp` | MIME types aceptados en `POST /api/v1/projects` |
| `Storage__RootPath` | `backend` (appsettings o env) | `App_Data/uploads` | Carpeta local donde `LocalFileStorage` guarda los originales y los previews de M1-S03 (nunca se versiona) |
| `ProjectRegistry__RootPath` | `backend` (appsettings o env) | `App_Data/projects` | Carpeta donde `PersistentProjectRegistry` guarda un sidecar JSON por proyecto (nunca se versiona) |
| `Preprocess__MinContrast` / `Preprocess__MaxContrast` | `backend` (appsettings o env) | `0.5` / `3.0` | Rango válido de `contrast` en `POST .../preview` (supuesto: el spec no cuantifica valores) |
| `Preprocess__MinBrightness` / `Preprocess__MaxBrightness` | `backend` (appsettings o env) | `-100` / `100` | Rango válido de `brightness` en `POST .../preview` |
| `Preprocess__MinDenoise` / `Preprocess__MaxDenoise` | `backend` (appsettings o env) | `0` / `10` | Rango válido de `denoise` en `POST .../preview` |
| `Preprocess__TimeoutSeconds` | `backend` (appsettings o env) | `20` | Timeout del cliente HTTP hacia Python al generar un preview |
| `ThresholdRegistry__RootPath` | `backend` (appsettings o env) | `App_Data/thresholds` | Carpeta donde `PersistentThresholdConfigRegistry` guarda un sidecar JSON por configuración de threshold (nunca se versiona) |
| `Vectorize__MaxSvgResponseBytes` | `backend` (appsettings o env) | `10485760` (10 MB) | Segunda barrera de tamaño, del lado de `PythonVectorizeClient`, sobre el SVG que devuelve el motor Python (defensa en profundidad además del límite que ya aplica Python) |
| `VectorRegistry__RootPath` | `backend` (appsettings o env) | `App_Data/vectors` | Carpeta donde `PersistentVectorVersionRegistry` guarda un sidecar JSON por versión de vectorización (nunca se versiona) |
| `Simplification__TimeoutSeconds` | `backend` (appsettings o env) | `20` | Timeout del cliente HTTP hacia Python al simplificar |
| `Simplification__MaxSvgResponseBytes` | `backend` (appsettings o env) | `10485760` (10 MB) | Segunda barrera de tamaño sobre el SVG simplificado que devuelve Python, mismo criterio que `Vectorize__MaxSvgResponseBytes` |
| `Simplification__LowEpsilonRatio` / `MediumEpsilonRatio` / `HighEpsilonRatio` | `backend` (appsettings o env) | `0.0015` / `0.004` / `0.012` | Presets Bajo/Medio/Alto que ve el usuario, como epsilon de Douglas-Peucker relativo a la diagonal del SVG (supuesto: spec.md no los cuantifica) |
| `Simplification__MinCustomTolerance` / `MaxCustomTolerance` | `backend` (appsettings o env) | `0.0` / `0.5` | Rango permitido si el cliente envía una tolerancia numérica custom en vez de un preset |
| `SimplificationRegistry__RootPath` | `backend` (appsettings o env) | `App_Data/simplifications` | Carpeta donde `PersistentSimplificationVersionRegistry` guarda un sidecar JSON por versión de simplificación (nunca se versiona) |
| `Check__TimeoutSeconds` | `backend` (appsettings o env) | `20` | Timeout del cliente HTTP hacia Python al analizar paths |
| `Check__DefaultCloseGapRatio` | `backend` (appsettings o env) | `0.005` | Tolerancia por defecto (fracción de la diagonal del SVG) para detectar un path "que debería estar cerrado" (supuesto: spec.md no la cuantifica) |
| `Check__DefaultDuplicatePointRatio` | `backend` (appsettings o env) | `0.002` | Tolerancia por defecto para detectar paths/segmentos casi-duplicados |
| `CORS_ALLOWED_ORIGINS` | `.env` (raíz) | `http://localhost:5173,http://127.0.0.1:5173` | Valor que docker-compose pasa a `Cors__AllowedOrigins`; si cambias `FRONTEND_PORT`, actualízalo |
| `SERVICE_NAME` / `SERVICE_VERSION` | `services/python-engine/.env` | `vectorify-python-engine` / `0.1.0` | Identidad reportada en `/health` y `/api/v1/info` |
| `HOST` / `PORT` | `services/python-engine/.env` | `0.0.0.0` / `8000` | Bind del servidor uvicorn |
| `LOG_LEVEL` | `services/python-engine/.env` | `info` | Nivel de logging del motor |
| `FRONTEND_PORT` / `BACKEND_PORT` / `PYTHON_PORT` | `.env` (raíz) | `5173` / `5080` / `8001` | Puertos publicados por `docker-compose.yml` |
| `PYTHON_ENGINE_INTERNAL_URL` | `.env` (raíz) | `http://python-engine:8000` | URL interna (red de Docker) que usa el backend para llamar a Python |
| `Postgres__ConnectionString` | `backend` (solo variable de entorno, NUNCA appsettings.*.json) | _(vacío)_ | Connection string Npgsql completa que usa `VectorizationDbContext` (M2.2-S01). Si no está seteada, la API arranca igual, omite la migración automática y el health check reporta Postgres "unavailable" |
| `POSTGRES_PORT` / `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | `.env` (raíz) | `5432` / `vectorify` / `vectorify` / `vectorify_dev_password` | Credenciales/puerto de ejemplo (NO reales) que `docker-compose.yml` usa para el servicio `postgres` y para construir `Postgres__ConnectionString` del `backend` |
| `COMPOSE_PROJECT_NAME` | entorno (opcional) | _(carpeta del repo)_ | Nombre del proyecto Compose: prefija contenedores y volúmenes. Usalo (junto con puertos propios) para correr una pila aislada sin pisar los volúmenes de otra; los scripts de backup/restore lo respetan |
| `DevelopmentUser__UserId` / `DevelopmentUser__Email` / `DevelopmentUser__DisplayName` | `backend` (appsettings o env) | `00000000-0000-0000-0000-000000000001` / `dev@vectorify.local` / `Dev User` | Identidad fija del único usuario de desarrollo (M2.2-S09; sin login). Solo se acepta en entornos `Development`/`Testing`/`Test`: en otro la API no arranca |
| `ASPNETCORE_ENVIRONMENT` | `.env` (raíz) / `backend` | `Development` | Entorno de ASP.NET Core; con la identidad de desarrollo fija solo `Development`/`Testing`/`Test` son válidos hasta MVP 3.1 |
| `Asset__MaxFileSizeBytes` / `Asset__AllowedContentTypes` | `backend` (appsettings o env) | `15728640` (15 MB) / `image/png,image/jpeg,image/webp,image/svg+xml` | Límites de `POST /api/v2/projects/{id}/assets` (M2.2-S04) |

## PostgreSQL + EF Core (M2.2-S01)

> **Nota histórica**: esta sección describe la tarjeta S01 tal como se entregó (migración inicial
> mínima con una tabla marcador). Desde S02–S10 el modelo es el completo (`users`, `projects`,
> `vector_documents`, `document_versions`, `layers`, `palette_colors`, `assets`) y `SchemaProbe`
> quedó solo como tabla marcador legada: el estado vigente está en `docs/ARQUITECTURA_PERSISTENCIA.md`
> y en "Persistencia, backup y restore" más arriba.

Primera infraestructura de base de datos relacional real del proyecto. Hasta
esta tarjeta, TODA la persistencia era en memoria o sidecars de archivos JSON
bajo `App_Data/` (`PersistentProjectRegistry`, `PersistentLayerLayoutVersionRegistry`,
etc.) — esos registries **no se tocan**, siguen funcionando exactamente igual,
en paralelo a PostgreSQL. Esta tarjeta es puramente de infraestructura: NO
modela el dominio real (proyectos/imágenes/paletas/capas) como entidades EF —
eso es `M2.2-S02`, la tarjeta siguiente.

### `VectorizationDbContext`

Deliberadamente mínimo: un único `DbSet<SchemaProbe>` (`Id`/`CreatedAt`), una
tabla marcador **descartable** sin ningún significado de dominio, cuyo único
propósito es demostrar el pipeline completo de punta a punta que pide el DoD
(migrar, escribir, releer, sobrevivir a un restart de Postgres). Se espera que
`M2.2-S02` la reemplace por el modelo real.

### Configuración (`PostgresOptions`)

Mismo patrón que `PythonEngineOptions`/`FrontendCorsOptions`: una clase de
opciones tipada (`Vectorify.Api.Options.PostgresOptions`, sección `Postgres`)
con un único campo, `ConnectionString`. A diferencia de esas dos, **nunca**
tiene un valor por defecto en `appsettings.json` ni en
`appsettings.Development.json` (contendría credenciales, aunque sean de
desarrollo): se resuelve EXCLUSIVAMENTE por la variable de entorno
`Postgres__ConnectionString`, en los tres ambientes:

- **Development**: la inyecta `docker-compose.yml` (`Host=postgres;...`, nombre
  de servicio interno de Docker). Corriendo `dotnet run` fuera de Docker, hay
  que exportarla a mano (ver "Arranque en local" más arriba) — si no está
  seteada, la API arranca igual (omite la migración automática, el health
  check reporta Postgres `"unavailable"`), mismo criterio de tolerancia a
  fallos que ya existe para el motor Python.
- **Test**: cada test la configura directamente (Testcontainers genera una
  PostgreSQL real y efímera por corrida), nunca pasa por `appsettings.*.json`.
- **Production**: solo por variable de entorno real del orquestador/proveedor,
  nunca un archivo versionado.

Connection pooling: Npgsql lo trae activado por defecto: no se agregó
configuración adicional.

### Migraciones

Tooling: `dotnet ef` (paquete `Microsoft.EntityFrameworkCore.Design`, referenciado
como `PrivateAssets="all"` porque solo hace falta en tiempo de diseño). Si no
tenés el tool global instalado: `dotnet tool install --global dotnet-ef --version 9.0.20`.

```bash
cd backend/Vectorify.Api

# Crear una migración nueva a partir de cambios en VectorizationDbContext
dotnet ef migrations add <NombreDescriptivo> --output-dir Migrations

# Aplicar todas las migraciones pendientes contra la base configurada en
# Postgres__ConnectionString (o el default de VectorizationDbContextFactory,
# pensado para `docker compose up postgres` con el puerto publicado en el host)
dotnet ef database update

# Rollback a una migración anterior (o "0" para revertir todas)
dotnet ef database update <MigraciónAnterior>
```

La migración inicial (`InitialCreate`) se aplica **automáticamente** al
arrancar la API (`dbContext.Database.Migrate()` en `Program.cs`, nunca
`EnsureCreated()` — prohibido explícitamente por la tarjeta: no es compatible
con un historial de migraciones versionado). Tolerante a fallos: si Postgres
no está configurado o no responde, la API sigue arrancando igual, y el log
nunca expone la connection string completa (solo host/puerto/nombre de base,
ver `DatabaseConnectionDescriber`).

### Health check

`GET /api/v1/system/health` (el mismo endpoint ya existente, no uno nuevo)
ahora compone también el estado de PostgreSQL (`database`, mismo criterio
discriminado que `python`: `"online"` / `"unavailable"` / `"error"`). El
`status` global pasa a `"online"` solo si Python **y** Postgres están
`"online"` — si cualquiera de los dos tiene problemas, `"degraded"`, sin que
la Web API deje de responder 200 (ver ejemplo actualizado más abajo).

### Docker Compose

Servicio `postgres` nuevo (`postgres:17-alpine`), con volumen nombrado propio
(`vectorify_postgres_data`) y healthcheck (`pg_isready`). `backend` depende de
él con `condition: service_healthy` (Postgres tarda en aceptar conexiones,
un `depends_on` simple no alcanza) — `python-engine` conserva el
comportamiento previo (`condition: service_started`).

### Testing contra PostgreSQL real

Prohibido explícitamente usar `UseInMemoryDatabase` (no prueba comportamientos
reales de PostgreSQL). `backend/Vectorify.Api.Tests` usa
`Testcontainers.PostgreSql` para levantar una instancia real y efímera de
PostgreSQL por corrida de tests (`VectorizationDbContextTests`: migra desde
cero, confirma idempotencia de migrar dos veces, y hace un round-trip de
escritura/lectura de un `SchemaProbe`; `DatabaseHealthEndpointTests`: levanta
la Web API real vía `WebApplicationFactory` apuntando a esa misma PostgreSQL
efímera y confirma que el health check compuesto reporta `"online"`). Requiere
Docker disponible en el entorno donde corren los tests — confirmado disponible
en el entorno de este sprint.

## Contrato inicial (Python → ASP.NET Core)

`GET /health` en el motor Python responde:

```json
{ "status": "ok", "service": "vectorify-python-engine", "version": "0.1.0" }
```

ASP.NET Core lo deserializa en un contrato tipado y compone
`GET /api/v1/system/health`:

```json
{
  "status": "online",
  "timestamp": "2026-01-01T00:00:00Z",
  "api": { "status": "online" },
  "python": { "status": "online", "service": "vectorify-python-engine", "version": "0.1.0", "message": null },
  "database": { "status": "online", "message": null }
}
```

Si Python está apagado, con timeout, o responde algo inválido, `python.status`
pasa a `unavailable` / `timeout` / `invalid_response` (o `error` para otros
códigos HTTP); si Postgres no está configurado, no responde, o falla de forma
inesperada, `database.status` pasa a `unavailable` / `error` (M2.2-S01). En
cualquiera de los dos casos, `status` global pasa a `degraded` — sin que la
Web API deje de responder 200.

## Carga y almacenamiento de imágenes (M1-S02)

`POST /api/v1/projects` recibe `multipart/form-data` con un campo `file`
(PNG, JPG/JPEG o WEBP; 15 MB máximo por defecto, ver `Upload:*` abajo — el
spec de la tarjeta no cuantifica un límite, así que este valor es un supuesto
documentado). Valida, en orden: archivo vacío/ausente, tamaño máximo, MIME
type + extensión permitidos, la firma binaria del contenido (descarta basura
obvia barato) y finalmente una decodificación real con ImageSharp (detecta
archivos truncados/corruptos que solo tienen una cabecera válida pero no son
una imagen completa). Si todo es válido, genera `projectId`/`imageId`, guarda
el original mediante `IFileStorage` (implementación local en desarrollo,
contrato preparado para sustituirse por almacenamiento S3-compatible sin
tocar el endpoint) y responde `201 Created` con:

```json
{
  "projectId": "…", "imageId": "…", "filename": "logo.png",
  "mimeType": "image/png", "bytes": 12345,
  "width": 800, "height": 600, "status": "uploaded"
}
```

`width`/`height` son `null` cuando el formato no permitió leerlos (lectura
best-effort de la cabecera, sin decodificar la imagen). El original se
recupera, sin modificarse, en `GET /api/v1/projects/{projectId}/images/{imageId}/original`.

Errores controlados (`400`, salvo `storage_failure` que es `500`), todos con
el cuerpo `{ "code": "...", "message": "..." }`:

| Code | Motivo |
|---|---|
| `empty_file` | No se envió archivo, o pesa 0 bytes |
| `file_too_large` | Supera `Upload:MaxFileSizeBytes` |
| `unsupported_format` | MIME type/extensión fuera de `Upload:AllowedContentTypes` |
| `corrupt_file` | El contenido no coincide con la firma binaria esperada, o no se pudo decodificar como imagen completa |
| `upload_interrupted` | La conexión se cortó o el formulario multipart no se pudo leer |
| `storage_failure` | Falló `IFileStorage` al guardar (disco, permisos, etc.) |
| `not_found` | `GET .../original` con un `projectId`/`imageId` que no existe |

El header opcional `Idempotency-Key` evita crear un proyecto duplicado ante
un reintento del mismo envío (doble click, retry tras un error de red que sí
llegó a completarse): si se repite la clave, la Web API responde `200 OK`
con el proyecto ya creado en vez de generar uno nuevo. El frontend
(`useImageUpload`) genera una clave (`crypto.randomUUID()`) al elegir un
archivo, la reutiliza entre reintentos del mismo archivo y la renueva al
elegir uno nuevo o al cancelar/resetear. La metadata de cada proyecto se
guarda en memoria (lecturas O(1)) y además se persiste como un sidecar JSON
en disco junto al original (`App_Data/projects/{projectId}/{imageId}.json`
por defecto, ver `ProjectRegistry:*` abajo); al reiniciar el proceso, la Web
API rehidrata el registro en memoria escaneando esos sidecars — sigue sin
haber una base de datos de negocio real. Ver Swagger (`/swagger`) para el
contrato completo y `backend/Vectorify.Api/Vectorify.Api.http` para ejemplos de
request.

## Preprocesamiento de imagen (M1-S03)

`POST /api/v1/projects/{projectId}/images/{imageId}/preview` recibe un JSON
con los parámetros del pipeline (`grayscale`, `contrast`, `brightness`,
`denoise`; rangos configurables vía `Preprocess:*`, ver variables de entorno
abajo — spec.md no los cuantifica, así que son un supuesto documentado, ver
`.sprint/3c1d77b2-6398-81a1-8df9-c2ecd0f5653f/spec.md`). La Web API valida
los rangos, y si ya existe un preview generado con exactamente esos
parámetros para esa imagen lo devuelve (`200 OK`, cacheado) en vez de volver
a llamar a Python; si no existe, reenvía el original (sin modificarlo) al
motor Python (`POST /api/v1/preprocess`, que aplica el pipeline determinista
con OpenCV), guarda el preview resultante bajo una nueva versión y responde
`201 Created` con:

```json
{
  "projectId": "…", "imageId": "…", "previewId": "…",
  "previewUrl": "/api/v1/projects/{projectId}/images/{imageId}/previews/{previewId}",
  "version": 1, "width": 800, "height": 600,
  "originalWidth": 800, "originalHeight": 600,
  "effectiveParams": { "grayscale": false, "contrast": 1.4, "brightness": 5, "denoise": 2 },
  "metrics": { "meanBrightness": 128.4, "stdDev": 42.1, "minValue": 0, "maxValue": 255 },
  "cached": false
}
```

"Resetear" es simplemente volver a llamar con los valores por defecto
(`grayscale=false, contrast=1.0, brightness=0, denoise=0`), que genera una
nueva versión de forma reproducible. El preview se recupera, en bytes, en
`GET /api/v1/projects/{projectId}/images/{imageId}/previews/{previewId}`.

Errores controlados con el mismo cuerpo `{ "code": "...", "message": "..." }`:

| Code | HTTP | Motivo |
|---|---|---|
| `invalid_parameters` | 422 | Algún parámetro está fuera de los rangos de `Preprocess:*` |
| `not_found` | 404 | `projectId`/`imageId` no existen (o el preview, en el GET) |
| `dimensions_exceeded` | 413 | La imagen supera el límite de dimensiones que acepta Python |
| `corrupt_file` | 400 | Python no pudo decodificar el original |
| `timeout` | 504 | El motor Python no respondió dentro de `Preprocess:TimeoutSeconds` |
| `engine_unavailable` | 503 | No se pudo contactar al motor Python |
| `invalid_response` | 502 | El motor Python respondió algo que la Web API no pudo interpretar |

Ver Swagger (`/swagger`) para el contrato completo.

## Vectorización raster → SVG (M1-S05)

`POST /api/v1/projects/{projectId}/images/{imageId}/vectorize` recibe un JSON
con `{ "maskId": "…" }`, referenciando una máscara B/N YA generada por
threshold (M1-S04) — la vectorización es la etapa siguiente del mismo
pipeline, nunca opera sobre el preview preprocesado ni el original. Sin
parámetros ajustables en este sprint (el motor, VTracer, corre con una
configuración fija y determinista). Si ya existe un SVG generado para esa
máscara exacta, lo devuelve (`200 OK`, cacheado) en vez de volver a llamar a
Python; si no, reenvía la máscara al motor Python (`POST /api/v1/vectorize`,
que traza con VTracer, encapsulado detrás de `app.core.vector_engine`),
guarda el resultado bajo una nueva versión y responde `201 Created` con:

```json
{
  "projectId": "…", "imageId": "…", "vectorId": "…",
  "svgUrl": "/api/v1/projects/{projectId}/images/{imageId}/vectors/{vectorId}",
  "sourceMaskId": "…", "version": 1, "width": 800, "height": 600,
  "metrics": {
    "pathCount": 12, "approxNodeCount": 340,
    "bounds": { "minX": 4, "minY": 4, "maxX": 796, "maxY": 596, "width": 792, "height": 592 }
  },
  "cached": false
}
```

El SVG resultante se recupera, en bytes, en
`GET /api/v1/projects/{projectId}/images/{imageId}/vectors/{vectorId}`.

**Sanitización del SVG** (`app.core.svg_processing`, del lado Python, ANTES
de persistirlo o devolverlo): elimina `<script>`, `<foreignObject>`,
`<iframe>`, `<embed>`, `<object>`, `<audio>`, `<video>` y `<style>` (puede
traer `@import url(...)` a hojas de estilo externas — VTracer es trazado
geométrico puro y nunca necesita generar CSS), manejadores de eventos
inline (`onclick`, `onload`, ...), y cualquier `href`/`xlink:href` que no
sea una referencia interna (`#fragmento`). También elimina cualquier
atributo de presentación (`style`, `fill`, `stroke`, `clip-path`, `mask`,
`filter`) que contenga un `url(...)` que no apunte a una referencia interna
(`url(#gradiente-interno)` sí se conserva — legítimo para
gradientes/patterns dentro del mismo documento), rechaza DOCTYPE/ENTITY
antes de parsear (defensa contra XXE) y valida que el resultado sea XML
parseable con `<svg>` como raíz. `Vectorify.Api` (`PythonVectorizeClient`)
aplica una segunda capa de validación defensiva sobre la respuesta de
Python antes de aceptarla: SVG bien formado con `<svg>` como raíz,
dimensiones/métricas positivas, bounds finitos y coherentes, Content-Type
esperado (`image/svg+xml`) y un límite de tamaño configurable
(`Vectorize:MaxSvgResponseBytes`, 10 MB por defecto) — nunca confía
ciegamente en que Python ya validó todo del otro lado.

Errores controlados con el mismo cuerpo `{ "code": "...", "message": "..." }`:

| Code | HTTP | Motivo |
|---|---|---|
| `not_found` | 404 | `projectId`/`imageId`/`maskId` no existen (o el vector, en el GET) |
| `dimensions_exceeded` | 413 | La máscara supera el límite de dimensiones, o el SVG resultante supera el límite de tamaño de salida |
| `empty_mask` | 422 | La máscara no tiene ningún píxel de foreground (nada que vectorizar) |
| `corrupt_file` | 400 | Python no pudo decodificar la máscara |
| `timeout` | 504 | El motor Python no respondió dentro de `Vectorize:TimeoutSeconds` |
| `engine_unavailable` | 503 | No se pudo contactar al motor Python |
| `invalid_response` | 502 | El motor Python respondió algo que la Web API no pudo interpretar, o que no pasó la validación defensiva adicional del cliente |

El historial de versiones de vectorización (`VectorVersion`) se guarda en
memoria (lecturas O(1)) y además se persiste como un sidecar JSON en disco
(`App_Data/vectors/{projectId}/{imageId}/{vectorId}.json` por defecto, ver
`VectorRegistry:*` arriba); al reiniciar el proceso, la Web API rehidrata el
registro en memoria escaneando esos sidecars — mismo patrón que
`PersistentProjectRegistry` (M1-S02) y `PersistentThresholdConfigRegistry`
(M1-S04). Ver Swagger (`/swagger`) para el contrato completo.

## Visualizador SVG y comparación (M1-S06)

Una vez generado un SVG, `VectorizePanel` monta `VectorComparison`: dos
paneles `VectorCanvas` lado a lado (el original subido, M1-S02, y el SVG
vectorizado) que comparten una única transformación de zoom/pan
(`useCanvasTransform`), para garantizar que ambos siempre se ven a la misma
escala de referencia. Cada `VectorCanvas` soporta zoom con rueda/trackpad
(zoom al cursor), pan por arrastre (Pointer Events, con captura de puntero y
fallback defensivo si el navegador no la soporta), controles de teclado
(flechas para pan, `+`/`-` para zoom) y una barra de herramientas
(Alejar/Acercar/Restablecer a 1:1/Ajustar a pantalla), con los botones
deshabilitados en los límites de escala (`minScale=0.1`, `maxScale=8`, o `4`
si el diseño es "grande": `pathCount > 500` OR `approxNodeCount > 5000` OR
área > 4.000.000 px², con una nota visible en ese caso). El SVG se muestra
con `<img>` + transform CSS (no inline): el navegador nunca ejecuta script
embebido, defensa en profundidad adicional aunque el SVG ya esté sanitizado
del lado del backend. El componente se remonta (`key={vectorId}`) en cada
vectorización nueva, para resetear el zoom/pan. Sin cambios del lado de
ASP.NET Core ni de Python — `VectorComparison`/`VectorCanvas` consumen los
mismos endpoints ya expuestos (`GET .../original` y `GET .../vectors/{id}`),
sin lógica visual del lado del servidor.

## Simplificación de nodos (M1-S07)

`POST /api/v1/projects/{projectId}/images/{imageId}/simplify/preview` recibe
un JSON con `{ "vectorId": "…", "preset": "low" | "medium" | "high" }` (o
`{ "vectorId": "…", "tolerance": 0.01 }` para una tolerancia numérica custom
en el mismo rango que los presets — nunca ambos campos a la vez) y devuelve
el SVG simplificado más `nodeCount` antes/después y `%` de reducción, **sin
persistir nada** (`200 OK`, reversible por diseño: cancelar del lado de
React no requiere ninguna llamada de red). `POST .../simplify/apply` con el
mismo cuerpo sí persiste: crea una nueva versión (`SimplificationVersion`,
`201 Created`, o `200 OK` si ya existía una versión con esos mismos
parámetros exactos, en cuyo caso igual se registra como una versión nueva
del historial en vez de devolver la vieja). El algoritmo (Douglas-Peucker,
`services/python-engine/app/core/simplification_pipeline.py`) opera
exclusivamente sobre paths `M/L/Z` absolutos en mayúscula — cualquier otro
comando (curvas, arcos, minúsculas relativas) se deja intacto sin
analizarlo, ver el docstring del módulo. No hay verificación geométrica de
que la simplificación no introduzca auto-intersecciones en formas no
convexas (limitación conocida del algoritmo, no implementada en este
sprint).

```json
{
  "vectorId": "…", "simplificationId": "…",
  "svgUrl": "/api/v1/projects/{projectId}/images/{imageId}/simplifications/{simplificationId}",
  "version": 1, "preset": "medium",
  "metrics": { "nodeCountBefore": 340, "nodeCountAfter": 118, "reductionPercent": 65.3 },
  "cached": false
}
```

Errores controlados con el mismo cuerpo `{ "code": "...", "message": "..." }`:
`not_found`, `invalid_parameters`, `dimensions_exceeded` (413, SVG de
entrada/salida demasiado grande), `corrupt_file` (400), `timeout` (504),
`engine_unavailable` (503), `invalid_response` (502). Ver Swagger
(`/swagger`) para el contrato completo.

## Laser Checker: paths abiertos y duplicados (M1-S08)

`POST /api/v1/projects/{projectId}/images/{imageId}/check` recibe
`{ "sourceKind": "vector" | "simplification", "sourceId": "…" }` (acepta
como origen un `VectorVersion` de M1-S05 o una `SimplificationVersion` de
M1-S07 ya aplicada) y devuelve, siempre `200 OK` sin persistir nada, la
lista de problemas geométricos detectados:

```json
{
  "sourceKind": "vector", "sourceId": "…",
  "summary": { "openPathCount": 1, "duplicateGroupCount": 1, "skippedPathCount": 0 },
  "issues": [
    { "type": "open_path", "severity": "error", "pathIndex": 2, "subpathIndex": 0,
      "startPoint": { "x": 10, "y": 10 }, "endPoint": { "x": 10.4, "y": 10.1 }, "gapDistance": 0.41 },
    { "type": "duplicate_path", "severity": "error", "exact": true, "maxPointDistance": 0,
      "members": [ { "pathIndex": 3, "subpathIndex": 0 }, { "pathIndex": 5, "subpathIndex": 0 } ] }
  ]
}
```

El análisis es de **solo lectura**: nunca modifica el SVG de origen ni
corrige nada automáticamente. Un path "debería estar cerrado" cuando no
tiene `Z` explícito y sus extremos están a una distancia ≤ `close_gap_ratio`
(0.5% de la diagonal del SVG por defecto) de distancia entre sí. Dos
subpaths son "casi-duplicados" cuando tienen la misma cantidad de puntos y
el mismo estado de cierre, y todos sus puntos (comparados en el mismo
sentido de recorrido o en el inverso) están a una distancia ≤
`duplicate_point_ratio` (0.2% de la diagonal por defecto); los que
matchean, directa o transitivamente, se agrupan en un único issue.
`skippedPathCount` cuenta los `<path>` con comandos no soportados (mismo
criterio que la simplificación) **o con un `transform` no resoluble**
(cualquier cosa que no sea exactamente `translate(tx,ty)`/`translate(tx)` —
ver fix de M1-S11 más abajo) que quedaron fuera del análisis. En React,
`CheckPanel` corre el análisis a pedido y permite resaltar cada issue sobre
`VectorCanvas` (M1-S06) haciendo click.

**Fix M1-S11**: antes de comparar puntos entre subpaths (para
`duplicate_path`) o calcular sus `bounds`, el checker resuelve y aplica el
`transform="translate(tx,ty)"` de cada `<path>` — VTracer emite formas
congruentes en posiciones reales distintas del lienzo con el MISMO `d` local
y solo el `transform` distinto; antes de este fix eso se reportaba como un
falso positivo de `duplicate_path`. Ver
`services/python-engine/app/core/path_checker.py` y el fixture de regresión
`problematic.png` en el dataset E2E.

Errores controlados con el mismo cuerpo `{ "code": "...", "message": "..." }`:
`not_found`, `invalid_parameters`, `too_many_subpaths` (413, salvaguarda de
rendimiento sobre la detección O(n²) de duplicados), `corrupt_file` (400),
`timeout` (504), `engine_unavailable` (503), `invalid_response` (502). Ver
Swagger (`/swagger`) para el contrato completo.

## Dimensiones físicas en mm (M1-S09)

`POST /api/v1/projects/{projectId}/images/{imageId}/dimensions/apply` recibe
`{ "sourceKind": "vector" | "simplification", "sourceId": "…", "widthMm": 100,
"heightMm": null, "lockAspectRatio": true }` (proporción bloqueada por
defecto: exige exactamente uno de `widthMm`/`heightMm`, el otro se calcula;
desbloqueada exige ambos y permite deformar el diseño explícitamente) y
reescribe **solo** `width`/`height`/`viewBox`/`preserveAspectRatio` del
`<svg>` raíz del SVG de origen — nunca los `d` de los `<path>`. Persiste el
resultado como una nueva `DimensionVersion` (`201 Created`, o `200 OK` si ya
existía una versión con exactamente esos parámetros, que igual avanza el
historial). El SVG resultante se recupera, en bytes, en
`GET /api/v1/projects/{projectId}/images/{imageId}/dimensions/{dimensionId}`.
No hay endpoint de preview: el preview del tamaño final se calcula 100% en
el cliente (React). Ver Swagger (`/swagger`) para el contrato completo.

## Exportación SVG (M1-S10)

`GET /api/v1/projects/{projectId}/images/{imageId}/export?sourceKind=vector|simplification|dimension&sourceId=…`
sirve, tal cual, los mismos bytes ya persistidos por la etapa de origen
elegida (`VectorVersion` de M1-S05, `SimplificationVersion` de M1-S07 o
`DimensionVersion` de M1-S09), con `Content-Disposition: attachment` y un
nombre de archivo sanitizado derivado del nombre original subido por el
usuario. Es un `GET` puro de solo lectura: nunca modifica geometría ni
genera un artefacto nuevo, y exportar la misma versión dos veces sirve
exactamente los mismos bytes. Ver Swagger (`/swagger`) para el contrato
completo.

## Flujo E2E completo (M1-S11)

Gate de calidad del MVP 1: no agrega features, demuestra que el pipeline
completo (upload → preprocesamiento → threshold → vectorización →
comparación → simplificación → Laser Checker → dimensiones mm → export SVG)
funciona de punta a punta con imágenes reales, sin pasos manuales internos.

### Dataset (`tests/e2e/fixtures/`)

Seis imágenes PNG generadas programáticamente con OpenCV + NumPy (mismas
dependencias ya usadas por el motor Python, sin agregar ninguna librería
nueva — ver `tests/e2e/fixtures/generate_fixtures.py` para el detalle
completo de cómo se generó cada una y por qué):

| Fixture | Qué ejercita |
|---|---|
| `logo.png` | Formas geométricas simples, alto contraste (anillo + estrella) |
| `silhouette.png` | Contorno cerrado orgánico simple (un solo path) |
| `text.png` | Texto trazado ("VECTIFY"): múltiples subpaths pequeños |
| `holes.png` | Topología con agujero real (dona): path con subpaths anidados de sentido opuesto |
| `noise.png` | Ruido gaussiano fuerte: ejercita de verdad el denoise de M1-S03 (612 nodos sin denoise vs. ~31 con denoise en la corrida real, ver IMPL.md) |
| `problematic.png` | Dos círculos congruentes en posiciones REALES distintas: fixture de regresión del fix de `transform` de M1-S11 (ver IMPL.md) — antes del fix disparaba un `duplicate_path` falso positivo (el checker comparaba coordenadas locales del `d` ignorando el `transform` que VTracer aplica por `<path>`); desde M1-S11 el Laser Checker resuelve el `transform` antes de comparar, así que este fixture correctamente NO reporta ningún issue |

Para regenerar el dataset (determinista, produce los mismos bytes salvo que
se cambie el código del generador):

```bash
services/python-engine/.venv/Scripts/python.exe tests/e2e/fixtures/generate_fixtures.py
```

### Automatización E2E (`tests/e2e/full_pipeline_e2e_test.mjs`)

Para cada fixture del dataset, encadena TODO el pipeline vía HTTP real
contra la Web API real (sin mocks, mismo criterio que
`tests/e2e/upload_e2e_test.mjs`/`tests/e2e/real_stack_test.py`): upload →
preview → threshold → vectorize → simplify (preview + apply) → check →
dimensions/apply → export, verificando en cada paso que la salida de una
etapa es estructuralmente válida como entrada de la siguiente (el
`vectorId` que devuelve vectorize es el que se usa para simplificar; el
`sourceId`/`sourceKind` correctos llegan a check/dimensions/export), que el
SVG final exportado es XML bien formado con `<svg>` como raíz y dimensiones
no degeneradas, y que `problematic.png` YA NO dispara ningún issue en el
Laser Checker (regresión del fix de `transform` de M1-S11 — ver IMPL.md).
Mide el tiempo total del pipeline por fixture y de la corrida completa, y lo
imprime en un reporte al final.

**Requiere la pila arriba** (backend en `:5080`, motor Python en `:8001`) —
igual que `real_stack_test.py`/`smoke_test.py`, este script NO la levanta:

```bash
# Con la pila corriendo (local, ver "Arranque en local" arriba, o Docker):
BACKEND_URL=http://localhost:5080 node tests/e2e/full_pipeline_e2e_test.mjs
```

Sale con código 0 solo si los 6 fixtures completaron el pipeline entero sin
errores; si algo falla, imprime qué fixture y qué paso falló antes de salir
con código 1. Ver IMPL.md de M1-S11 (`.sprint/`) para el resultado de una
corrida real contra la pila real, con tiempos medidos.

### Checklist manual

El spec pide, "cuando corresponda", inspección visual en un navegador real y
prueba de importación del SVG exportado en software de fabricación externo
(ej. LightBurn). A diferencia de las tarjetas M1-S01 a M1-S10 (donde esto
quedaba como excepción heredada sin verificar), en M1-S11 se ejecutaron de
verdad las dos primeras:

- [x] `docker compose up --build` real: los 3 servicios (`backend`,
      `frontend`, `python-engine`) construyen y arrancan correctamente sin
      necesitar un `.env` (los defaults de `docker-compose.yml` alcanzan).
      Verificado: `/health`, `/api/v1/system/health` en `online`,
      degradación a `degraded` tras `docker compose stop python-engine` y
      recuperación a `online` tras `docker compose start python-engine` —
      la Web API nunca deja de responder. El fix de `transform` de esta
      misma tarjeta se verificó reconstruyendo la imagen de `python-engine`
      (`docker compose up --build python-engine`) y volviendo a correr el
      E2E completo contra el contenedor reconstruido: 6/6 fixtures.
- [x] Navegador real: la UI en http://localhost:5173 carga y muestra
      "Todos los servicios están en línea". Se corrió el pipeline completo
      (upload → preprocess → threshold → vectorize → simplify → check →
      dimensions → export) vía HTTP real contra el stack de Docker con el
      fixture `logo.png`, y el SVG final se abrió y renderizó correctamente
      en una pestaña real del navegador. **Limitación de la herramienta**:
      el navegador automatizado disponible en este entorno no puede
      completar un `<input type="file">` real (los navegadores bloquean
      setear ese valor por script, por seguridad) — así que el click real
      de "arrastrar/elegir imagen" de la UI no se ejercitó de forma
      automatizada. Queda como el único paso genuinamente manual de este
      checklist:
- [ ] Abrir http://localhost:5173, subir cada fixture de
      `tests/e2e/fixtures/` HACIENDO CLICK en la UI (no vía HTTP directo) y
      completar el flujo completo desde los paneles, confirmando que cada
      uno (preprocesamiento, threshold, comparación vectorizada,
      simplificación, Laser Checker, dimensiones) se ve y responde
      correctamente.
- [ ] Exportar el SVG resultante de al menos un fixture y abrirlo en un
      editor SVG/CAD real (ej. Inkscape, o software de fabricación como
      LightBurn si está disponible) para confirmar que importa sin errores y
      las dimensiones en mm son correctas — no ejecutable en este entorno
      (sin ese software instalado).

## Fuera de alcance de este sprint

Quitar fondo automático, threshold adaptativo (solo umbral global en este
sprint), base de datos de negocio real, autenticación, editor vectorial
completo (edición de nodos/paths), IA, detección de colores, DXF,
integración LightBurn y almacenamiento cloud productivo (la abstracción
`IFileStorage` está preparada para S3-compatible, pero solo tiene
implementación local en este sprint; lo mismo los registros de
proyecto/threshold/vectorización/simplificación, que persisten en sidecars
JSON en disco — no en una base de datos real). Edición manual de nodos y
optimización específica de color (M1-S07); autocorrección de los issues que
detecta el Laser Checker, bridges, kerf y validación completa de
fabricación (M1-S08) — el checker de M1-S08 es puramente de diagnóstico,
nunca modifica el SVG.
