import { useCallback, useEffect, useRef, useState } from "react";
import { getColorPalette } from "./api/colorPaletteApi";
import { ApiClientError } from "./api/httpClient";
import { getOriginalImageUrl, getProjectImage } from "./api/projectsApi";
import { getPreviewImageUrl } from "./api/preprocessApi";
import { getSimplificationSvgUrl } from "./api/simplifyApi";
import { getVectorDocument } from "./api/vectorDocumentApi";
import { getVectorSvgUrl } from "./api/vectorizeApi";
import { ServiceCard } from "./components/ServiceCard";
import type { StatusTone } from "./components/StatusPill";
import { CheckPanel, type CheckSourceOption } from "./components/check/CheckPanel";
import { ColorPalettePanel } from "./components/colorPalette/ColorPalettePanel";
import { DimensionPanel, type DimensionSourceOption } from "./components/dimensions/DimensionPanel";
import { EditorShell } from "./components/editor/EditorShell";
import { ExportPanel, type ExportSourceOption } from "./components/export/ExportPanel";
import { LayersPanel } from "./components/layers/LayersPanel";
import { ProjectsDashboard } from "./components/projects/ProjectsDashboard";
import { PreprocessPanel } from "./components/preprocess/PreprocessPanel";
import { SimplifyPanel } from "./components/simplify/SimplifyPanel";
import { ThresholdPanel } from "./components/threshold/ThresholdPanel";
import { UploadPanel } from "./components/upload/UploadPanel";
import { VectorizePanel } from "./components/vectorize/VectorizePanel";
import { useSystemHealth } from "./hooks/useSystemHealth";
import {
  clearWorkspaceLocation,
  pushAppView,
  pushWorkspaceLocation,
  readAppView,
  readWorkspaceLocation,
  type PageView,
  type WorkspaceLocation,
} from "./lib/workspaceLocation";
import {
  clearWorkspaceRecoveryPointer,
  readRecentWorkspaceRecoveryPointer,
  type WorkspaceRecoveryPointer,
} from "./lib/workspaceRecovery";
import type { ColorPaletteResponse } from "./types/colorPalette";
import type { DimensionResponse } from "./types/dimension";
import type { PreprocessResponse } from "./types/preprocess";
import type { SimplifyResponse } from "./types/simplify";
import type { PythonStatus } from "./types/system";
import type { ThresholdResponse } from "./types/threshold";
import type { UploadImageResponse } from "./types/upload";
import type { VectorizeResponse } from "./types/vectorize";
import "./App.css";

const PYTHON_STATUS_LABEL: Record<PythonStatus, string> = {
  online: "En línea",
  unavailable: "No disponible",
  timeout: "Tiempo de espera agotado",
  invalid_response: "Respuesta inválida",
  error: "Error",
};

const PYTHON_STATUS_TONE: Record<PythonStatus, StatusTone> = {
  online: "ok",
  unavailable: "error",
  timeout: "warn",
  invalid_response: "warn",
  error: "error",
};

const BANNER_COPY: Record<"loading" | "online" | "degraded" | "error", string> = {
  loading: "Consultando el estado del sistema…",
  online: "Todos los servicios están en línea.",
  // Desde M2.2-S01 "degraded" puede deberse a Python O a PostgreSQL (ver
  // GET /api/v1/system/health, campo "database") -- copy deliberadamente
  // genérico para no atribuir el problema a un servicio específico que
  // podría no ser el real. El detalle por servicio ya se ve en las
  // ServiceCard de abajo.
  degraded: "La Web API está en línea, pero uno o más servicios dependientes presentan problemas.",
  error: "No se pudo contactar a la Web API.",
};

/**
 * El Laser Checker (M1-S08) acepta como fuente cualquiera de los dos SVG ya
 * generados del pipeline: el vector original (M1-S05) o -- si el usuario ya
 * aplicó una simplificación (M1-S07) -- esa versión simplificada. Se
 * ofrecen ambos como opciones en vez de reemplazar uno por otro: el spec no
 * define cuál "debería" analizarse, y un usuario puede querer comparar los
 * issues antes/después de simplificar.
 */
function buildCheckSources(
  project: UploadImageResponse,
  vector: VectorizeResponse,
  simplification: SimplifyResponse | null,
): CheckSourceOption[] {
  const sources: CheckSourceOption[] = [
    {
      kind: "vector",
      id: vector.vectorId,
      label: "Vector actual",
      svgUrl: getVectorSvgUrl(project.projectId, project.imageId, vector.vectorId),
      width: vector.width,
      height: vector.height,
    },
  ];

  if (simplification) {
    sources.push({
      kind: "simplification",
      id: simplification.simplificationId,
      label: "Última simplificación",
      svgUrl: getSimplificationSvgUrl(project.projectId, project.imageId, simplification.simplificationId),
      width: simplification.width,
      height: simplification.height,
    });
  }

  return sources;
}

/**
 * M1-S09 opera sobre el mismo par de fuentes que el Laser Checker (M1-S08):
 * el vector original o -- si ya existe -- la última simplificación aplicada
 * (ver spec.md, "no está definido si opera sobre VectorVersion o
 * SimplificationVersion" -- se aceptan ambas, mismo criterio que
 * buildCheckSources).
 */
function buildDimensionSources(
  vector: VectorizeResponse,
  simplification: SimplifyResponse | null,
): DimensionSourceOption[] {
  const sources: DimensionSourceOption[] = [
    { kind: "vector", id: vector.vectorId, label: "Vector actual", widthPx: vector.width, heightPx: vector.height },
  ];

  if (simplification) {
    sources.push({
      kind: "simplification",
      id: simplification.simplificationId,
      label: "Última simplificación",
      widthPx: simplification.width,
      heightPx: simplification.height,
    });
  }

  return sources;
}

/**
 * M1-S10 cierra el pipeline dejando elegir CUALQUIERA de los tres artefactos
 * SVG ya persistidos: el vector original, la última simplificación (si se
 * aplicó) y la última versión con dimensiones físicas en mm (si se aplicó) --
 * extiende a un tercer valor el mismo patrón dual de buildCheckSources/
 * buildDimensionSources. checkSourceKind/checkSourceId de la fuente
 * "dimension" apuntan al vector/simplificación de origen (nunca al propio
 * dimensionId): el Laser Checker (M1-S08) no tiene un sourceKind "dimension"
 * porque Dimensioning nunca toca los `d` de los paths -- la geometría es
 * idéntica a la de su fuente.
 */
function buildExportSources(
  vector: VectorizeResponse,
  simplification: SimplifyResponse | null,
  dimension: DimensionResponse | null,
): ExportSourceOption[] {
  const sources: ExportSourceOption[] = [
    {
      kind: "vector",
      id: vector.vectorId,
      label: "Vector actual",
      version: vector.version,
      widthPx: vector.width,
      heightPx: vector.height,
      checkSourceKind: "vector",
      checkSourceId: vector.vectorId,
    },
  ];

  if (simplification) {
    sources.push({
      kind: "simplification",
      id: simplification.simplificationId,
      label: "Última simplificación",
      version: simplification.version,
      widthPx: simplification.width,
      heightPx: simplification.height,
      checkSourceKind: "simplification",
      checkSourceId: simplification.simplificationId,
    });
  }

  if (dimension) {
    sources.push({
      kind: "dimension",
      id: dimension.dimensionId,
      label: "Última versión con dimensiones físicas",
      version: dimension.version,
      widthPx: dimension.sourceWidthPx,
      heightPx: dimension.sourceHeightPx,
      widthMm: dimension.widthMm,
      heightMm: dimension.heightMm,
      checkSourceKind: dimension.sourceKind,
      checkSourceId: dimension.sourceId,
    });
  }

  return sources;
}

function App() {
  const { status, response, errorMessage, lastCheckedAt } = useSystemHealth();
  const [activeProject, setActiveProject] = useState<UploadImageResponse | null>(null);
  const [confirmedPalette, setConfirmedPalette] = useState<ColorPaletteResponse | null>(null);
  // paletteId del triple clásico que EditorShell necesita como prop (M2.2-S05): se mantiene
  // aparte de `confirmedPalette` porque la reapertura vía `savedProjectId` NO llama a
  // GET .../color-palette/{paletteId} (ver resolveWorkspaceDeepLink) y por lo tanto nunca
  // resuelve ese objeto completo, pero igual necesita el id para las mutaciones del Workspace
  // (que siguen resolviéndose contra los sidecars clásicos en esta tarjeta).
  const [workspacePaletteId, setWorkspacePaletteId] = useState<string | null>(null);
  // Selección COMPARTIDA paleta<->Layers (M2.1-S04): un único groupId
  // "seleccionado", resaltado a la vez en ColorSwatchList y LayerList --
  // vive acá (padre común de ambos paneles) en vez de en cualquiera de los
  // dos, así que un click en cualquiera de los dos lados sincroniza al otro.
  const [selectedLayerGroupId, setSelectedLayerGroupId] = useState<string | null>(null);
  // Workspace del Editor General (M2.1-S06): pantalla central nueva,
  // integrando en un layout propio todo lo que MVP2/MVP2.1 ya construyó
  // como paneles sueltos (ver EditorShell). Vive DETRÁS de un toggle
  // explícito en vez de reemplazar el flujo clásico de abajo -- ese flujo
  // sigue siendo el único lugar donde se detecta/confirma la paleta y se
  // generan las capas (precondiciones del Workspace), y ninguna tarjeta
  // pidió todavía retirarlo.
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState(false);
  // Vista de página (M2.2-S08): sin params = dashboard "Mis proyectos" (landing por defecto);
  // `?view=new` = flujo clásico de upload. El Workspace NO es una vista de página acá: sigue
  // gobernado por `isWorkspaceOpen` + los params de la URL (ver lib/workspaceLocation.ts). Una URL
  // de arranque de Workspace parte en "dashboard": si el deep-link resulta inválido, ahí aterriza.
  const [view, setView] = useState<PageView>(() => (readAppView() === "new" ? "new" : "dashboard"));
  const isWorkspaceOpenRef = useRef(false);
  // Project.Id v2 ya guardado de la sesión actual del Workspace (M2.2-S05) -- null hasta que el
  // primer Save exitoso lo resuelva (ver EditorShell.onSaved más abajo), o ya conocido de
  // entrada si la URL lo traía (reapertura/reload, ver resolveWorkspaceDeepLink).
  const [savedProjectId, setSavedProjectId] = useState<string | null>(null);
  const [readyPreview, setReadyPreview] = useState<PreprocessResponse | null>(null);
  const [readyMask, setReadyMask] = useState<ThresholdResponse | null>(null);
  const [readyVector, setReadyVector] = useState<VectorizeResponse | null>(null);
  const [readySimplification, setReadySimplification] = useState<SimplifyResponse | null>(null);
  const [readyDimension, setReadyDimension] = useState<DimensionResponse | null>(null);

  // Reapertura del Workspace por URL (M2.1-S08): si la URL YA trae
  // projectId/imageId/paletteId (reload dentro del Workspace, o un
  // deep-link pegado a mano), reconstruye `activeProject` (nuevo endpoint
  // de metadata) y `confirmedPalette` (GET ya existente) en vez de arrancar
  // siempre en Upload -- ver lib/workspaceLocation.ts. Corre una sola vez,
  // al montar: abrir/cerrar el Workspace desde el flujo normal actualiza la
  // URL pero no vuelve a disparar esta resolución (ver
  // handlePaletteConfirmed/"Abrir en el Workspace" y el onClose de
  // EditorShell más abajo).
  const [deepLinkStatus, setDeepLinkStatus] = useState<"idle" | "resolving" | "invalid">("idle");
  const [deepLinkMessage, setDeepLinkMessage] = useState<string | null>(null);
  const deepLinkResolvedRef = useRef(false);

  // Recovery local de staging (M2.2-S07, "Continuar donde quedaste"): SOLO se ofrece cuando la
  // URL de arranque NO trae ya un deep-link propio (ver el efecto de montaje más abajo) -- un
  // deep-link explícito siempre tiene prioridad. El puntero nunca rehidrata el documento desde
  // localStorage: `handleContinueWhereLeftOff` reusa EXACTAMENTE `resolveWorkspaceDeepLink`, que
  // vuelve a pedirle todo al backend (ver spec.md M2.2-S07, "Recuperación al cerrar la pestaña").
  const [recoveryPointer, setRecoveryPointer] = useState<WorkspaceRecoveryPointer | null>(null);

  // Extraída (en vez de vivir inline en el efecto) para que el `setState`
  // síncrono de "resolving" quede fuera del cuerpo directo del efecto --
  // mismo patrón ya usado en useVectorDocument.load/useEffect.
  const resolveWorkspaceDeepLink = useCallback((location: WorkspaceLocation) => {
    setDeepLinkStatus("resolving");

    // Un deep-link inválido limpia la URL (queda sin params = dashboard) y aterriza en "Mis
    // proyectos" (M2.2-S08), donde se muestra el aviso -- sin importar desde qué vista partió.
    const failToDashboard = () => {
      clearWorkspaceLocation();
      setView("dashboard");
    };

    (async () => {
      let project: UploadImageResponse;
      try {
        project = await getProjectImage(location.projectId, location.imageId);
      } catch (error) {
        failToDashboard();
        setDeepLinkStatus("invalid");
        setDeepLinkMessage(
          error instanceof ApiClientError && !error.isNetworkError
            ? "El proyecto de esta URL ya no existe. Subí una imagen para empezar un proyecto nuevo."
            : "No se pudo recuperar el proyecto de esta URL. Intentá de nuevo más tarde.",
        );
        return;
      }

      // Reapertura de un Workspace YA GUARDADO (M2.2-S05): si la URL trae
      // savedProjectId, se prioriza GET /api/v2/projects/{id}/document para
      // validar que el documento guardado sigue existiendo -- en vez de
      // GET .../color-palette/{paletteId} (que valida el estado clásico de
      // staging, ya no la fuente de verdad una vez que hay un Project.Id v2).
      // useVectorDocument hace la reconstrucción real del documento (sin pasar
      // por la agregación clásica de 3 endpoints) una vez que EditorShell
      // recibe savedProjectId -- acá solo se valida que el deep-link es
      // válido antes de abrir el Workspace.
      if (location.savedProjectId) {
        try {
          await getVectorDocument(location.savedProjectId);
        } catch (error) {
          failToDashboard();
          setDeepLinkStatus("invalid");
          setDeepLinkMessage(
            error instanceof ApiClientError && !error.isNetworkError
              ? "El documento guardado de esta URL ya no existe."
              : "No se pudo recuperar el documento guardado de esta URL. Intentá de nuevo más tarde.",
          );
          return;
        }

        setActiveProject(project);
        setWorkspacePaletteId(location.paletteId);
        setSavedProjectId(location.savedProjectId);
        setIsWorkspaceOpen(true);
        setDeepLinkStatus("idle");
        return;
      }

      let palette: ColorPaletteResponse;
      try {
        palette = await getColorPalette(location.projectId, location.imageId, location.paletteId);
      } catch (error) {
        failToDashboard();
        setDeepLinkStatus("invalid");
        setDeepLinkMessage(
          error instanceof ApiClientError && !error.isNetworkError
            ? "La paleta de esta URL ya no existe. Volvé a confirmar una paleta desde el proyecto."
            : "No se pudo recuperar la paleta de esta URL. Intentá de nuevo más tarde.",
        );
        return;
      }

      // Nota: si `palette.isConfirmed` es false, EditorShell/useVectorDocument
      // ya maneja ese caso con `emptyReason: "palette_not_confirmed"` (mismo
      // criterio reusado tal cual, sin duplicar esa lógica acá).
      setActiveProject(project);
      setConfirmedPalette(palette);
      setWorkspacePaletteId(palette.paletteId);
      setIsWorkspaceOpen(true);
      setDeepLinkStatus("idle");
    })();
  }, []);

  useEffect(() => {
    if (deepLinkResolvedRef.current) return;
    deepLinkResolvedRef.current = true;

    const location = readWorkspaceLocation();
    if (location) {
      resolveWorkspaceDeepLink(location);
      return;
    }

    // Sin deep-link en la URL de arranque: ofrece "Continuar donde quedaste" si hay un puntero
    // de staging reciente (últimas 24 h, ver lib/workspaceRecovery.ts) -- un simple affordance
    // descartable, nunca una navegación automática.
    const pointer = readRecentWorkspaceRecoveryPointer();
    if (pointer) {
      setRecoveryPointer(pointer);
    }
  }, [resolveWorkspaceDeepLink]);

  useEffect(() => {
    isWorkspaceOpenRef.current = isWorkspaceOpen;
  }, [isWorkspaceOpen]);

  // Botón atrás/adelante del navegador (M2.2-S08): mantiene la vista de página sincronizada con la
  // URL (dashboard <-> `?view=new`), y re-resuelve un deep-link de Workspace al volver a uno.
  // Con el Workspace ABIERTO no hace nada (mismo comportamiento que antes de esta tarjeta): cerrar
  // el editor por un popstate podría descartar un guardado en vuelo.
  useEffect(() => {
    const handlePopState = () => {
      if (isWorkspaceOpenRef.current) return;

      const next = readAppView();
      if (next === "workspace") {
        const location = readWorkspaceLocation();
        if (location) resolveWorkspaceDeepLink(location);
        return;
      }

      setView(next);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [resolveWorkspaceDeepLink]);

  const navigateToView = (next: PageView) => {
    pushAppView(next);
    setView(next);
  };

  // "New Project" / "Crear proyecto" del dashboard: arranca el flujo clásico de upload en limpio
  // (sin restos del proyecto de una sesión anterior).
  const handleNewProject = () => {
    handleProjectCreated(null);
    navigateToView("new");
  };

  // Open desde Mis Proyectos: la URL se actualiza ANTES de resolver (un reload inmediato
  // reconstruye la misma sesión) y se reusa EXACTAMENTE resolveWorkspaceDeepLink -- que valida
  // GET /api/v2/projects/{id}/document y reabre el Workspace sin rehidratar nada por su cuenta.
  const handleOpenSavedProject = (location: WorkspaceLocation) => {
    handleProjectCreated(null);
    pushWorkspaceLocation(location);
    resolveWorkspaceDeepLink(location);
  };

  const handleContinueWhereLeftOff = () => {
    if (!recoveryPointer) return;

    const location: WorkspaceLocation = {
      projectId: recoveryPointer.classicProjectId,
      imageId: recoveryPointer.imageId,
      paletteId: recoveryPointer.paletteId,
    };

    setRecoveryPointer(null);
    // Refleja la ubicación en la URL ANTES de resolver (mismo criterio que "Abrir en el
    // Workspace" más abajo) -- un reload inmediatamente después reconstruye la misma sesión.
    pushWorkspaceLocation(location);
    resolveWorkspaceDeepLink(location);
  };

  const handleDismissRecovery = () => {
    setRecoveryPointer(null);
    clearWorkspaceRecoveryPointer();
  };

  const handleProjectCreated = (project: UploadImageResponse | null) => {
    setConfirmedPalette(null);
    setWorkspacePaletteId(null);
    setSavedProjectId(null);
    setSelectedLayerGroupId(null);
    setIsWorkspaceOpen(false);
    setReadyPreview(null);
    setReadyMask(null);
    setReadyVector(null);
    setReadySimplification(null);
    setReadyDimension(null);
    setActiveProject(project);
  };

  // M2-S02 (Layers) consume la paleta CONFIRMADA de M2-S01: recién ahí se
  // activa el panel de capas. Independiente del resto del pipeline de MVP1
  // (preprocess -> threshold -> vectorize -> ...): confirmar la paleta no
  // invalida ningún estado de esa rama, son flujos paralelos sobre la misma
  // imagen original.
  const handlePaletteConfirmed = (palette: ColorPaletteResponse) => {
    setConfirmedPalette(palette);
    setWorkspacePaletteId(palette.paletteId);
    // Una paleta recién confirmada/reconfirmada reinicia cualquier Project.Id v2 de una sesión
    // anterior del Workspace: el triple clásico cambió, así que un Save nuevo debe resolver su
    // propio Project (M2.2-S05).
    setSavedProjectId(null);
  };

  const handlePreviewReady = (preview: PreprocessResponse) => {
    setReadyMask(null);
    setReadyVector(null);
    setReadySimplification(null);
    setReadyDimension(null);
    setReadyPreview(preview);
  };

  const handleMaskReady = (mask: ThresholdResponse) => {
    setReadyVector(null);
    setReadySimplification(null);
    setReadyDimension(null);
    setReadyMask(mask);
  };

  const handleVectorReady = (vector: VectorizeResponse) => {
    setReadySimplification(null);
    setReadyDimension(null);
    setReadyVector(vector);
  };

  // Una simplificación nueva invalida cualquier DimensionVersion vigente que
  // se haya derivado de la simplificación ANTERIOR (aunque el SVG dimensionado
  // en sí siga existiendo intacto en el storage, ya no sería "la última
  // versión" con la que tiene sentido seguir trabajando en el resto del
  // pipeline) -- mismo criterio de invalidación en cascada que handleVectorReady.
  const handleSimplificationApplied = (simplification: SimplifyResponse) => {
    setReadyDimension(null);
    setReadySimplification(simplification);
  };

  const apiTone: StatusTone =
    status === "loading" ? "neutral" : status === "error" ? "error" : "ok";
  const apiLabel =
    status === "loading" ? "Consultando…" : status === "error" ? "Sin conexión" : "En línea";

  const pythonTone: StatusTone =
    status === "loading" || status === "error"
      ? "neutral"
      : PYTHON_STATUS_TONE[response!.python.status];
  const pythonLabel =
    status === "loading"
      ? "Consultando…"
      : status === "error"
        ? "Desconocido"
        : PYTHON_STATUS_LABEL[response!.python.status];

  if (isWorkspaceOpen && activeProject && workspacePaletteId) {
    return (
      <EditorShell
        projectId={activeProject.projectId}
        imageId={activeProject.imageId}
        paletteId={workspacePaletteId}
        projectName={activeProject.filename}
        savedProjectId={savedProjectId}
        dimensionId={readyDimension?.dimensionId ?? null}
        dimensionWidthMm={readyDimension?.widthMm ?? null}
        onSaved={(newSavedProjectId) => {
          setSavedProjectId(newSavedProjectId);
          // Agrega savedProjectId a la URL SIN recargar la página (M2.2-S05, "Reapertura") --
          // un reload inmediatamente después reconstruye la misma sesión YA GUARDADA vía
          // GET /api/v2/projects/{id}/document, en vez de volver a pasar por el flujo clásico.
          pushWorkspaceLocation({
            projectId: activeProject.projectId,
            imageId: activeProject.imageId,
            paletteId: workspacePaletteId,
            savedProjectId: newSavedProjectId,
          });
        }}
        onClose={() => {
          setIsWorkspaceOpen(false);
          // Cerrar un Workspace YA GUARDADO vuelve a Mis proyectos; uno todavía en staging (sin
          // savedProjectId) vuelve al flujo clásico `?view=new`, donde sigue su estado (M2.2-S08).
          navigateToView(savedProjectId ? "dashboard" : "new");
        }}
      />
    );
  }

  if (deepLinkStatus === "resolving") {
    return (
      <p className="app-header__subtitle" role="status">
        Recuperando el proyecto de esta URL…
      </p>
    );
  }

  // Avisos de la reapertura del Workspace: se muestran en AMBAS vistas de página (el deep-link
  // inválido aterriza en el dashboard; "Continuar donde quedaste" se ofrece donde sea que parta la
  // app) para que sigan siendo alcanzables ahora que la home ya no es el flujo de upload.
  const workspaceNotices = (
    <>
      {deepLinkStatus === "invalid" && deepLinkMessage && (
        <div aria-label="Enlace del Workspace inválido" className="status-banner status-banner--error" role="alert">
          <p>{deepLinkMessage}</p>
        </div>
      )}

      {recoveryPointer && (
        <div aria-label="Recuperar sesión del Workspace" className="status-banner" role="status">
          <p>Encontramos una sesión del Workspace sin guardar de tu última visita.</p>
          <button type="button" className="upload-actions__button upload-actions__button--primary" onClick={handleContinueWhereLeftOff}>
            Continuar donde quedaste
          </button>
          <button type="button" className="upload-actions__button" onClick={handleDismissRecovery}>
            Descartar
          </button>
        </div>
      )}
    </>
  );

  if (view === "dashboard") {
    return (
      <ProjectsDashboard
        onNewProject={handleNewProject}
        onOpenProject={handleOpenSavedProject}
        notices={workspaceNotices}
      />
    );
  }

  return (
    <>
      <header className="app-header">
        <h1>Vectorify</h1>
        <p className="app-header__subtitle">
          Vectorizá tus imágenes: cargá un original y verificá el estado del sistema.
        </p>
        <nav aria-label="Navegación principal">
          <a
            href={window.location.pathname}
            onClick={(event) => {
              event.preventDefault();
              navigateToView("dashboard");
            }}
          >
            Mis proyectos
          </a>
        </nav>
      </header>

      <main>
        {workspaceNotices}

        <section aria-labelledby="upload-heading" className="upload-section">
          <h2 id="upload-heading">Nuevo proyecto</h2>
          <p className="upload-section__hint">
            Arrastrá o seleccioná una imagen para crear un proyecto a partir de ella. El
            original se guarda tal cual: el preprocesamiento trabaja sobre una copia.
          </p>
          <UploadPanel onProjectCreated={handleProjectCreated} />
        </section>

        {activeProject && (
          <section aria-labelledby="color-palette-heading" className="color-palette-section">
            <h2 id="color-palette-heading">Paleta de colores</h2>
            <p className="upload-section__hint">
              Arranca el flujo multicapa: detectá los colores dominantes de la imagen original, fusioná los que sean
              parecidos, renombralos y confirmá la paleta. Cada color confirmado será una operación de láser distinta
              más adelante. El original nunca se modifica.
            </p>
            <ColorPalettePanel
              key={`${activeProject.projectId}-${activeProject.imageId}`}
              projectId={activeProject.projectId}
              imageId={activeProject.imageId}
              fileName={activeProject.filename}
              originalUrl={getOriginalImageUrl(activeProject.projectId, activeProject.imageId)}
              originalWidth={activeProject.width ?? 0}
              originalHeight={activeProject.height ?? 0}
              onConfirmed={handlePaletteConfirmed}
              selectedLayerGroupId={selectedLayerGroupId}
              onSelectLayerGroup={setSelectedLayerGroupId}
            />

            {confirmedPalette && (
              <p className="upload-section__hint">
                Paleta confirmada.{" "}
                <button
                  type="button"
                  className="upload-actions__button upload-actions__button--primary"
                  onClick={() => {
                    // La URL se actualiza ACÁ (no en un efecto) para que un reload
                    // inmediatamente después reconstruya la misma sesión (M2.1-S08,
                    // spec.md punto 4 del alcance) -- no solo un deep-link pegado a mano.
                    pushWorkspaceLocation({
                      projectId: activeProject.projectId,
                      imageId: activeProject.imageId,
                      paletteId: confirmedPalette.paletteId,
                    });
                    setIsWorkspaceOpen(true);
                  }}
                >
                  Abrir en el Workspace
                </button>
              </p>
            )}
          </section>
        )}

        {activeProject && confirmedPalette && (
          <section aria-labelledby="layers-heading" className="layers-section">
            <h2 id="layers-heading">Capas por color</h2>
            <p className="upload-section__hint">
              Convertí cada color confirmado en una capa vectorial independiente y alineada: aislá, ocultá o
              combiná las capas visibles en el mismo canvas. Ninguna capa se recorta a su propia forma: todas
              comparten el mismo sistema de coordenadas que la imagen original.
            </p>
            <LayersPanel
              key={`${activeProject.projectId}-${activeProject.imageId}-${confirmedPalette.paletteId}-${confirmedPalette.version}`}
              projectId={activeProject.projectId}
              imageId={activeProject.imageId}
              paletteId={confirmedPalette.paletteId}
              selectedGroupId={selectedLayerGroupId}
              onSelectGroup={setSelectedLayerGroupId}
              originalUrl={getOriginalImageUrl(activeProject.projectId, activeProject.imageId)}
              originalWidth={activeProject.width ?? undefined}
              originalHeight={activeProject.height ?? undefined}
            />
          </section>
        )}

        {activeProject && (
          <section aria-labelledby="preprocess-heading" className="preprocess-section">
            <h2 id="preprocess-heading">Preprocesamiento</h2>
            <p className="upload-section__hint">
              Ajustá escala de grises, contraste, brillo y reducción de ruido para preparar la
              imagen antes de vectorizarla. El original nunca se modifica.
            </p>
            <PreprocessPanel
              key={`${activeProject.projectId}-${activeProject.imageId}`}
              projectId={activeProject.projectId}
              imageId={activeProject.imageId}
              fileName={activeProject.filename}
              originalWidth={activeProject.width}
              originalHeight={activeProject.height}
              onPreviewReady={handlePreviewReady}
            />
          </section>
        )}

        {activeProject && readyPreview && (
          <section aria-labelledby="threshold-heading" className="threshold-section">
            <h2 id="threshold-heading">Threshold blanco y negro</h2>
            <p className="upload-section__hint">
              Ajustá el umbral y la inversión para convertir el preview preprocesado en una
              máscara binaria apta para vectorizar. El preview preprocesado nunca se modifica.
            </p>
            <ThresholdPanel
              key={`${activeProject.projectId}-${activeProject.imageId}-${readyPreview.previewId}`}
              projectId={activeProject.projectId}
              imageId={activeProject.imageId}
              fileName={activeProject.filename}
              sourcePreviewId={readyPreview.previewId}
              sourcePreviewUrl={getPreviewImageUrl(activeProject.projectId, activeProject.imageId, readyPreview.previewId)}
              sourceWidth={readyPreview.width}
              sourceHeight={readyPreview.height}
              onMaskReady={handleMaskReady}
            />
          </section>
        )}

        {activeProject && readyMask && (
          <section aria-labelledby="vectorize-heading" className="vectorize-section">
            <h2 id="vectorize-heading">Vectorización</h2>
            <p className="upload-section__hint">
              Pulsá "Vectorizar" para convertir la máscara binaria en un SVG. El motor de
              trazado corre del lado del servidor; la máscara nunca se modifica. Una vez listo,
              podés compararlo contra el original con zoom, pan y ajuste a pantalla.
            </p>
            <VectorizePanel
              key={`${activeProject.projectId}-${activeProject.imageId}-${readyMask.maskId}`}
              projectId={activeProject.projectId}
              imageId={activeProject.imageId}
              fileName={activeProject.filename}
              sourceMaskId={readyMask.maskId}
              originalUrl={getOriginalImageUrl(activeProject.projectId, activeProject.imageId)}
              originalWidth={activeProject.width}
              originalHeight={activeProject.height}
              onVectorReady={handleVectorReady}
            />
          </section>
        )}

        {activeProject && readyVector && (
          <section aria-labelledby="simplify-heading" className="simplify-section">
            <h2 id="simplify-heading">Simplificación de nodos</h2>
            <p className="upload-section__hint">
              El trazado puede generar miles de nodos. Elegí una tolerancia, revisá el preview
              (nodos antes/después y % de reducción) y aplicá solo si el resultado te convence.
              Cancelar no persiste nada: el SVG ya vectorizado nunca se sobrescribe.
            </p>
            <SimplifyPanel
              key={`${activeProject.projectId}-${activeProject.imageId}-${readyVector.vectorId}`}
              projectId={activeProject.projectId}
              imageId={activeProject.imageId}
              fileName={activeProject.filename}
              sourceVectorId={readyVector.vectorId}
              currentVectorUrl={getVectorSvgUrl(activeProject.projectId, activeProject.imageId, readyVector.vectorId)}
              currentVectorWidth={readyVector.width}
              currentVectorHeight={readyVector.height}
              onSimplificationApplied={handleSimplificationApplied}
            />
          </section>
        )}

        {activeProject && readyVector && (
          <section aria-labelledby="check-heading" className="check-section">
            <h2 id="check-heading">Paths abiertos y duplicados</h2>
            <p className="upload-section__hint">
              Analizá el SVG en busca de geometría que puede producir cortes láser inesperados:
              paths que deberían estar cerrados y no lo están, y segmentos duplicados o
              casi-duplicados. El análisis es de solo lectura: nunca modifica el SVG, y se ejecuta
              solo cuando lo pedís.
            </p>
            <CheckPanel
              key={`${activeProject.projectId}-${activeProject.imageId}-${readyVector.vectorId}-${readySimplification?.simplificationId ?? "none"}`}
              projectId={activeProject.projectId}
              imageId={activeProject.imageId}
              fileName={activeProject.filename}
              sources={buildCheckSources(activeProject, readyVector, readySimplification)}
            />
          </section>
        )}

        {activeProject && readyVector && (
          <section aria-labelledby="dimension-heading" className="dimension-section">
            <h2 id="dimension-heading">Dimensiones físicas</h2>
            <p className="upload-section__hint">
              Definí el ancho o el alto en milímetros para fabricación con láser. Con la proporción
              bloqueada (default) el otro valor se calcula automáticamente; desbloqueada, podés
              definir ambos de forma independiente (esto deforma el diseño). El SVG resultante
              conserva su tamaño físico al reabrirlo en cualquier visor.
            </p>
            <DimensionPanel
              key={`${activeProject.projectId}-${activeProject.imageId}-${readyVector.vectorId}-${readySimplification?.simplificationId ?? "none"}`}
              projectId={activeProject.projectId}
              imageId={activeProject.imageId}
              sources={buildDimensionSources(readyVector, readySimplification)}
              onDimensionApplied={setReadyDimension}
            />
          </section>
        )}

        {activeProject && readyVector && (
          <section aria-labelledby="export-heading" className="export-section">
            <h2 id="export-heading">Exportar SVG</h2>
            <p className="upload-section__hint">
              Elegí qué versión descargar (vector, simplificación o dimensión física), revisá su
              tamaño y los issues del Laser Checker, y descargá el archivo. El Laser Checker es
              solo informativo: nunca impide la descarga, y el archivo exportado es exactamente el
              mismo SVG ya generado por esa etapa, sin modificar su geometría.
            </p>
            <ExportPanel
              key={`${activeProject.projectId}-${activeProject.imageId}-${readyVector.vectorId}-${readySimplification?.simplificationId ?? "none"}-${readyDimension?.dimensionId ?? "none"}`}
              projectId={activeProject.projectId}
              imageId={activeProject.imageId}
              sources={buildExportSources(readyVector, readySimplification, readyDimension)}
            />
          </section>
        )}

        <section aria-labelledby="diagnostics-heading">
          <h2 id="diagnostics-heading">Diagnóstico del sistema</h2>

          <div aria-label="Resumen general" className={`status-banner status-banner--${status}`}>
            <p>{BANNER_COPY[status]}</p>
          </div>

          <div aria-label="Estado de los servicios" className="service-grid">
            <ServiceCard title="Web API (ASP.NET Core)" tone={apiTone} statusLabel={apiLabel}>
              {status === "error" ? (
                <p className="service-card__message">
                  {errorMessage ?? "No se pudo establecer conexión con la Web API."}
                </p>
              ) : status === "loading" ? (
                <p className="service-card__message">Esperando la respuesta de la Web API.</p>
              ) : (
                <p className="service-card__message">
                  La Web API respondió correctamente a la última consulta de salud.
                </p>
              )}
            </ServiceCard>

            <ServiceCard title="Motor Python (FastAPI)" tone={pythonTone} statusLabel={pythonLabel}>
              {status === "loading" || status === "error" ? (
                <p className="service-card__message">
                  El estado del motor Python depende de la Web API; todavía no hay datos.
                </p>
              ) : (
                <dl className="service-card__details">
                  <div>
                    <dt>Servicio</dt>
                    <dd>{response!.python.service ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Versión</dt>
                    <dd>{response!.python.version ?? "—"}</dd>
                  </div>
                  {response!.python.message && (
                    <div>
                      <dt>Detalle</dt>
                      <dd>{response!.python.message}</dd>
                    </div>
                  )}
                </dl>
              )}
            </ServiceCard>
          </div>

          <p className="last-checked">
            {lastCheckedAt
              ? `Última verificación: ${lastCheckedAt.toLocaleTimeString()}`
              : "Aún no se realizó ninguna verificación."}
          </p>
        </section>
      </main>

      <footer className="app-footer">
        <p>Vectorify · M2-S02 · Capas por color</p>
      </footer>
    </>
  );
}

export default App;
