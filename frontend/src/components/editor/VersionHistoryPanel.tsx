import { useCallback, useEffect, useRef, useState } from "react";
import { listVersions, restoreVersion } from "../../api/vectorDocumentApi";
import { ApiClientError } from "../../api/httpClient";
import type { VectorDocumentVersionSummaryResponse } from "../../types/vectorDocument";

// Mapa de origen (wire value) a texto en español.
const ORIGIN_LABELS: Record<string, string> = {
  MANUAL_EDIT: "Guardado manual",
  AUTOSAVE: "Guardado automático",
  RESTORE: "Restauración",
  VECTORIZE: "Vectorización",
  AI_EDIT: "Edición por IA",
};

function originLabel(origin: string): string {
  return ORIGIN_LABELS[origin] ?? origin;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-AR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Resumen básico de la versión: el endpoint de listado (M2.2-S06) no expone el nº de capas, así que se muestra el tamaño físico. */
function formatSize(widthMm: number, heightMm: number): string {
  const format = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
  return `${format(widthMm)} × ${format(heightMm)} mm`;
}

export interface VersionHistoryPanelProps {
  projectId: string;
  currentVersionNumber: number | null;
  /** true si hay cambios de geometría sin guardar (se advierte al restaurar). */
  geometryDirty: boolean;
  /** Callback para cerrar el panel. */
  onClose: () => void;
  /** Llamado tras la confirmación del usuario y ANTES de pedir la restauración (p. ej. para pausar el autosave: no puede pisar la versión restaurada). */
  onBeforeRestore?: () => void;
  /** Llamado cuando el servidor confirmó la restauración, justo antes de recargar el documento. */
  onRestored?: () => void;
}

export function VersionHistoryPanel({
  projectId,
  currentVersionNumber,
  geometryDirty,
  onClose,
  onBeforeRestore,
  onRestored,
}: VersionHistoryPanelProps) {
  const [versions, setVersions] = useState<VectorDocumentVersionSummaryResponse[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [restoring, setRestoring] = useState<number | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Cargar versiones al abrir el panel.
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    listVersions(projectId, controller.signal)
      .then((data) => {
        setVersions(data);
        setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof ApiClientError && error.isAborted) return;
        setLoadState("error");
      });

    return () => controller.abort();
  }, [projectId]);

  const handleRestore = useCallback(
    async (versionNumber: number) => {
      // Si hay cambios sin guardar, confirmar con el usuario.
      if (geometryDirty) {
        const confirmed = window.confirm(
          "Hay cambios de geometría sin guardar. Si restaurás esta versión, perderás esos cambios. ¿Continuar?",
        );
        if (!confirmed) return;
      }

      setRestoring(versionNumber);
      setRestoreError(null);
      onBeforeRestore?.();

      try {
        const controller = new AbortController();
        abortRef.current = controller;

        await restoreVersion(projectId, versionNumber, controller.signal);

        onRestored?.();
        // Recargar el documento completo para reflejar la versión restaurada (el historial de undo se reinicia con él).
        window.location.reload();
      } catch (error: unknown) {
        setRestoring(null);
        if (error instanceof ApiClientError && error.isAborted) return;
        const body = (error instanceof ApiClientError ? error.body : undefined) as { message?: string } | undefined;
        setRestoreError(body?.message ?? "No se pudo restaurar la versión. Intentá de nuevo.");
      }
    },
    [projectId, geometryDirty, onBeforeRestore, onRestored],
  );

  // Cierre con Escape.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <aside
      id="editor-version-history-panel"
      className="editor-version-history-panel"
      aria-label="Historial de versiones"
    >
      <header className="editor-version-history-panel__header">
        <h2 className="editor-version-history-panel__title">Historial de versiones</h2>
        <button
          type="button"
          className="editor-version-history-panel__close"
          onClick={onClose}
          aria-label="Cerrar historial de versiones"
        >
          ×
        </button>
      </header>

      {/* Región live para anunciar actualizaciones de estado a lectores de pantalla. */}
      <div aria-live="polite" aria-atomic="true" className="editor-sr-only">
        {loadState === "loading" && "Cargando versiones…"}
        {restoring !== null && `Restaurando versión ${restoring}…`}
        {restoreError && `Error al restaurar: ${restoreError}`}
      </div>

      {loadState === "loading" && (
        <p className="editor-version-history-panel__loading">Cargando versiones…</p>
      )}

      {loadState === "error" && (
        <p className="editor-version-history-panel__error" role="alert">
          No se pudo cargar el historial de versiones. Cerrá y volvé a intentar.
        </p>
      )}

      {restoreError && (
        <p className="editor-version-history-panel__restore-error" role="alert">
          {restoreError}
        </p>
      )}

      {loadState === "ready" && versions.length === 0 && (
        <p className="editor-version-history-panel__empty">
          Este proyecto todavía no tiene versiones guardadas.
        </p>
      )}

      {loadState === "ready" && versions.length > 0 && (
        <ol className="editor-version-history-panel__list" aria-label="Lista de versiones">
          {versions.map((version) => {
            const isCurrent = version.versionNumber === currentVersionNumber;
            const isRestoring = restoring === version.versionNumber;

            return (
              <li
                key={version.versionNumber}
                className={`editor-version-history-panel__item${isCurrent ? " editor-version-history-panel__item--current" : ""}`}
              >
                <div className="editor-version-history-panel__item-info">
                  <span className="editor-version-history-panel__item-number">
                    v{version.versionNumber}
                    {isCurrent && (
                      <span className="editor-version-history-panel__current-badge" aria-label="versión actual">
                        {" "}(actual)
                      </span>
                    )}
                  </span>
                  <span className="editor-version-history-panel__item-origin">
                    {originLabel(version.origin)}
                  </span>
                  <span className="editor-version-history-panel__item-date">
                    {formatDate(version.createdAt)}
                  </span>
                  <span className="editor-version-history-panel__item-size">
                    {formatSize(version.widthMm, version.heightMm)}
                  </span>
                </div>

                {!isCurrent && (
                  <button
                    type="button"
                    className="editor-version-history-panel__restore-btn"
                    onClick={() => void handleRestore(version.versionNumber)}
                    disabled={restoring !== null}
                    aria-label={`Restaurar versión ${version.versionNumber} (${originLabel(version.origin)}, ${formatDate(version.createdAt)})`}
                  >
                    {isRestoring ? "Restaurando…" : "Restaurar"}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
