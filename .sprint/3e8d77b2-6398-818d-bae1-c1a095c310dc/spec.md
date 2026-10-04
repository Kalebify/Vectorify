# spec.md — M2.2-S08 · Pantalla Mis Proyectos

## Contexto

Octava tarjeta de MVP 2.2. El backend ya tiene el CRUD v2 completo (M2.2-S03: `POST/GET/PATCH/DELETE
/api/v2/projects`, `POST .../{id}/duplicate`, `GET /api/v2/projects?page&pageSize&search&sortBy`) y
la persistencia/reapertura del documento (S05–S07). Falta la **pantalla**: un dashboard que lista los
proyectos persistentes y permite completar el ciclo Create/Open/Rename/Duplicate/Delete.

Criterio de aceptación (Notion): "La pantalla usa datos reales de API y permite completar el ciclo
Create/Open/Rename/Duplicate/Delete con estados loading/empty/error." DoD: "Después de reiniciar la
app el usuario encuentra y abre sus proyectos desde esta pantalla."

## Decisiones técnicas tomadas por el orquestador (autonomía confirmada para el milestone)

1. **Open necesita el triple clásico.** Hoy el Workspace se reabre con `(projectId, imageId, paletteId)`
   clásicos + `savedProjectId` (`workspaceLocation.ts`, `App.resolveWorkspaceDeepLink`), pero el
   `Project` v2 NO guarda ese vínculo (el Save lo recibe en el request y lo descarta). Sin esto, Open
   desde la lista es imposible. **Se agregan 3 columnas nullable a `Project`**: `ClassicProjectId`,
   `ClassicImageId`, `ClassicPaletteId` (Guid?), seteadas en el PRIMER Save (cuando se crea el Project
   v2) y nunca más modificadas. Migration nueva. `Duplicate` las copia. Proyectos v2 preexistentes sin
   triple (creados antes de esta tarjeta, o vía `POST /api/v2/projects` vacío) quedan con null: la
   lista los muestra igual, pero "Abrir" muestra un error controlado ("Este proyecto no se puede
   reabrir…") en vez de navegar a un deep-link inválido. NO hay backfill (no existe el dato).
2. **Thumbnail = el original subido, reducido.** No hay rasterizador de SVG en el backend (solo
   ImageSharp 2.1.13, que no renderiza SVG). En el PRIMER Save, mejor-esfuerzo: leer el original
   clásico del triple, reducirlo con ImageSharp a ≤ 320 px de lado mayor (JPEG o PNG según
   corresponda; sin agrandar), guardarlo vía `IFileStorage` como `Asset` v2 (`Type` = `"thumbnail"`
   o el valor ya usado por `AssetUploadValidator`/`AssetService` si ya existe uno equivalente —
   revisar antes de inventar uno), y setear `Project.ThumbnailAssetId`. **Un fallo generando el
   thumbnail NUNCA hace fallar el Save** (log warning, `ThumbnailAssetId` queda null). `Duplicate`
   copia `ThumbnailAssetId` (mismo asset, consistente con "los Assets no se duplican").
   Limitación documentada: el thumbnail es la imagen original, no el render vectorial.
3. **Navegación sin `react-router`** (mismo criterio que M2.1-S06): la vista se identifica con la
   query string vía `URLSearchParams` + `pushState`. Sin params = **dashboard "Mis proyectos"
   (landing por defecto)**; `?view=new` = flujo clásico de upload (el que hoy es la home);
   params de Workspace (`projectId/imageId/paletteId[/savedProjectId]`) = Workspace (sin cambios).
   "New Project" y el CTA del empty state llevan a `?view=new`. Cerrar el Workspace con un
   `savedProjectId` vuelve al dashboard; sin él (staging sin guardar) vuelve al flujo `?view=new`.
   El flujo `?view=new` mantiene los pills de estado API/Python y un enlace "Mis proyectos".
4. **Paginación con controles anterior/siguiente** (page size 12), no scroll infinito: el backend
   ya devuelve `TotalCount`. Búsqueda con debounce de 300 ms (reinicia a página 1), sort
   `LastModified` (default) / `Name` / `Created` vía `sortBy` ya existente. Toggle Grid/List
   (preferencia en `localStorage`, con try/catch, solo conveniencia).

## Backend

- `Project` + migration: `ClassicProjectId`, `ClassicImageId`, `ClassicPaletteId` (`Guid?`).
- `VectorDocumentRepository.SaveAsync`/`VectorDocumentService.SaveAsync`: al crear el Project v2 en
  el primer Save, persistir el triple y generar el thumbnail (decisión 2). Saves posteriores no
  tocan ninguno de los dos. Idempotency replay no regenera nada.
- `ProjectSummaryResponse` gana: `LayerCount` (int, cantidad de `Layer` de la `CurrentVersion`; 0 si
  no hay versión), `ThumbnailUrl` (string?, apunta al endpoint de assets YA existente
  `/api/v2/projects/{id}/assets/{assetId}`; null si no hay thumbnail), `ClassicProjectId`,
  `ClassicImageId`, `ClassicPaletteId` (`Guid?`). `ProjectResponse` (detalle) gana el triple.
  `LayerCount` se calcula en la query de listado (proyección/subquery, **sin N+1** y sin cargar
  layers completos). El listado nunca descarga SVG ni el original.
- `ProjectService.DuplicateAsync` copia el triple y `ThumbnailAssetId` (además de lo que ya copia).
- No se cambian rutas ni semántica de errores existentes (404 uniforme por ownership, 409 xmin).

## Frontend

- `src/api/projectsV2Api.ts` (archivo nuevo — `projectsApi.ts` es del flujo clásico y NO se toca
  salvo imports): `listProjects({page,pageSize,search,sortBy,signal})`, `renameProject(id, name)`,
  `duplicateProject(id)`, `deleteProject(id)`, `getProject(id)`; tipos TS alineados al DTO.
- `src/components/projects/ProjectsDashboard.tsx` (+ CSS, + tests):
  - Header "VECTORiZE" + botón **New Project**; buscador; select de orden; toggle Grid/List.
  - Card/fila: thumbnail (`ThumbnailUrl`, con placeholder visible cuando es null **o** cuando la
    imagen falla al cargar), nombre, `N layers` (singular/plural correcto), última modificación
    (formato relativo legible, con `title`/fecha absoluta accesible), menú contextual
    (Abrir / Renombrar / Duplicar / Eliminar) operable por teclado y con `aria-*`; click en la
    card/nombre = Abrir.
  - Estados: skeleton mientras carga (no spinner global), empty state con CTA "Crear proyecto"
    (distinto del "sin resultados de búsqueda", que ofrece limpiar el filtro), error con botón
    Reintentar (error de red y error de API con mensajes distintos).
  - Rename: edición en el lugar o diálogo; valida nombre no vacío del lado cliente y muestra el
    error 400 del servidor; 404 (borrado en otra pestaña) y 409 (conflicto xmin) con mensaje
    claro y refresco de la lista.
  - Duplicate: la copia aparece en la lista (refresca respetando búsqueda/orden/página) y muestra
    feedback de éxito. Doble click no crea dos copias (botón/ítem deshabilitado en vuelo).
  - Delete: **diálogo de confirmación propio accesible** (nunca `window.confirm`) que nombra el
    proyecto; tras borrar, si la página queda vacía y no es la 1, retrocede una página.
  - Open: si el item no tiene el triple → error controlado (decisión 1). Con triple →
    `pushWorkspaceLocation({projectId, imageId, paletteId, savedProjectId: id})` y reutiliza
    `resolveWorkspaceDeepLink` (NO rehidrata nada por su cuenta).
- `App.tsx`/`workspaceLocation.ts`: vista por defecto = dashboard; `?view=new` = flujo clásico;
  helper(s) puros y testeados para leer/construir la vista; cierre del Workspace según decisión 3.
  Los banners/affordances existentes ("Continuar donde quedaste", deep link inválido) siguen
  funcionando y deben seguir siendo alcanzables (se muestran en el dashboard y/o en `?view=new`
  según corresponda — documentar la elección en IMPL.md).
- Responsive desktop como mínimo requerido; no debe romper en ≈ 768 px.
- Accesibilidad: roles/labels, foco gestionado al abrir/cerrar el diálogo y el menú, `Escape` cierra.

## Fuera de alcance

Login real (S09), filtros avanzados/tags/carpetas, selección múltiple/bulk delete, papelera con
restore, thumbnail renderizado del vector, backfill de proyectos preexistentes, react-router,
virtualización de lista.

## Tests exigidos (según la tarjeta + los puntos de arriba)

- Backend (Testcontainers PostgreSQL, nada de InMemory): primer Save persiste el triple y crea el
  thumbnail; Save 2 no los cambia; fallo de thumbnail no rompe el Save; listado devuelve
  `LayerCount` correcto (0 / N / sigue correcto tras PATCH y Restore) y `ThumbnailUrl`; no N+1
  (assert estructural o conteo de queries si es viable); duplicate copia triple+thumbnail;
  ownership (404 uniforme) y soft-delete excluidos; migration aplicable sobre datos existentes.
- Frontend: empty / 1 proyecto / 50+ (paginación) / search (debounce, reset de página) / sort /
  rename (ok, vacío, 400, 404, 409) / duplicate / delete (confirmar y cancelar) / error + retry /
  loading skeleton / thumbnail null y thumbnail roto / Open con y sin triple / toggle grid-list /
  navegación de vistas en `App` (default dashboard, `?view=new`, workspace, cierre).
- Los 5 comandos: `dotnet build`, `dotnet test`, `pytest` (python-engine, sin tocar),
  `npm test`, `npm run build`.

## DoD

Con la app reiniciada (nuevo proceso/DB persistente), el usuario ve sus proyectos guardados en
Mis Proyectos, los busca/ordena, y abre uno hasta el Workspace con su documento guardado.
