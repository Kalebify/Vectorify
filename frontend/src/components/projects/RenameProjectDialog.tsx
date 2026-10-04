import { useId, useRef, useState, type FormEvent } from "react";
import { ProjectDialog } from "./ProjectDialog";

interface RenameProjectDialogProps {
  projectName: string;
  /**
   * Intenta renombrar. Devuelve el mensaje de error a mostrar DENTRO del diálogo (400 del
   * servidor, red caída) o `null` cuando terminó -- en cuyo caso el llamador cierra el diálogo.
   */
  onSubmit: (name: string) => Promise<string | null>;
  onClose: () => void;
}

/** Diálogo "Renombrar" (M2.2-S08): valida nombre no vacío del lado cliente y muestra el error 400 del servidor. */
export function RenameProjectDialog({ projectName, onSubmit, onClose }: RenameProjectDialogProps) {
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(projectName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    const trimmed = value.trim();
    if (!trimmed) {
      setError("El nombre no puede estar vacío.");
      inputRef.current?.focus();
      return;
    }

    setBusy(true);
    setError(null);
    const message = await onSubmit(trimmed);
    if (message) {
      setError(message);
      setBusy(false);
    }
  };

  return (
    <ProjectDialog title="Renombrar proyecto" initialFocusRef={inputRef} onClose={onClose} busy={busy}>
      <form className="projects-dialog__form" onSubmit={handleSubmit} noValidate>
        <label htmlFor={inputId} className="projects-dialog__label">
          Nombre del proyecto
        </label>
        <input
          id={inputId}
          ref={inputRef}
          className="projects-dialog__input"
          type="text"
          value={value}
          maxLength={200}
          readOnly={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(null);
          }}
        />
        {error && (
          <p id={errorId} className="projects-dialog__error" role="alert">
            {error}
          </p>
        )}
        <div className="projects-dialog__actions">
          <button type="button" className="upload-actions__button" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="upload-actions__button upload-actions__button--primary" disabled={busy}>
            {busy ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </form>
    </ProjectDialog>
  );
}
