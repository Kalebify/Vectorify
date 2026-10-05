# Pruebas de Vectorify

Ejecutar desde la raíz salvo que se indique otra carpeta.

## Backend

```bash
dotnet test backend/Vectorify.sln
```

49 pruebas xUnit:

- 15 de M1-S01: 7 unitarias del cliente Python, 5 de integración HTTP
  (health) y 3 de CORS. La integración HTTP utiliza **Kestrel con respuestas
  simuladas**, no Python. Kestrel usa puertos efímeros y no depende de
  HttpListener/HTTP.sys de Windows.
- 34 de M1-S02 (carga de imágenes): 11 unitarias de `ImageUploadValidator`
  (formato/tamaño/vacío/corrupto), 5 de `ImageDimensionsReader` (PNG/JPEG/WEBP),
  5 de integración de `LocalFileStorage` contra el filesystem real (directorio
  temporal), 4 unitarias de `ProjectUploadService` con storage fake, y 9 de
  integración HTTP de `POST /api/v1/projects` / `GET .../original` contra la
  Web API real (`WebApplicationFactory`), cubriendo carga válida, cada error
  controlado del spec e idempotencia.

## Frontend

Desde `frontend/`:

```bash
npm ci
npm test
npm run build
npm run lint
```

23 pruebas con Vitest, Testing Library y jsdom:

- 8 de M1-S01 (diagnóstico): loading, online, API offline, los cuatro fallos
  de Python y el ciclo online → unavailable → online.
- 7 unitarias de `validateImageFile` (validación UX de formato/tamaño/vacío).
- 8 de `UploadPanel`: selección válida/inválida, cancelar en seleccionado y
  en carga, progreso, éxito (proyecto creado), error controlado de la Web API
  y fallo de red — con `XMLHttpRequest` estubado (fetch no expone progreso de
  subida).

jsdom no sustituye a un navegador real para comprobar CORS ni drag-and-drop real.

## Python

Con Python 3.12+ y el entorno virtual activo:

```bash
pip install -r services/python-engine/requirements-dev.txt
cd services/python-engine
python -m pytest
```

3 pruebas de los endpoints FastAPI `/health` y `/api/v1/info`.

## Integración con FastAPI real (sin Docker)

Desde la raíz, con las dependencias Python instaladas:

```bash
dotnet build backend/Vectorify.sln
python tests/e2e/real_stack_test.py
```

Arranca FastAPI y la Web API reales en puertos temporales, comprueba CORS y
que la API devuelve la identidad configurada del motor. Apaga Python,
comprueba `degraded`/`unavailable` con API online y reinicia Python para
comprobar recuperación sin reiniciar la API. Limpia sus procesos incluso
si falla. No arranca React ni afirma verificar la interfaz del navegador.

## Smoke HTTP de servicios ya iniciados

```bash
python tests/e2e/smoke_test.py
python tests/e2e/smoke_test.py --expected-python unavailable
python tests/e2e/test_smoke_validation.py
```

La segunda orden se usa **después de apagar Python**. Variables opcionales:
`BACKEND_URL`, `PYTHON_URL`, `FRONTEND_ORIGIN`. Defaults: localhost:5080,
localhost:8001 y http://localhost:5173. El script interpreta JSON y compara
por separado el estado global, API y Python, además de los headers CORS.
Las 3 pruebas del validador impiden que API online oculte Python offline.
El wrapper Bash `smoke-test.sh` requiere Python 3 (`PYTHON_EXECUTABLE` permite
seleccionar el intérprete); ya no depende de búsquedas de texto con curl.

## E2E del pipeline completo (M1-S11)

Desde la raíz, con la pila YA corriendo (local o Docker; este script NO la
levanta, a diferencia de `real_stack_test.py`/`upload_e2e_test.mjs`):

```bash
BACKEND_URL=http://localhost:5080 node tests/e2e/full_pipeline_e2e_test.mjs
```

Sube cada una de las 6 imágenes PNG de `tests/e2e/fixtures/` (generadas
programáticamente con OpenCV/NumPy — ver
`tests/e2e/fixtures/generate_fixtures.py` para el detalle de cada una: logo,
silueta, texto trazado, diseño con agujeros, ruido y un caso problemático
diseñado para disparar el Laser Checker) y encadena TODO el pipeline vía
HTTP real contra la Web API real: upload → preview (preprocesamiento) →
threshold → vectorize → simplify (preview + apply) → check → dimensions/apply
→ export. En cada paso valida que la salida de una etapa es estructuralmente
válida como entrada de la siguiente (mismo `vectorId`/`sourceId` encadenado
de punta a punta), que el SVG final exportado es XML bien formado con
dimensiones no degeneradas, y que `problematic.png` YA NO dispara ningún
issue en el Laser Checker (regresión del fix de `transform` de M1-S11, ver
IMPL.md). Para `noise.png` compara además los
resultados CON y SIN denoise, para demostrar que ese pipeline realmente
limpia la imagen. Mide el tiempo de cada paso y de la corrida completa, y
lo imprime en un reporte al final. Ver README.md, sección "Flujo E2E
completo", y el IMPL.md de M1-S11 para el resultado de una corrida real.

## Docker

Con Docker Compose disponible, desde la raíz:

```bash
python tests/e2e/docker_stack_test.py
```

Construye un proyecto Compose aislado con nombre y puertos temporales,
comprueba frontend por HTTP, contrato, CORS y apagado/recuperación de Python.
Elimina exclusivamente ese proyecto al terminar. Requiere acceso a las
imágenes y registros de paquetes durante el build. No sustituye la revisión
visual de React:

```bash
docker compose up --build
# Abrir http://localhost:5173 y comprobar ambos servicios en línea.
docker compose stop python-engine
# Comprobar API en línea y Python no disponible.
docker compose start python-engine
# Comprobar recuperación en la misma página (polling cada 5 segundos).
```

## Persistencia de MVP 2.2 (M2.2-S10)

Release gate de que `Project`/`VectorDocument` son persistentes y sobreviven a reinicios. Dos niveles:

### Automatizado (dentro de `dotnet test`, requiere Docker para Testcontainers)

32 pruebas xUnit nuevas, todas contra la Web API real (`WebApplicationFactory`) y PostgreSQL real (nunca InMemory):

| Archivo (`backend/Vectorify.Api.Tests/...`) | Pruebas | Qué cubre |
|---|---|---|
| `EndToEnd/PersistenceReleaseGateTests.cs` | 3 | Recorrido completo upload → paleta → capas → mm → CUT/ENGRAVE/IGNORE → Save → **reinicio real** (host nuevo sobre la MISMA base y la MISMA carpeta de datos; el motor Python ni siquiera se levanta) → Open → Edit (PATCH) → Autosave (idempotencyKey + replay) → versiones → Restore → segundo reinicio → reabrir. Compara contra lo guardado ANTES del reinicio: **bytes** del original, del thumbnail y del SVG de cada capa; valores de paleta/capas/IDs/mm/operaciones/versión actual; falla con un mensaje legible por cada diferencia. 2 pruebas de sensibilidad demuestran que el gate se pone ROJO si el segundo host apunta a otra carpeta de storage o a otra base. |
| `EndToEnd/PersistenceFailureModesTests.cs` | 6 | Postgres caído (proxy TCP que corta/restablece la conexión): 503 `database_unavailable` en los endpoints v2, health `degraded`, recuperación sin reiniciar la API (con y sin requests durante la caída). Storage que no responde (lectura/escritura): Save con error controlado y sin filas a medias, descarga con 503, documento con un SVG faltante que abre igual (descarga de esa capa = 404). |
| `Migrations/MigrationChainTests.cs` | 2 | Base vacía → cada migración en orden hasta la última (esquema == modelo, sin "pending model changes") y upgrade N-1 → N con datos representativos (versiones, capas, paleta, assets, thumbnail, idempotencyKey, proyecto eliminado y vacío). |
| `Maintenance/StorageConsistencyCheckerTests.cs` | 9 | Verificador DB↔storage (`--check-consistency`): fila sin archivo, archivo huérfano, solo lectura por defecto, borrado solo con flag y respetando una edad mínima, checksums, soft-delete, códigos de salida y reporte del comando. |
| `Middleware/DependencyFailureMiddlewareTests.cs` | 12 | Clasificación de excepciones: solo la falla de conectividad con Postgres es 503; errores de datos/consulta o bugs siguen siendo 500. |

### E2E vivo contra la pila Docker (fuera de la suite por defecto)

```bash
python tests/e2e/docker_persistence_test.py                    # reinicio real: down (sin -v) + up
python tests/e2e/docker_persistence_test.py --backup-cycle     # + backup -> down -v -> restore -> reabrir
python tests/e2e/docker_persistence_test.py --backup-cycle --shell bash --project-name vectorify-s10-e2e-bash
```

Solo usa la biblioteca estándar de Python 3 y Docker Compose. Crea un proyecto Compose aislado (por defecto
`vectorify-s10-e2e-<hex>`, con puertos libres propios para `frontend`/`backend`/`python-engine`/`postgres`, así que
puede correr con otra pila del desarrollador levantada) y al terminar hace `down -v` **solo de ese proyecto**. Nunca
usa `docker system prune` ni `volume prune`. Genera un PNG de tres colores sin dependencias, recorre el flujo por HTTP
real (motor Python real incluido) y compara SVG/original/thumbnail por hash antes y después del reinicio y del
restore. Ver `docs/BACKUP_RESTORE.md` para los scripts de respaldo.

## Estado de verificación

M1-S01 (2026-09-24):

- Backend: 15/15 aprobadas.
- Frontend: 8/8 aprobadas; build/TypeScript y lint correctos.
- Python: 3/3 aprobadas.
- Validador smoke: 3/3 aprobadas.
- Integración local con FastAPI real: online → unavailable → online correcta.
- Docker: no ejecutado porque no está instalado/disponible en este entorno.
- Navegador real: pendiente; las pruebas de interfaz actuales usan jsdom.

M1-S02 (2026-09-24), añadido sobre lo anterior:

- Backend: 49/49 aprobadas (15 de M1-S01 + 34 de carga de imágenes).
- Frontend: 23/23 aprobadas (8 de M1-S01 + 15 de carga de imágenes);
  build/TypeScript y lint correctos.
- `node tests/e2e/upload_e2e_test.mjs`: aprobado contra la Web API real
  (Kestrel, sin `WebApplicationFactory`) — carga válida con recuperación
  byte a byte del original, y los tres errores controlados principales
  (formato no soportado, archivo vacío, archivo corrupto).
- Docker y navegador real: mismo estado pendiente que M1-S01 (no ejecutado
  en este entorno); tampoco se verificó drag-and-drop real de la Dropzone
  fuera de jsdom.

El sprint no tiene toda su Definition of Done verificada hasta completar
Docker y la comprobación en navegador, independientemente de la columna del tablero.

M2.2-S10 (2026-10-05), añadido sobre lo anterior:

- Backend: 894/894 aprobadas (`dotnet test backend/Vectorify.sln`, 862 previas + 32 de persistencia), 0 advertencias de compilación.
- Frontend: 444/444 aprobadas; `npm run build` correcto (sin cambios de frontend en esta tarjeta).
- E2E vivo contra Docker (`tests/e2e/docker_persistence_test.py --backup-cycle`, variantes `--shell powershell` y
  `--shell bash`): reinicio real `down`/`up` con volúmenes conservados, edición/autosave/restore y ciclo
  backup -> `down -v` -> restore -> reabrir, todo idéntico byte a byte; verificador de consistencia en verde.
- Pendiente (sin cambios): comprobación en navegador real.
