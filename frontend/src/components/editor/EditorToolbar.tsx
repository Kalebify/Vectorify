export type EditorTool = "select" | "pan" | "move" | "crop" | "fill" | "color" | "eyedropper" | "draw" | "erase";

interface ToolDefinition {
  id: EditorTool | string;
  icon: string;
  label: string;
  enabled: boolean;
  shortcut?: string;
}

/**
 * Shell COMPLETO de herramientas del wireframe obligatorio de spec.md
 * (Select, Pan, Crop, Move, Fill, Color, Draw, Erase, Offset, Cut, Path):
 * TODAS presentes y visibles (nunca ocultas). M3-S01 habilita Select
 * (seleccionar + mover + escalar/rotar con handles) y Move; Pan ya existía.
 * M3-S02 habilita Crop (recorta el ÁREA DE TRABAJO del documento, nunca el
 * original). M3-S03 habilita Fill (aplicar un color a la selección: mueve los objetos a la capa de ese color) y Color (panel de
 * Recolor con alcance explícito selección/capa/documento) y AGREGA el Eyedropper (atajo I; el wireframe obligatorio original no lo
 * traía: se hace visible acá porque Fill/Recolor lo necesitan para tomar un color EXISTENTE del documento). M3-S04 habilita Draw (pluma y
 * mano alzada, en la capa activa) y Erase (borrar objetos o restar geometría con un pincel, calculado en el servidor). El resto queda
 * deshabilitado con `disabled` + `title`/`aria-describedby` indicando que llega en MVP3 (cada una en su tarjeta).
 *
 * **Move (M3-S01)** = "mover sin handles": mismo arrastre, Shift+click y flechas
 * que Select, pero SIN Transformer (no hay handles de escala/rotación) y sin
 * marquee -- sirve para desplazar objetos sin riesgo de agarrar un handle por error.
 */
const TOOLS: ToolDefinition[] = [
  { id: "select", icon: "↖", label: "Select", enabled: true, shortcut: "V -- seleccionar, mover, escalar y rotar" },
  { id: "pan", icon: "✋", label: "Pan", enabled: true, shortcut: "Espacio (mantener) o H" },
  { id: "crop", icon: "✂", label: "Crop", enabled: true, shortcut: "recortar el área de trabajo; el original no se toca" },
  { id: "move", icon: "↔", label: "Move", enabled: true, shortcut: "mover sin handles" },
  { id: "fill", icon: "▣", label: "Fill", enabled: true, shortcut: "aplicar un color a la selección" },
  { id: "color", icon: "◉", label: "Color", enabled: true, shortcut: "recolorear la selección, una capa o el documento" },
  { id: "eyedropper", icon: "💧", label: "Eyedropper", enabled: true, shortcut: "I -- tomar el color de la capa de un objeto" },
  { id: "draw", icon: "✎", label: "Draw", enabled: true, shortcut: "pluma y mano alzada; crea formas y líneas en la capa activa" },
  { id: "erase", icon: "⌫", label: "Erase", enabled: true, shortcut: "borrar objetos o restar geometría con un pincel" },
  { id: "offset", icon: "⤢", label: "Offset", enabled: false },
  { id: "cut", icon: "✂", label: "Cut", enabled: false },
  { id: "path", icon: "⌁", label: "Path", enabled: false },
];

interface EditorToolbarProps {
  activeTool: EditorTool;
  onSelectTool: (tool: EditorTool) => void;
}

export function EditorToolbar({ activeTool, onSelectTool }: EditorToolbarProps) {
  return (
    <nav className="editor-toolbar" aria-label="Herramientas del editor">
      <ul className="editor-toolbar__list">
        {TOOLS.map((tool) => {
          const isActive = tool.enabled && tool.id === activeTool;
          const title = tool.enabled
            ? tool.shortcut
              ? `${tool.label} (${tool.shortcut})`
              : tool.label
            : `${tool.label} — llega en MVP3`;

          return (
            <li key={tool.id}>
              <button
                type="button"
                className={`editor-toolbar__button${isActive ? " editor-toolbar__button--active" : ""}`}
                disabled={!tool.enabled}
                aria-pressed={tool.enabled ? isActive : undefined}
                aria-label={title}
                title={title}
                onClick={() => {
                  if (tool.enabled) onSelectTool(tool.id as EditorTool);
                }}
              >
                <span aria-hidden="true" className="editor-toolbar__icon">
                  {tool.icon}
                </span>
                <span className="editor-toolbar__label">{tool.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
