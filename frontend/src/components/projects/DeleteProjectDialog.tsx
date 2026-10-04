import { useRef, useState } from "react";
import { ProjectDialog } from "./ProjectDialog";

interface DeleteProjectDialogProps {
  projectName: string;
  /** Devuelve el mensaje de error a mostrar en el diálogo, o `null` cuando terminó (el llamador lo cierra). */
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}

/**
 * Confirmación de borrado (M2.2-S08): diálogo propio (`alertdialog`) que NOMBRA el proyecto --
 * nunca `window.confirm`. El foco inicial va a "Cancelar" (la opción no destructiva).
 */
export function DeleteProjectDialog({ projectName, onConfirm, onClose }: DeleteProjectDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (busy) return;

    setBusy(true);
    setError(null);
    const message = await onConfirm();
    if (message) {
      setError(message);
      setBusy(false);
    }
  };

  return (
    <ProjectDialog
      role="alertdialog"
      title="Eliminar proyecto"
      description={
        <>
          ¿Querés eliminar <strong>{projectName}</strong>? Va a dejar de aparecer en Mis proyectos y no se puede
          deshacer desde la aplicación.
        </>
      }
      initialFocusRef={cancelRef}
      onClose={onClose}
      busy={busy}
    >
      {error && (
        <p className="projects-dialog__error" role="alert">
          {error}
        </p>
      )}
      <div className="projects-dialog__actions">
        <button ref={cancelRef} type="button" className="upload-actions__button" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
        <button
          type="button"
          className="upload-actions__button projects-dialog__danger"
          onClick={handleConfirm}
          disabled={busy}
        >
          {busy ? "Eliminando…" : "Eliminar"}
        </button>
      </div>
    </ProjectDialog>
  );
}
