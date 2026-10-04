import { useState, type MouseEvent } from "react";
import { resolveThumbnailUrl } from "../../api/projectsV2Api";
import { formatAbsoluteDateTime, formatRelativeTime } from "../../lib/relativeTime";
import type { ProjectSummary } from "../../types/projectsV2";
import { ProjectActionsMenu, type ProjectAction } from "./ProjectActionsMenu";

interface ProjectCardProps {
  project: ProjectSummary;
  now: number;
  /** Acciones en vuelo para ESTE proyecto (deshabilitan su ítem de menú). */
  disabledActions: ReadonlySet<ProjectAction>;
  onAction: (action: ProjectAction, project: ProjectSummary) => void;
}

function layerCountLabel(count: number): string {
  return `${count} ${count === 1 ? "layer" : "layers"}`;
}

/**
 * Una card (vista Grid) o fila (vista List -- mismo markup, otro CSS) de un proyecto. El nombre
 * es un `<button>` real = Abrir; un click en cualquier otro punto de la card también abre (solo
 * como comodidad de puntero: no agrega ninguna parada de teclado extra).
 */
export function ProjectCard({ project, now, disabledActions, onAction }: ProjectCardProps) {
  const thumbnailSrc = resolveThumbnailUrl(project.thumbnailUrl);
  // La URL que falló al cargar (404, archivo ausente en storage, imagen corrupta): se recuerda por
  // URL para que un thumbnail nuevo del mismo proyecto vuelva a intentarse.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = thumbnailSrc !== null && failedSrc !== thumbnailSrc;

  const handleCardClick = (event: MouseEvent<HTMLLIElement>) => {
    if ((event.target as HTMLElement).closest("button, [role='menu']")) return;
    onAction("open", project);
  };

  return (
    <li className="project-card" onClick={handleCardClick}>
      <div className="project-card__thumbnail">
        {showImage ? (
          <img
            src={thumbnailSrc}
            alt={`Vista previa de ${project.name}`}
            width={160}
            height={120}
            loading="lazy"
            onError={() => setFailedSrc(thumbnailSrc)}
          />
        ) : (
          <div className="project-card__placeholder" role="img" aria-label={`Sin vista previa de ${project.name}`}>
            <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true" focusable="false">
              <path
                d="M4 5h16v14H4zM4 15l4.5-4.5 3.5 3.5 2.5-2.5L20 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        )}
      </div>

      <div className="project-card__body">
        <button type="button" className="project-card__name" onClick={() => onAction("open", project)}>
          {project.name}
        </button>
        <p className="project-card__meta">
          <span>{layerCountLabel(project.layerCount)}</span>
          <span aria-hidden="true"> · </span>
          <time dateTime={project.updatedAt} title={formatAbsoluteDateTime(project.updatedAt)}>
            {formatRelativeTime(project.updatedAt, now)}
          </time>
        </p>
      </div>

      <ProjectActionsMenu
        projectName={project.name}
        disabledActions={disabledActions}
        onSelect={(action) => onAction(action, project)}
      />
    </li>
  );
}
