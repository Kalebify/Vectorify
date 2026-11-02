import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../../api/httpClient";
import { generateVectorLayers, getVectorLayers } from "../../api/vectorLayersApi";

interface OpenWorkspaceButtonProps {
  projectId: string;
  imageId: string;
  paletteId: string;
  paletteVersion: number;
  onReady: () => void;
}

/** Open only after the confirmed palette has a complete, current layer set. */
export function OpenWorkspaceButton({ projectId, imageId, paletteId, paletteVersion, onReady }: OpenWorkspaceButtonProps) {
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => () => requestRef.current?.abort(), []);

  const open = async () => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setPreparing(true);
    setError(null);
    try {
      let layers;
      try {
        layers = await getVectorLayers(projectId, imageId, paletteId, controller.signal);
      } catch (cause) {
        // A missing layer set is expected immediately after palette confirmation.
        // Network/auth/server failures must remain errors, not trigger generation.
        if (!(cause instanceof ApiClientError) || cause.status !== 404) throw cause;
      }
      if (!layers || layers.paletteVersion !== paletteVersion || layers.layers.length === 0) {
        layers = await generateVectorLayers(projectId, imageId, paletteId, controller.signal);
      }
      if (layers.paletteVersion !== paletteVersion || layers.layers.length === 0) {
        throw new Error("No se generaron las capas de la paleta confirmada.");
      }
      if (!controller.signal.aborted) onReady();
    } catch {
      if (!controller.signal.aborted) {
        setError("No se pudo preparar el Workspace. Volvé a intentarlo; tu proyecto sigue disponible.");
      }
    } finally {
      if (!controller.signal.aborted) setPreparing(false);
      if (requestRef.current === controller) requestRef.current = null;
    }
  };

  return <>
    <button type="button" className="upload-actions__button upload-actions__button--primary"
      disabled={preparing} onClick={open}>
      {preparing ? "Preparando Workspace…" : "Abrir en el Workspace"}
    </button>
    {preparing && <span role="status"> Preparando las capas del proyecto…</span>}
    {error && <span role="alert"> {error}</span>}
  </>;
}
