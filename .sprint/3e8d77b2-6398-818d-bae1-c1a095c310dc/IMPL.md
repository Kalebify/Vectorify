# IMPL.md — M2.2-S08 · Pantalla Mis Proyectos

## Resumen

Octava tarjeta de MVP 2.2. Dashboard de proyectos persistentes sobre el CRUD v2 que ya existía
(M2.2-S03): listar con búsqueda/orden/paginación, crear (→ flujo de upload), abrir, renombrar,
duplicar y eliminar, con estados loading/empty/error. Spec: `spec.md` de esta carpeta.

## Backend

- **Vínculo Project v2 → triple clásico** (decisión 1 del spec): `Project` gana `ClassicProjectId`,
  `ClassicImageId`, `ClassicPaletteId` (`Guid?`), migration `AddProjectClassicTriple`. Se persisten
  en el PRIMER Save (`VectorDocumentService` → `IProjectService.CreateAsync(..., ClassicProjectLink)`)
  y no se vuelven a tocar. Sin backfill: los proyectos v2 previos quedan en null y la UI muestra un
  error controlado al intentar abrirlos.
- **Thumbnail** (decisión 2): `Imaging/ThumbnailGenerator` (ImageSharp, ≤ 320 px, sin agrandar; JPEG
  sale JPEG, el resto PNG). Best-effort tras confirmar el primer Save: lee el original clásico vía
  `IProjectRegistry` + `IFileStorage`, lo guarda como Asset `"thumbnail"` y
  `IProjectRepository.SetThumbnailAsync` (no toca `UpdatedAt`). Cualquier fallo → warning, el Save no
  se ve afectado. Es el original reducido, no el render vectorial (no hay rasterizador de SVG).
- **Listado**: `ProjectSummaryResponse` gana `LayerCount`, `ThumbnailUrl` y el triple;
  `ProjectResponse` gana el triple. `LayerCount` sale de una subquery correlacionada en la misma
  query del listado (`ProjectListItem`), sin N+1 — hay un test que cuenta comandos SQL.

## Frontend

- `api/projectsV2Api.ts` + `types/projectsV2.ts`; `httpClient` gana `ApiClientError.status`, 204 sin
  cuerpo y `delete` (cambios aditivos).
- `components/projects/*`: `ProjectsDashboard` (grid/list, búsqueda con debounce 300 ms, orden,
  paginación de 12, skeleton, empty vs. sin-resultados, error + reintentar), `ProjectCard`,
  `ProjectActionsMenu` (menú ARIA operable por teclado), `ProjectDialog` (modal con foco gestionado y
  Escape), `RenameProjectDialog`, `DeleteProjectDialog` (`alertdialog`, nunca `window.confirm`).
  Rename maneja 400/404/409; Duplicate bloquea el doble click con una guarda síncrona; Delete retrocede
  una página si queda vacía; Open sin triple → error controlado, con triple → `onOpenProject`.
- Navegación (decisión 3) sin `react-router`: `lib/workspaceLocation.ts` gana `readAppView`/
  `pushAppView`. Sin params = dashboard (landing); `?view=new` = flujo clásico de upload;
  params de Workspace = Workspace. Cerrar un Workspace guardado vuelve al dashboard; uno en staging
  vuelve a `?view=new`. Se agregó un handler de `popstate` (fuera del spec, ignorado con el Workspace
  abierto para no perder un guardado en vuelo).
- **Avisos del Workspace** ("Continuar donde quedaste" y deep-link inválido) se muestran en AMBAS
  vistas; un deep-link inválido siempre aterriza en el dashboard.
- Tests existentes de `App` pasan a `?view=new`.

## Hallazgos de la revisión del orquestador (corregidos en esta tarjeta)

1. **Duplicar un proyecto lo dejaba sin arte.** `ProjectRepository.DuplicateAsync` (M2.2-S03) no
   copiaba `Layer.SvgAssetId` ni `Layer.PathCount`; y las filas `Asset` pertenecen a UN proyecto
   (la descarga filtra por `projectId`), así que aunque se hubiera copiado el Id el duplicado habría
   dado 404. Un proyecto duplicado desde Mis Proyectos se reabría con capas sin SVG. Reproducido con
   un test que fallaba (`Expected: 3, Actual: 0` filas de Asset en el duplicado) antes del fix.
   Corregido: el duplicado recibe filas `Asset` PROPIAS (Ids nuevos, misma `StorageKey`: el binario es
   inmutable y no se re-copia) para cada SVG de capa/versión y para el thumbnail, con `SvgAssetId`/
   `PathCount` remapeados; `ThumbnailAssetId` se asigna en la segunda fase del guardado (ciclo
   Project↔Asset de inserts nuevos). Para que compartir `StorageKey` sea seguro,
   `AssetService.DeleteAsync` ya no borra el archivo mientras otra fila lo referencie
   (`IAssetRepository.CountByStorageKeyAsync`). Esto dejó sin sentido el `ThumbnailProjectId` del
   listado (el implementador lo agregó para URLs de assets ajenos): se eliminó.
   Tests: repositorio (assets propios, PathCount), endpoint (documento reabierto del duplicado trae
   SVGs descargables y sobrevive al borrado del original; borrar un asset del original no borra el
   archivo del duplicado).
2. **Un primer Save fallido dejaba un proyecto fantasma** (sin documento, 0 capas) que ahora
   aparecería en Mis Proyectos. El Project se crea antes de validar paleta/capas porque los Assets
   necesitan su `ProjectId`. `VectorDocumentService.SaveAsync` ahora envuelve `SaveCoreAsync` y, si el
   Save que creó el Project no termina en `Saved`/`Replayed`, lo descarta con soft-delete. Reproducido
   (el listado tras un 422 `palette_not_confirmed` traía 1 ítem) antes del fix.

## Fuera de alcance / limitaciones conocidas

- El thumbnail es la imagen original reducida, no el render del vector.
- Proyectos v2 guardados antes de esta tarjeta no se pueden reabrir desde la lista (no existe el
  dato del triple; sin backfill).
- Los Assets huérfanos que deja un primer Save fallido a mitad del loop de subida siguen siendo
  huérfanos en storage (mismo trade-off ya documentado en `AssetService`).
- Warning de lint nuevo `react(set-state-in-effect)` en `ProjectsDashboard.tsx` — mismo patrón que
  `App.tsx` (sin errores de lint).

## Verificación

Ver el reporte de QA en la tarjeta de Notion y el PR (resultados de los 5 comandos corridos de forma
independiente por el orquestador).
