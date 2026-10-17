import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ProjectDialog } from "../components/projects/ProjectDialog";
import "../components/projects/projects.css";
import { LOGOUT_ALL_DIALOG } from "./authCopy";
import { useAuth } from "./authContext";
import { classifyFailure } from "./authErrors";
import { AuthAlert, AuthButton } from "./AuthUi";

/** Confirmación de «Cerrar sesión en todos lados» (afecta a otros dispositivos). Reutiliza el diálogo accesible de Mis proyectos. */
export function LogoutAllDialog({ onClose }: { onClose: () => void }) {
  const { signOutAll } = useAuth();
  const [busy, setBusy] = useState(false);
  const [alertText, setAlertText] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);

  const confirm = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setAlertText(null);
    setBusy(true);
    try {
      await signOutAll();
      // Éxito: la sesión cambia y el diálogo se desmonta junto con la pantalla de producto.
    } catch (error) {
      setAlertText(classifyFailure(error).kind === "network" ? LOGOUT_ALL_DIALOG.network : LOGOUT_ALL_DIALOG.server);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // Portal al body: el menú vive dentro de cabeceras con su propio contexto de apilamiento y el modal debe cubrir toda la ventana.
  return createPortal(
    <ProjectDialog
      role="alertdialog"
      title={LOGOUT_ALL_DIALOG.title}
      description={<p>{LOGOUT_ALL_DIALOG.description}</p>}
      initialFocusRef={cancelRef}
      onClose={onClose}
      busy={busy}
    >
      {alertText && <AuthAlert>{alertText}</AuthAlert>}
      <div className="projects-dialog__actions auth-dialog__actions">
        <AuthButton variant="secondary" buttonRef={cancelRef} onClick={onClose}>
          {LOGOUT_ALL_DIALOG.cancel}
        </AuthButton>
        <AuthButton loading={busy} loadingLabel={LOGOUT_ALL_DIALOG.confirming} onClick={() => void confirm()}>
          {LOGOUT_ALL_DIALOG.confirm}
        </AuthButton>
      </div>
    </ProjectDialog>,
    document.body,
  );
}
