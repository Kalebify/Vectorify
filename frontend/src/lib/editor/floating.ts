import { IDENTITY_MATRIX } from "../svgTransform";
import type {
  BridgeInput,
  BridgePoint,
  BridgeReason,
  BridgeRequest,
  BridgeResponse,
  FloatingComponent,
  FloatingMode,
  FloatingRequest,
  FloatingResponse,
  FloatingSubject,
  GeometryPoint,
} from "../../types/geometry";
import { pieceArea, paintOrderIds, describeOperand, type BooleanShape } from "./boolean";
import {
  DEFAULT_FLATNESS_MM,
  MAX_SERVER_SUBJECTS,
  MAX_SERVER_VERTICES,
  geometryErrorMessage,
  matrixScale,
  objectGeometry,
  pieceToPathData,
  toDocumentUnits,
  unitScale,
  validPiece,
  type UnitScale,
} from "./geometry";
import { isUnfilled } from "./objects";
import { formatPanelValue, serialOf } from "./offset";
import { formatDisplayNumber } from "./units";
import type { EditableDocument, EditorObject, EditProduction, Point, Rect } from "./types";

/**
 * Piezas flotantes y bridges del editor (M3-S11): detecta las piezas que «se caen» al cortar (islas internas) y las conecta con puentes reales de ancho
 * configurable en mm. Lógica pura (sin React ni Konva): arma las peticiones al servicio de geometría (`POST /api/v2/geometry/floating` y `/bridge`, Shapely/GEOS,
 * misma infraestructura de S04/S08-S10), interpreta sus respuestas y las convierte en UN comando.
 *
 * Decisiones (documentadas también en `docs/ADR_EDITOR_MVP3.md`):
 * 1. **Dos modos explícitos de «flotante»**, siempre visibles en el panel (default *Plantilla*). *Plantilla* (`stencil`): las formas son CORTES; una isla es material
 *    rodeado por completo de corte (la contra-forma de una A, O o R, los centros de un stencil) y se cae al cortar; un corte dentro de una isla no la conecta. *Piezas*
 *    (`parts`): las formas son MATERIAL; flotante es un componente dentro de un hueco de otro (el punto de una «O»), desconectado del cuerpo principal.
 * 2. **Alcance explícito.** La selección, si la hay; si no, los objetos CON RELLENO de las capas visibles cuya operación de fabricación es CUT. Los objetos de capas
 *    bloqueadas cuentan para el análisis (solo lectura) pero NO se modifican; los de capas ocultas no cuentan. Las líneas abiertas no se analizan (no tienen relleno).
 * 3. **Un bridge es geometría real**: un rectángulo de ancho w (mm) que cruza el hueco entre una pieza flotante y el material vecino. En *Plantilla* se RESTA de los cortes;
 *    en *Piezas* se SUMA a la forma dueña. El servidor valida cada bridge por separado (queda corto, ancla fuera, ancho menor que la tolerancia, necesita modificar un
 *    objeto bloqueado, no reduce flotantes), aplica los válidos juntos y REANALIZA el resultado: «N flotantes → M». Apply se habilita solo si no hay bridges inválidos.
 * 4. **Resultado.** Cada objeto modificado se reemplaza por sus piezas (ids nuevos, MISMA capa, mismo `fill`/`stroke`, sin matriz, huecos como subpaths); el que el
 *    servidor declara intacto (`changed: false`) conserva `d`, matriz e id. Un comando atómico por Apply; el preview y Cancel no tocan la pila de undo.
 * 5. **Nada en silencio.** Se informan los bridges que no redujeron nada, las piezas que quedan sin bridge, lo bloqueado que no se modifica, lo oculto y las líneas
 *    omitidas, y las piezas despreciables descartadas. Un error o una respuesta incoherente del servidor no modifica nada.
 */

export const FLOATING_MODES: readonly FloatingMode[] = ["stencil", "parts"];

export const FLOATING_MODE_INFO: Record<FloatingMode, { label: string; description: string; noun: string; nounPlural: string }> = {
  stencil: {
    label: "Plantilla (stencil)",
    description: "Las formas son cortes (vacío): una isla es material rodeado por completo de corte —el hueco de una O, la contra-forma de una A o R—; al cortar, se cae.",
    noun: "isla",
    nounPlural: "islas",
  },
  parts: {
    label: "Piezas",
    description: "Las formas son material: una pieza flotante es un componente que está dentro de un hueco de otro, desconectado del cuerpo principal (el punto de una O).",
    noun: "pieza flotante",
    nounPlural: "piezas flotantes",
  },
};

/** Ancho del bridge: default, mínimo y máximo del campo, en mm (o u sin escala física). */
export const DEFAULT_BRIDGE_WIDTH_MM = 0.8;
export const MIN_BRIDGE_WIDTH_MM = 0.05;
export const MAX_BRIDGE_WIDTH_MM = 20;
/** Tolerancia de aplanado y de componente despreciable (mm): la de todo el servicio de geometría. */
export const FLOATING_TOLERANCE_MM = DEFAULT_FLATNESS_MM;
/** Espejo de `Geometry:MaxBridges` del backend. */
export const MAX_BRIDGES = 200;
/** Espejo de `Geometry:MaxOffsetDistance`, que acota también el ancho y el largo de un bridge (unidades de documento). */
const MAX_SERVER_BRIDGE_UNITS = 1_000_000;
/** Distancia (px de PANTALLA) a la que un click se ajusta al borde de una pieza flotante. */
export const SNAP_PIXELS = 10;

export const NO_SCALE_NOTICE = "Sin escala física: los bridges se miden en unidades del documento (u), no en mm.";

const NOTHING_CHANGED = "No se modificó nada.";

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// ---- Alcance ----

export interface FloatingScope {
  /** `selection` = solo la selección; `cut-layers` = sin selección, los objetos con relleno de las capas visibles con operación CUT. */
  kind: "selection" | "cut-layers";
  /** Objetos CON RELLENO que se analizan, en orden de PINTADO (los de capas bloqueadas incluidos: cuentan, no se modifican). */
  objects: EditorObject[];
  /** De `objects`, cuántos están en capas bloqueadas. */
  lockedCount: number;
  /** Objetos de la selección en capas ocultas (no cuentan) y líneas abiertas (sin relleno: no se analizan). */
  hiddenOmitted: number;
  unfilledOmitted: number;
  /** Nombres de las capas CUT visibles que entran al análisis (solo en `cut-layers`). */
  layerNames: string[];
  /** Capas CUT que están ocultas: no cuentan (se informan). */
  hiddenCutLayers: string[];
}

/**
 * Alcance del análisis. Con selección: esos objetos (resueltos contra `document` por id). Sin selección: los objetos con relleno de las capas CUT visibles. En
 * ambos casos las capas ocultas no cuentan y las bloqueadas sí (solo lectura). Nunca se omite nada sin quedar contado.
 */
export function floatingScope(selection: readonly EditorObject[], document: EditableDocument): FloatingScope {
  const layers = document.layers ?? [];
  const lockedIds = new Set(layers.filter((layer) => layer.locked).map((layer) => layer.groupId));
  const hiddenIds = new Set(layers.filter((layer) => !layer.visible).map((layer) => layer.groupId));

  const current = new Map<string, EditorObject>();
  for (const objects of Object.values(document.objectsByLayer)) for (const object of objects) current.set(object.id, object);
  const live = [...new Map(selection.map((object) => [object.id, object])).values()].flatMap((object) => {
    const found = current.get(object.id);
    return found ? [found] : [];
  });

  const kind: FloatingScope["kind"] = live.length > 0 ? "selection" : "cut-layers";
  let pool: EditorObject[];
  let layerNames: string[] = [];
  let hiddenCutLayers: string[] = [];
  if (kind === "selection") {
    pool = live;
  } else {
    const cutLayers = layers.filter((layer) => layer.manufacturingOperation === "cut");
    hiddenCutLayers = cutLayers.filter((layer) => !layer.visible).map((layer) => layer.name);
    const visibleCut = cutLayers.filter((layer) => layer.visible);
    layerNames = visibleCut.map((layer) => layer.name);
    pool = visibleCut.flatMap((layer) => document.objectsByLayer[layer.groupId] ?? []);
  }

  let hiddenOmitted = 0;
  let unfilledOmitted = 0;
  const kept: EditorObject[] = [];
  for (const object of pool) {
    if (hiddenIds.has(object.layerGroupId)) hiddenOmitted += 1;
    else if (isUnfilled(object.fill)) unfilledOmitted += 1;
    else kept.push(object);
  }
  const byId = new Map(kept.map((object) => [object.id, object]));
  const objects = paintOrderIds([...byId.keys()], document).map((id) => byId.get(id)!);
  return {
    kind,
    objects,
    lockedCount: objects.filter((object) => lockedIds.has(object.layerGroupId)).length,
    hiddenOmitted,
    unfilledOmitted,
    layerNames,
    hiddenCutLayers,
  };
}

/** Qué se analiza, en una frase: «Capas CUT: A, B (12 objetos).» o «Selección: 3 objetos.» (con lo bloqueado, oculto u omitido). */
export function floatingScopeText(scope: FloatingScope): string {
  const count = plural(scope.objects.length, "objeto", "objetos");
  const head = scope.kind === "selection" ? `Selección: ${count}.` : scope.layerNames.length > 0 ? `Capas CUT: ${scope.layerNames.join(", ")} (${count}).` : "Capas CUT: ninguna visible.";
  const notes: string[] = [];
  if (scope.lockedCount > 0) {
    notes.push(`${plural(scope.lockedCount, "objeto bloqueado cuenta", "objetos bloqueados cuentan")} para el análisis pero no se ${scope.lockedCount === 1 ? "modifica" : "modifican"}.`);
  }
  if (scope.hiddenOmitted > 0) notes.push(`${plural(scope.hiddenOmitted, "objeto oculto no cuenta", "objetos ocultos no cuentan")}.`);
  if (scope.hiddenCutLayers.length > 0) notes.push(`${plural(scope.hiddenCutLayers.length, "capa CUT oculta no cuenta", "capas CUT ocultas no cuentan")} (${scope.hiddenCutLayers.join(", ")}).`);
  if (scope.unfilledOmitted > 0) notes.push(`${plural(scope.unfilledOmitted, "línea abierta se omite", "líneas abiertas se omiten")} (sin relleno).`);
  return [head, ...notes].join(" ");
}

// ---- Plan del análisis ----

export type FloatingRejection = "no_targets" | "invalid_geometry" | "too_many" | "invalid_tolerance";

export interface FloatingRejectionInfo {
  ok: false;
  reason: FloatingRejection;
  message: string;
}

function reject(reason: FloatingRejection, message: string): FloatingRejectionInfo {
  return { ok: false, reason, message };
}

export interface FloatingPlan {
  /** Objetos analizados, en orden de pintado; `subjects[i]` es la geometría de `objects[i]`. Referencias del documento al analizar: si cambian, el análisis está viejo. */
  objects: EditorObject[];
  subjects: FloatingSubject[];
  request: FloatingRequest;
  /** Identifica la PETICIÓN (modo, tolerancia, objetos y su bloqueo): igual clave => mismo resultado. */
  requestKey: string;
  mode: FloatingMode;
  scope: FloatingScope;
  unit: UnitScale;
  mmFactor: number | null;
  scaleNotice: string | null;
  /** Nombre legible de cada objeto («Rojo · objeto 2»), por posición. */
  names: string[];
  /** Objetos cuya geometría no se pudo enviar (path ilegible): se omiten e informan. */
  skippedInvalid: number;
}

export type FloatingPlanResult = { ok: true; plan: FloatingPlan } | FloatingRejectionInfo;

export interface FloatingOptions {
  mode: FloatingMode;
  /** mm por unidad de documento, o `null` sin escala física (el panel opera en unidades y avisa). */
  mmFactor: number | null;
}

/**
 * Arma la petición de análisis. `selection` son los objetos seleccionados (cualquier orden; vacío = capas CUT visibles). Rechaza, con el motivo, lo que no se
 * pueda hacer sin adivinar: nada que analizar, geometría ilegible, demasiada geometría.
 */
export function planFloating(selection: readonly EditorObject[], document: EditableDocument, options: FloatingOptions): FloatingPlanResult {
  const scope = floatingScope(selection, document);
  const unit = unitScale(options.mmFactor);
  if (scope.objects.length === 0) {
    const why =
      scope.kind === "selection"
        ? "Los objetos seleccionados no tienen relleno o están en capas ocultas: no hay nada que analizar. Seleccioná formas rellenas y visibles."
        : scope.hiddenCutLayers.length > 0
          ? `Las capas CUT (${scope.hiddenCutLayers.join(", ")}) están ocultas: no cuentan. Mostralas en el panel de Capas o seleccioná los objetos a analizar.`
          : "No hay capas con operación CUT visibles con formas rellenas. Asigná la operación Corte a una capa o seleccioná los objetos a analizar.";
    return reject("no_targets", `${why} ${NOTHING_CHANGED}`);
  }

  const lockedIds = new Set((document.layers ?? []).filter((layer) => layer.locked).map((layer) => layer.groupId));
  const tolerance = toDocumentUnits(FLOATING_TOLERANCE_MM, unit);
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) return reject("invalid_tolerance", `La escala del documento no permite calcular. ${NOTHING_CHANGED}`);

  const objects: EditorObject[] = [];
  const subjects: FloatingSubject[] = [];
  let vertices = 0;
  let skippedInvalid = 0;
  for (const object of scope.objects) {
    const geometry = objectGeometry(object, tolerance);
    const subject = geometry?.subjects[0];
    if (!geometry || geometry.kind !== "polygon" || !subject || subject.type !== "polygon") {
      skippedInvalid += 1;
      continue;
    }
    objects.push(object);
    subjects.push({ ...subject, locked: lockedIds.has(object.layerGroupId) });
    vertices += geometry.vertexCount;
  }
  if (objects.length === 0) {
    return reject("invalid_geometry", `Los objetos a analizar no tienen una geometría que se pueda procesar (path ilegible o sin área). ${NOTHING_CHANGED}`);
  }
  if (subjects.length > MAX_SERVER_SUBJECTS) {
    return reject("too_many", `Son demasiados objetos (${subjects.length}; el máximo es ${MAX_SERVER_SUBJECTS}). Seleccioná menos objetos. ${NOTHING_CHANGED}`);
  }
  if (vertices > MAX_SERVER_VERTICES) {
    return reject(
      "too_many",
      `La geometría a analizar es demasiado grande (${vertices.toLocaleString("es-AR")} vértices; el máximo es ${MAX_SERVER_VERTICES.toLocaleString("es-AR")}). Seleccioná menos objetos. ${NOTHING_CHANGED}`,
    );
  }

  const request: FloatingRequest = { subjects, mode: options.mode, tolerance };
  return {
    ok: true,
    plan: {
      objects,
      subjects,
      request,
      requestKey: `floating|${options.mode}|${tolerance}|${objects.map((object, index) => `${object.id}#${serialOf(object)}${subjects[index].locked ? "L" : ""}`).join(",")}`,
      mode: options.mode,
      scope,
      unit,
      mmFactor: options.mmFactor,
      scaleNotice: unit.label === "mm" ? null : NO_SCALE_NOTICE,
      names: objects.map((object) => describeOperand(object, 0, document).name),
      skippedInvalid,
    },
  };
}

// ---- Validación de la respuesta del análisis ----

/**
 * Defensa del cliente (el editor NUNCA muestra ni aplica algo que no sea coherente): la respuesta tiene que corresponder a LA petición -- mismo modo, ids = posiciones,
 * un árbol de contención consistente (cada hijo después de su padre, con un nivel más de profundidad), polígonos cerrados y finitos (la hoja de `stencil` es el único
 * componente sin polígono), áreas y bounds finitos, formas que existen y recuentos iguales a lo que trae la lista. `null` si es coherente; si no, el motivo.
 */
export function validateFloatingResponse(request: FloatingRequest, response: FloatingResponse): string | null {
  if (!response || !Array.isArray(response.components)) return "la respuesta no trae componentes";
  if (response.mode !== request.mode) return "la respuesta es de otro modo";
  if (!isFiniteNumber(response.tolerance) || response.tolerance <= 0) return "la tolerancia de la respuesta no es válida";

  let floating = 0;
  let principal = 0;
  for (let index = 0; index < response.components.length; index += 1) {
    const component = response.components[index];
    if (!component || typeof component !== "object" || !Array.isArray(component.subjects) || !Array.isArray(component.bounds)) return `el componente ${index} está incompleto`;
    if (component.id !== index) return `el componente ${index} no corresponde a su posición`;
    if (component.kind !== "principal" && component.kind !== "floating") return `el componente ${index} tiene un tipo desconocido`;
    const isFloating = component.kind === "floating";
    if (isFloating) {
      const parent = component.parent;
      if (!isCount(parent) || parent >= index || component.depth !== response.components[parent].depth + 1) {
        return `el componente ${index} declara un padre o una profundidad incoherentes`;
      }
    } else if (component.parent !== null || component.depth !== 0) {
      return `el componente ${index} es principal pero declara padre o profundidad`;
    }
    if (request.mode === "stencil" && !isFloating) {
      if (component.polygon !== null || component.area !== null || index !== 0) return "la hoja de la plantilla no puede traer polígono ni área, y es el componente 0";
    } else {
      const problem = validPiece(component.polygon, "polygon");
      if (problem) return problem;
      if (!isFiniteNumber(component.area) || component.area <= 0) return `el componente ${index} trae un área inválida`;
    }
    const [minX, minY, maxX, maxY] = component.bounds;
    if (component.bounds.length !== 4 || !component.bounds.every(isFiniteNumber) || minX > maxX || minY > maxY) return `el componente ${index} trae bounds inválidos`;
    for (let position = 0; position < component.subjects.length; position += 1) {
      const subject = component.subjects[position];
      if (!isCount(subject) || subject >= request.subjects.length || (position > 0 && subject <= component.subjects[position - 1])) {
        return `el componente ${index} referencia formas inexistentes o repetidas`;
      }
    }
    if (isFloating) floating += 1;
    else principal += 1;
  }
  if (response.floatingCount !== floating || response.mainCount !== principal || (request.mode === "stencil" && principal > 1)) return "los recuentos no coinciden con los componentes";
  if (!isCount(response.discarded)) return "el conteo de componentes descartados es incoherente";
  return null;
}

// ---- Issues (el análisis para el usuario) ----

/** Una pieza flotante lista para mostrar, navegar y resaltar. */
export interface FloatingIssue {
  /** Id del componente en la respuesta. */
  id: number;
  /** 1, 2, 3... en el orden determinista del servidor. */
  position: number;
  /** «Isla 1» (Plantilla) o «Pieza flotante 1» (Piezas). */
  label: string;
  component: FloatingComponent;
  /** Path data del polígono en el espacio del documento (huecos como subpaths): para resaltarlo. */
  d: string;
  /** Su bounding box en el documento: lo que se centra al seleccionar el issue. */
  rect: Rect;
  /** Área en mm² (o u² sin escala física). */
  area: number;
  depth: number;
  /** A qué está unida/rodeada: «la hoja», «el cuerpo principal», «Isla 1»... */
  parentLabel: string;
  /** Objetos que forman el borde de la pieza («Rojo · objeto 2»). */
  objectNames: string[];
}

export interface FloatingAnalysis {
  mode: FloatingMode;
  issues: FloatingIssue[];
  mainCount: number;
  discarded: number;
}

export function boundsRect(bounds: readonly number[]): Rect {
  return { x: bounds[0], y: bounds[1], width: bounds[2] - bounds[0], height: bounds[3] - bounds[1] };
}

/**
 * La respuesta del análisis -> issues para el usuario. Valida la respuesta contra la petición (`validateFloatingResponse`); un polígono que no se pueda escribir como
 * `d` invalida todo (el editor no muestra geometría inventada).
 */
export function floatingAnalysis(plan: FloatingPlan, response: FloatingResponse): { ok: true; analysis: FloatingAnalysis } | { ok: false; error: string } {
  const invalid = validateFloatingResponse(plan.request, response);
  if (invalid) return { ok: false, error: `El servidor devolvió una respuesta incoherente (${invalid}). ${NOTHING_CHANGED}` };

  const labelOf = new Map<number, string>();
  let principalIndex = 0;
  let position = 0;
  const issues: FloatingIssue[] = [];
  for (const component of response.components) {
    if (component.kind === "principal") {
      principalIndex += 1;
      labelOf.set(component.id, plan.mode === "stencil" ? "la hoja" : response.mainCount > 1 ? `el cuerpo ${principalIndex}` : "el cuerpo principal");
      continue;
    }
    position += 1;
    const label = `${plan.mode === "stencil" ? "Isla" : "Pieza flotante"} ${position}`;
    labelOf.set(component.id, label);
    const d = pieceToPathData(component.polygon!);
    if (d === null) return { ok: false, error: `El servidor devolvió una pieza que no se puede dibujar. ${NOTHING_CHANGED}` };
    issues.push({
      id: component.id,
      position,
      label,
      component,
      d,
      rect: boundsRect(component.bounds),
      area: component.area! * plan.unit.factor * plan.unit.factor,
      depth: component.depth,
      parentLabel: labelOf.get(component.parent!) ?? "",
      objectNames: component.subjects.map((subject) => plan.names[subject] ?? "Objeto"),
    });
  }
  return { ok: true, analysis: { mode: plan.mode, issues, mainCount: response.mainCount, discarded: response.discarded } };
}

/** «Se encontraron 3 islas (se caen al cortar).» o «No se encontraron piezas flotantes.», con lo descartado. */
export function analysisSummary(analysis: FloatingAnalysis): string {
  const info = FLOATING_MODE_INFO[analysis.mode];
  const count = analysis.issues.length;
  const found =
    count === 0
      ? analysis.mode === "stencil"
        ? "No se encontraron islas: ninguna parte se cae al cortar."
        : "No se encontraron piezas flotantes: todo está conectado al cuerpo principal."
      : `Se encontraron ${count} ${count === 1 ? info.noun : info.nounPlural}${analysis.mode === "stencil" ? " (se caen al cortar)" : " (desconectadas del cuerpo principal)"}.`;
  return analysis.discarded > 0 ? `${found} ${plural(analysis.discarded, "componente despreciable se descartó", "componentes despreciables se descartaron")}.` : found;
}

/** Texto de un issue: «Isla 1 · 12,5 mm² · rodeada por «Rojo · objeto 1»». */
export function issueDescription(issue: FloatingIssue, unit: UnitScale, mode: FloatingMode): string {
  const area = `${formatDisplayNumber(issue.area)} ${unit.label}²`;
  const around = issue.objectNames.length > 0 ? ` · ${mode === "stencil" ? "rodeada por" : "formada por"} ${issue.objectNames.map((name) => `«${name}»`).join(", ")}` : "";
  return `${issue.label} · ${area}${around}`;
}

// ---- Ajuste de un click al borde de una pieza ----

function closestOnSegment(point: Point, a: GeometryPoint, b: GeometryPoint): Point {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a[0]) * dx + (point.y - a[1]) * dy) / length2));
  return { x: a[0] + dx * t, y: a[1] + dy * t };
}

/**
 * Ajusta un click (documento) al punto más cercano del BORDE de una pieza flotante, si está a lo sumo a `tolerance` (unidades de documento; el llamador convierte los
 * px de pantalla). Es el ancla de un bridge manual: el servidor exige que esté sobre el borde. `null` si el click no cae cerca de ninguna pieza.
 */
export function snapToIssue(point: Point, issues: readonly FloatingIssue[], tolerance: number): { issueId: number; point: Point } | null {
  let best: { issueId: number; point: Point; distance: number } | null = null;
  for (const issue of issues) {
    for (const ring of issue.component.polygon?.coordinates ?? []) {
      for (let index = 0; index < ring.length - 1; index += 1) {
        const closest = closestOnSegment(point, ring[index], ring[index + 1]);
        const distance = Math.hypot(closest.x - point.x, closest.y - point.y);
        if (distance <= tolerance && (best === null || distance < best.distance)) best = { issueId: issue.id, point: closest, distance };
      }
    }
  }
  return best === null ? null : { issueId: best.issueId, point: best.point };
}

// ---- Bridges: borradores del usuario y petición ----

/** Un bridge que el usuario conserva en su lista. Sin `anchor`/`direction` el servidor los resuelve (sugerencia o perpendicular al borde). */
export interface BridgeDraft {
  key: string;
  island: number | null;
  anchor: Point | null;
  direction: Point | null;
}

/** Los bridges SUGERIDOS por el servidor (válidos) como borradores explícitos (isla, ancla y dirección ya resueltas): son los que el usuario puede quitar o seguir. */
export function draftsFromSuggestions(response: BridgeResponse | null): BridgeDraft[] {
  if (!response) return [];
  return response.bridges.flatMap((item): BridgeDraft[] =>
    item.valid && item.suggested && item.island !== null && item.anchor && item.direction
      ? [{ key: `s${item.island}`, island: item.island, anchor: { ...item.anchor }, direction: { ...item.direction } }]
      : [],
  );
}

export function bridgeInputs(drafts: readonly BridgeDraft[], widthUnits: number): BridgeInput[] {
  return drafts.map((draft): BridgeInput => {
    const input: BridgeInput = { width: widthUnits };
    if (draft.island !== null) input.island = draft.island;
    if (draft.anchor) input.anchor = { x: draft.anchor.x, y: draft.anchor.y };
    if (draft.direction) input.direction = { x: draft.direction.x, y: draft.direction.y };
    return input;
  });
}

export type BridgeRejection = "no_issues" | "invalid_width" | "too_many_bridges" | "no_bridges";

export interface BridgeRejectionInfo {
  ok: false;
  reason: BridgeRejection;
  message: string;
}

export interface BridgePlan {
  analysisPlan: FloatingPlan;
  analysis: FloatingAnalysis;
  /** `null` = todavía no hay lista del usuario: la petición pide las SUGERENCIAS automáticas (`suggest`). */
  drafts: BridgeDraft[] | null;
  widthMm: number;
  widthUnits: number;
  request: BridgeRequest;
  requestKey: string;
}

export type BridgePlanResult = { ok: true; plan: BridgePlan } | BridgeRejectionInfo;

/**
 * Arma la petición de bridges sobre un análisis ya hecho. Sin lista (`drafts: null`) pide las sugerencias del servidor (una por pieza flotante); con lista, los
 * bridges tal cual (ancho en mm -> unidades). Rechaza, con el motivo: sin piezas flotantes, ancho fuera de rango, demasiados bridges o ninguno.
 */
export function planBridges(analysisPlan: FloatingPlan, analysis: FloatingAnalysis, drafts: readonly BridgeDraft[] | null, widthMm: number): BridgePlanResult {
  if (analysis.issues.length === 0) return { ok: false, reason: "no_issues", message: analysisSummary(analysis) };
  const unit = analysisPlan.unit;
  if (!Number.isFinite(widthMm) || widthMm < MIN_BRIDGE_WIDTH_MM || widthMm > MAX_BRIDGE_WIDTH_MM) {
    return {
      ok: false,
      reason: "invalid_width",
      message: `El ancho del bridge tiene que estar entre ${MIN_BRIDGE_WIDTH_MM.toLocaleString("es-AR")} y ${MAX_BRIDGE_WIDTH_MM.toLocaleString("es-AR")} ${unit.label}. ${NOTHING_CHANGED}`,
    };
  }
  const widthUnits = toDocumentUnits(widthMm, unit);
  if (!(widthUnits <= MAX_SERVER_BRIDGE_UNITS)) {
    return { ok: false, reason: "invalid_width", message: `Con la escala de este documento ese ancho supera el máximo que acepta el servidor. Usá uno menor. ${NOTHING_CHANGED}` };
  }
  if (drafts !== null && drafts.length > MAX_BRIDGES) {
    return { ok: false, reason: "too_many_bridges", message: `Son demasiados bridges (${drafts.length}; el máximo es ${MAX_BRIDGES}). Quitá algunos. ${NOTHING_CHANGED}` };
  }
  if (drafts !== null && drafts.length === 0) {
    return { ok: false, reason: "no_bridges", message: "No hay bridges. Usá «Sugerir bridges» o hacé click sobre el borde de una pieza flotante para colocar uno." };
  }

  const request: BridgeRequest = {
    subjects: analysisPlan.subjects,
    mode: analysisPlan.mode,
    bridges: drafts === null ? [] : bridgeInputs(drafts, widthUnits),
    suggest: drafts === null,
    ...(drafts === null ? { suggestWidth: widthUnits } : {}),
    tolerance: analysisPlan.request.tolerance,
  };
  const listKey = drafts === null ? "suggest" : drafts.map((draft) => `${draft.island ?? "-"}@${draft.anchor ? `${draft.anchor.x},${draft.anchor.y}` : "-"}>${draft.direction ? `${draft.direction.x},${draft.direction.y}` : "-"}`).join(";");
  return {
    ok: true,
    plan: {
      analysisPlan,
      analysis,
      drafts: drafts === null ? null : [...drafts],
      widthMm,
      widthUnits,
      request,
      requestKey: `bridge|${analysisPlan.requestKey}|${widthUnits}|${listKey}`,
    },
  };
}

// ---- Validación de la respuesta de los bridges ----

const BRIDGE_REASONS: ReadonlySet<string> = new Set<BridgeReason>([
  "unknown_island",
  "anchor_outside",
  "width_below_tolerance",
  "invalid_direction",
  "no_crossing",
  "too_short",
  "locked_subject",
  "no_connection",
]);

function validPoint(point: unknown, unit: boolean): point is BridgePoint {
  if (point === null || typeof point !== "object") return false;
  const { x, y } = point as BridgePoint;
  return isFiniteNumber(x) && isFiniteNumber(y) && (!unit || Math.abs(Math.hypot(x, y) - 1) <= 1e-6);
}

/**
 * Defensa del cliente: la respuesta de los bridges tiene que corresponder a LA petición -- un resultado por bridge pedido (en orden y con el ancho pedido) y, solo con
 * `suggest`, los sugeridos después; motivos conocidos; un bridge válido con isla, ancla, dirección unitaria, rectángulo, largo y área finitos y sin tocar una forma
 * bloqueada; la geometría resultante de cada forma (`changed` solo si algún bridge válido la modifica, sin geometría si no cambió) y el reanálisis sin más flotantes
 * que antes. `null` si es coherente; si no, el motivo.
 */
export function validateBridgeResponse(request: BridgeRequest, response: BridgeResponse): string | null {
  if (!response || !Array.isArray(response.bridges) || !Array.isArray(response.results) || !response.reanalysis) return "la respuesta no trae bridges, resultados y reanálisis";
  if (response.mode !== request.mode) return "la respuesta es de otro modo";
  if (!isFiniteNumber(response.tolerance) || response.tolerance <= 0) return "la tolerancia de la respuesta no es válida";

  const requested = request.bridges.length;
  if (response.bridges.length < requested || (!request.suggest && response.bridges.length !== requested)) return `trae ${response.bridges.length} bridges y se pidieron ${requested}`;

  const affected = new Set<number>();
  let anyValid = false;
  for (let index = 0; index < response.bridges.length; index += 1) {
    const bridge = response.bridges[index];
    if (!bridge || typeof bridge !== "object" || !Array.isArray(bridge.affects)) return `el bridge ${index} está incompleto`;
    const expectedWidth = index < requested ? request.bridges[index].width : request.suggestWidth;
    if (bridge.index !== index || bridge.suggested !== index >= requested || expectedWidth === undefined || bridge.width !== expectedWidth) {
      return `el bridge ${index} no corresponde a su posición o trae un ancho distinto del pedido`;
    }
    if ((bridge.anchor !== null && !validPoint(bridge.anchor, false)) || (bridge.direction !== null && !validPoint(bridge.direction, true))) {
      return `el bridge ${index} trae un ancla o una dirección no válidas`;
    }
    if ((bridge.length !== null && !(isFiniteNumber(bridge.length) && bridge.length >= 0)) || (bridge.area !== null && !(isFiniteNumber(bridge.area) && bridge.area >= 0))) {
      return `el bridge ${index} trae un largo o un área inválidos`;
    }
    if (bridge.polygon !== null) {
      const problem = validPiece(bridge.polygon, "polygon");
      if (problem) return problem;
      if (bridge.polygon.coordinates.length !== 1) return `el rectángulo del bridge ${index} debe tener un solo anillo`;
    }
    if (bridge.island !== null && !isCount(bridge.island)) return `el bridge ${index} trae una isla inválida`;
    if (bridge.valid) {
      const subjectsOk = bridge.affects.length > 0 && bridge.affects.every((subject) => isCount(subject) && subject < request.subjects.length && !request.subjects[subject].locked);
      if (bridge.reason !== null || bridge.island === null || !bridge.anchor || !bridge.direction || !bridge.polygon || !(bridge.length! > 0) || !(bridge.area! > 0) || !subjectsOk) {
        return `el bridge ${index} figura como válido pero le faltan datos, o modifica una forma bloqueada o inexistente`;
      }
      for (const subject of bridge.affects) affected.add(subject);
      anyValid = true;
    } else if (bridge.reason === null || !BRIDGE_REASONS.has(bridge.reason) || bridge.reduces) {
      return `el bridge ${index} figura como inválido sin un motivo conocido, o como inválido que reduce`;
    }
  }

  if (response.results.length !== request.subjects.length) return `trae ${response.results.length} resultados y se esperaban ${request.subjects.length}`;
  let pieces = 0;
  for (let index = 0; index < response.results.length; index += 1) {
    const item = response.results[index];
    if (!item || !Array.isArray(item.geometries)) return "un resultado no trae geometrías";
    if (item.subjectIndex !== index) return "un resultado no corresponde a su forma";
    if (item.changed !== affected.has(index) || (!item.changed && item.geometries.length > 0) || (item.changed && request.subjects[index].locked)) {
      return `el resultado ${index} declara un cambio que no coincide con los bridges válidos, o modifica una forma bloqueada`;
    }
    for (const piece of item.geometries) {
      const problem = validPiece(piece, "polygon");
      if (problem) return problem;
    }
    pieces += item.geometries.length;
  }

  const { floatingBefore, floatingAfter, mainAfter } = response.reanalysis;
  if (!isCount(floatingBefore) || !isCount(floatingAfter) || !isCount(mainAfter) || floatingAfter > floatingBefore || (!anyValid && floatingAfter !== floatingBefore)) {
    return "el reanálisis es incoherente con los bridges válidos";
  }
  if (response.pieceCount !== pieces) return "la cantidad total de piezas no coincide con la geometría";
  return null;
}

// ---- Resultado de los bridges ----

const REASON_TEXT: Record<BridgeReason, string> = {
  unknown_island: "la pieza ya no existe: volvé a analizar",
  anchor_outside: "el punto no está sobre el borde de una pieza flotante",
  width_below_tolerance: "el ancho es menor que la tolerancia",
  invalid_direction: "la dirección no es válida",
  no_crossing: "no cruza ningún hueco en esa dirección",
  too_short: "queda corto: no llega al otro lado",
  locked_subject: "necesitaría modificar un objeto en una capa bloqueada",
  no_connection: "no conecta la pieza: no reduce las piezas flotantes",
};

export function bridgeReasonText(reason: BridgeReason): string {
  return REASON_TEXT[reason];
}

/** Un bridge resuelto, listo para el panel y el canvas. */
export interface BridgeView {
  index: number;
  /** Clave del borrador del usuario (los pedidos); `null` en una sugerencia que todavía no se adoptó. */
  key: string | null;
  suggested: boolean;
  valid: boolean;
  reason: BridgeReason | null;
  /** Por qué no es válido, en lenguaje de usuario (con los objetos bloqueados si corresponde), o `null`. */
  reasonText: string | null;
  island: number | null;
  islandLabel: string | null;
  anchor: Point | null;
  direction: Point | null;
  /** Largo del hueco que cruza y lo que quita (stencil) o agrega (parts): mm / mm² (u / u² sin escala física). */
  length: number | null;
  area: number | null;
  reduces: boolean;
  affectsNames: string[];
  /** Su rectángulo como path data (documento), o `null` si no llegó a calcularse. */
  d: string | null;
}

export interface BridgeObjectOutcome {
  object: EditorObject;
  status: "changed" | "unchanged";
  locked: boolean;
  /** Piezas nuevas (polilíneas aplanadas) de un objeto modificado. */
  shapes: BooleanShape[];
  /** Piezas despreciables que se descartaron de un objeto modificado. */
  discarded: number;
}

export interface BridgeOutcome {
  bridges: BridgeView[];
  validCount: number;
  /** Bridges PEDIDOS por el usuario que no son válidos: bloquean Apply (se quitan o se corrigen). */
  invalidCount: number;
  /** Sugerencias del servidor que no pudo resolver en un bridge válido (p. ej. una pieza sin hueco que cruzar): se informan, no bloquean. */
  unsuggested: BridgeView[];
  floatingBefore: number;
  floatingAfter: number;
  mainAfter: number;
  objects: BridgeObjectOutcome[];
  changedCount: number;
  pieceCount: number;
  discarded: number;
  /** Bridges válidos que no redujeron nada (la pieza ya queda conectada por otro). */
  notReducing: BridgeView[];
  /** Piezas flotantes sin ningún bridge válido: quedan flotando. */
  uncovered: FloatingIssue[];
}

/**
 * Lo que dice la respuesta del servidor para este plan: sirve igual para la previsualización y para aplicar (así lo que se ve es lo que se aplica). Una pieza con
 * área < tolerancia² se descarta e informa; si de un objeto modificado no queda ninguna pieza útil, el resultado es incoherente (nunca se borra un diseño). Una pieza
 * que no se pueda escribir como `d` válido invalida TODO el resultado.
 */
export function bridgeOutcome(plan: BridgePlan, response: BridgeResponse): { ok: true; outcome: BridgeOutcome } | { ok: false; error: string } {
  const invalid = validateBridgeResponse(plan.request, response);
  if (invalid) return { ok: false, error: `El servidor devolvió una respuesta incoherente (${invalid}). ${NOTHING_CHANGED}` };

  const { unit } = plan.analysisPlan;
  const names = plan.analysisPlan.names;
  const issueLabel = new Map(plan.analysis.issues.map((issue) => [issue.id, issue.label]));
  const bridges: BridgeView[] = [];
  for (const item of response.bridges) {
    const d = item.polygon ? pieceToPathData(item.polygon) : null;
    if (item.polygon && d === null) return { ok: false, error: `El servidor devolvió un bridge que no se puede dibujar. ${NOTHING_CHANGED}` };
    const affectsNames = item.affects.map((subject) => names[subject] ?? "Objeto");
    bridges.push({
      index: item.index,
      key: item.index < (plan.drafts?.length ?? 0) ? plan.drafts![item.index].key : null,
      suggested: item.suggested,
      valid: item.valid,
      reason: item.reason,
      reasonText: item.reason ? `${REASON_TEXT[item.reason]}${item.reason === "locked_subject" && affectsNames.length > 0 ? ` (${affectsNames.map((name) => `«${name}»`).join(", ")})` : ""}` : null,
      island: item.island,
      islandLabel: item.island !== null ? (issueLabel.get(item.island) ?? null) : null,
      anchor: item.anchor ? { x: item.anchor.x, y: item.anchor.y } : null,
      direction: item.direction ? { x: item.direction.x, y: item.direction.y } : null,
      length: item.length === null ? null : item.length * unit.factor,
      area: item.area === null ? null : item.area * unit.factor * unit.factor,
      reduces: item.reduces,
      affectsNames,
      d,
    });
  }

  const minArea = plan.request.tolerance * plan.request.tolerance;
  const objects: BridgeObjectOutcome[] = [];
  let discardedTotal = 0;
  for (let index = 0; index < plan.analysisPlan.objects.length; index += 1) {
    const object = plan.analysisPlan.objects[index];
    const locked = plan.request.subjects[index].locked;
    const result = response.results[index];
    if (!result.changed) {
      objects.push({ object, status: "unchanged", locked, shapes: [], discarded: 0 });
      continue;
    }
    const shapes: BooleanShape[] = [];
    let discarded = 0;
    for (const piece of result.geometries) {
      const d = pieceToPathData(piece);
      if (d === null) return { ok: false, error: `El servidor devolvió una pieza que no se puede dibujar. ${NOTHING_CHANGED}` };
      if (!(pieceArea(piece) >= minArea)) {
        discarded += 1;
        continue;
      }
      shapes.push({ d, matrix: IDENTITY_MATRIX });
    }
    if (shapes.length === 0) return { ok: false, error: `El servidor devolvió un resultado vacío para «${names[index] ?? "un objeto"}»: no se borra ningún diseño. ${NOTHING_CHANGED}` };
    discardedTotal += discarded;
    objects.push({ object, status: "changed", locked, shapes, discarded });
  }

  const coveredIslands = new Set(bridges.filter((bridge) => bridge.valid && bridge.island !== null).map((bridge) => bridge.island));
  return {
    ok: true,
    outcome: {
      bridges,
      validCount: bridges.filter((bridge) => bridge.valid).length,
      invalidCount: bridges.filter((bridge) => !bridge.valid && !bridge.suggested).length,
      unsuggested: bridges.filter((bridge) => !bridge.valid && bridge.suggested),
      floatingBefore: response.reanalysis.floatingBefore,
      floatingAfter: response.reanalysis.floatingAfter,
      mainAfter: response.reanalysis.mainAfter,
      objects,
      changedCount: objects.filter((entry) => entry.status === "changed").length,
      pieceCount: objects.reduce((total, entry) => total + entry.shapes.length, 0),
      discarded: discardedTotal,
      notReducing: bridges.filter((bridge) => bridge.valid && !bridge.reduces),
      uncovered: plan.analysis.issues.filter((issue) => !coveredIslands.has(issue.id)),
    },
  };
}

// ---- Textos del panel ----

/** «3 flotantes → 1»: lo que dice el reanálisis del resultado. */
export function reanalysisText(outcome: BridgeOutcome): string {
  const noun = (count: number) => (count === 1 ? "flotante" : "flotantes");
  return `${outcome.floatingBefore} ${noun(outcome.floatingBefore)} → ${outcome.floatingAfter}${outcome.floatingAfter === 0 ? " (ninguna pieza se cae)" : ""}`;
}

/** Texto de estado de una previsualización lista. */
export function bridgeReadyText(outcome: BridgeOutcome): string {
  const noun = (count: number) => plural(count, "bridge", "bridges");
  const bits = [
    `${noun(outcome.validCount + outcome.invalidCount)}: ${outcome.validCount} ${outcome.validCount === 1 ? "válido" : "válidos"}${outcome.invalidCount > 0 ? `, ${outcome.invalidCount} ${outcome.invalidCount === 1 ? "inválido" : "inválidos"}` : ""}.`,
  ];
  bits.push(`Resultado: ${reanalysisText(outcome)}.`);
  if (outcome.changedCount > 0) {
    bits.push(`${plural(outcome.changedCount, "objeto se modifica", "objetos se modifican")} (${plural(outcome.pieceCount, "pieza", "piezas")}), en su capa.`);
  }
  return bits.join(" ");
}

/**
 * Por qué NO se puede aplicar todavía (texto para el botón y el panel), o `null` si Apply está habilitado. Con CUALQUIER bridge inválido no se aplica: se quita o se
 * corrige (nada se omite en silencio).
 */
export function bridgeApplyBlock(outcome: BridgeOutcome | null): string | null {
  if (!outcome) return "Esperando el resultado del servidor…";
  if (outcome.invalidCount > 0) {
    return `${plural(outcome.invalidCount, "bridge es inválido", "bridges son inválidos")}: quitalo${outcome.invalidCount === 1 ? "" : "s"} o corregilo${outcome.invalidCount === 1 ? "" : "s"} antes de aplicar.`;
  }
  if (outcome.validCount === 0) return "No hay bridges para aplicar.";
  if (outcome.floatingAfter >= outcome.floatingBefore) return "Ningún bridge reduce las piezas flotantes: no hay nada que aplicar.";
  if (outcome.changedCount === 0) return "Los bridges no modifican ningún objeto.";
  return null;
}

export interface BridgeWarning {
  kind: "not_reducing" | "unsuggested" | "uncovered" | "locked" | "discarded" | "skipped" | "omitted";
  text: string;
}

/** Avisos que se muestran ANTES de confirmar: nada se omite en silencio. */
export function bridgeWarnings(plan: BridgePlan, outcome: BridgeOutcome): BridgeWarning[] {
  const warnings: BridgeWarning[] = [];
  const info = FLOATING_MODE_INFO[plan.analysisPlan.mode];
  if (outcome.notReducing.length > 0) {
    warnings.push({
      kind: "not_reducing",
      text: `${plural(outcome.notReducing.length, "bridge no reduce", "bridges no reducen")} nada: ${outcome.notReducing.length === 1 ? "su pieza ya queda conectada" : "sus piezas ya quedan conectadas"} por otro bridge.`,
    });
  }
  if (outcome.unsuggested.length > 0) {
    warnings.push({
      kind: "unsuggested",
      text: `No se pudo sugerir un bridge para ${outcome.unsuggested
        .map((bridge) => `${bridge.islandLabel ?? "una pieza"} (${bridge.reasonText})`)
        .join(", ")}. Colocalo a mano sobre su borde.`,
    });
  }
  if (outcome.uncovered.length > 0) {
    const shown = outcome.uncovered.slice(0, 6).map((issue) => issue.label);
    warnings.push({
      kind: "uncovered",
      text: `${plural(outcome.uncovered.length, `${info.noun} sin bridge`, `${info.nounPlural} sin bridge`)}: ${shown.join(", ")}${outcome.uncovered.length > 6 ? ` y ${outcome.uncovered.length - 6} más` : ""}. ${outcome.uncovered.length === 1 ? "Queda" : "Quedan"} flotando.`,
    });
  }
  const { scope } = plan.analysisPlan;
  if (scope.lockedCount > 0) {
    warnings.push({ kind: "locked", text: `${plural(scope.lockedCount, "objeto en una capa bloqueada cuenta", "objetos en capas bloqueadas cuentan")} para el análisis y no se ${scope.lockedCount === 1 ? "modifica" : "modifican"}.` });
  }
  if (outcome.discarded > 0) warnings.push({ kind: "discarded", text: `${plural(outcome.discarded, "pieza despreciable descartada", "piezas despreciables descartadas")}.` });
  if (plan.analysisPlan.skippedInvalid > 0) {
    warnings.push({ kind: "skipped", text: `${plural(plan.analysisPlan.skippedInvalid, "objeto no se pudo procesar", "objetos no se pudieron procesar")} y se omite.` });
  }
  const omitted = scope.hiddenOmitted + scope.unfilledOmitted;
  if (omitted > 0) warnings.push({ kind: "omitted", text: `${plural(omitted, "objeto oculto o sin relleno no se analiza", "objetos ocultos o sin relleno no se analizan")}.` });
  return warnings;
}

// ---- Aplicar ----

export interface BridgeSummary {
  mode: FloatingMode;
  bridgeCount: number;
  floatingBefore: number;
  floatingAfter: number;
  changedCount: number;
  pieceCount: number;
  lockedCount: number;
  discarded: number;
  widthMm: number;
  unit: UnitScale;
}

export type BridgeApplicationCode = "nothing_to_apply" | "invalid_bridges" | "stale" | "blocked" | "invalid_response";

export type BridgeApplication =
  | { ok: true; production: EditProduction; summary: BridgeSummary; resultIds: string[]; activeGroupId: string }
  | { ok: false; code: BridgeApplicationCode; error: string };

function defaultCreateId(): string {
  return crypto.randomUUID();
}

/**
 * Convierte la respuesta del servidor en UN comando (`EditProduction` atómica). Todo o nada:
 * - la respuesta debe corresponder a la petición (`bridgeOutcome`) y los objetos deben seguir siendo los mismos (por referencia): si el documento cambió mientras se
 *   calculaba, el resultado ya no lo describe y se descarta;
 * - con CUALQUIER bridge inválido no se aplica (el usuario lo quita o lo corrige); sin bridges válidos que reduzcan no hay nada que aplicar;
 * - si una capa de un objeto modificado se bloqueó u ocultó mientras tanto, se rechaza (un objeto bloqueado NUNCA se modifica).
 * Cada pieza es un objeto nuevo (id nuevo, sin matriz, mismo `fill`/`stroke` y MISMA capa que su original) y ocupa el lugar del original en el orden de pintado. Un
 * objeto que no cambia conserva su `d`, su matriz y su id.
 */
export function applyBridgeResult(plan: BridgePlan, state: EditableDocument, response: BridgeResponse, options: { createId?: () => string } = {}): BridgeApplication {
  const createId = options.createId ?? defaultCreateId;
  const outcomeResult = bridgeOutcome(plan, response);
  if (!outcomeResult.ok) return { ok: false, code: "invalid_response", error: outcomeResult.error };
  const { outcome } = outcomeResult;
  if (outcome.invalidCount > 0) {
    return { ok: false, code: "invalid_bridges", error: `${bridgeApplyBlock(outcome)} ${NOTHING_CHANGED}` };
  }
  const block = bridgeApplyBlock(outcome);
  if (block !== null) return { ok: false, code: "nothing_to_apply", error: `${block} ${NOTHING_CHANGED}` };

  for (const object of plan.analysisPlan.objects) {
    if (!(state.objectsByLayer[object.layerGroupId] ?? []).includes(object)) {
      return { ok: false, code: "stale", error: `El documento cambió desde el análisis. ${NOTHING_CHANGED} Volvé a analizar.` };
    }
  }
  const layers = state.layers ?? [];
  const changing = outcome.objects.filter((entry) => entry.status === "changed");
  for (const entry of changing) {
    const layer = layers.find((candidate) => candidate.groupId === entry.object.layerGroupId);
    if (entry.locked || (layer && (layer.locked || !layer.visible))) {
      return { ok: false, code: "blocked", error: `La capa «${layer?.name ?? "del objeto"}» está ${layer?.visible === false ? "oculta" : "bloqueada"}: no se puede modificar. Corregilo en el panel de Capas. ${NOTHING_CHANGED}` };
    }
  }

  const replacements = new Map<string, EditorObject[]>();
  const resultIds: string[] = [];
  for (const entry of changing) {
    const original = entry.object;
    const scale = matrixScale(original.matrix);
    replacements.set(
      original.id,
      entry.shapes.map((shape): EditorObject => {
        const id = createId();
        resultIds.push(id);
        return {
          ...original,
          id,
          d: shape.d,
          matrix: shape.matrix,
          ...(original.stroke !== undefined && original.strokeWidth !== undefined ? { strokeWidth: original.strokeWidth * scale } : {}),
        };
      }),
    );
  }

  const layersOut: Record<string, EditorObject[]> = {};
  for (const groupId of new Set(changing.map((entry) => entry.object.layerGroupId))) {
    // Las piezas ocupan el LUGAR del original (mismo orden de pintado).
    layersOut[groupId] = (state.objectsByLayer[groupId] ?? []).flatMap((object) => replacements.get(object.id) ?? [object]);
  }

  return {
    ok: true,
    production: { layers: layersOut, atomic: true },
    resultIds,
    activeGroupId: changing[0].object.layerGroupId,
    summary: {
      mode: plan.analysisPlan.mode,
      bridgeCount: outcome.validCount,
      floatingBefore: outcome.floatingBefore,
      floatingAfter: outcome.floatingAfter,
      changedCount: outcome.changedCount,
      pieceCount: outcome.pieceCount,
      lockedCount: plan.analysisPlan.scope.lockedCount,
      discarded: outcome.discarded,
      widthMm: plan.widthMm,
      unit: plan.analysisPlan.unit,
    },
  };
}

// ---- Textos ----

/** Etiqueta del comando (Deshacer/Rehacer). */
export function bridgeLabel(summary: BridgeSummary): string {
  return `Bridges: ${plural(summary.bridgeCount, "bridge", "bridges")} de ${formatPanelValue(summary.widthMm, summary.unit)} (${summary.floatingBefore} → ${summary.floatingAfter} flotantes)`;
}

/** Confirmación para el usuario tras aplicar: dice qué se hizo y qué NO se pudo hacer. */
export function bridgeNotice(summary: BridgeSummary): string {
  const parts = [
    `Se aplicaron ${plural(summary.bridgeCount, "bridge", "bridges")} de ${formatPanelValue(summary.widthMm, summary.unit)}: ${summary.floatingBefore} flotantes → ${summary.floatingAfter}. ${plural(summary.changedCount, "objeto modificado", "objetos modificados")} (${plural(summary.pieceCount, "pieza", "piezas")}), en su capa.`,
  ];
  if (summary.floatingAfter > 0) parts.push(`${plural(summary.floatingAfter, "pieza sigue flotando", "piezas siguen flotando")}.`);
  if (summary.lockedCount > 0) parts.push(`${plural(summary.lockedCount, "objeto bloqueado no se modificó", "objetos bloqueados no se modificaron")}.`);
  if (summary.discarded > 0) parts.push(`${plural(summary.discarded, "pieza despreciable descartada", "piezas despreciables descartadas")}.`);
  return parts.join(" ");
}

// ---- Errores del servidor, en lenguaje de usuario ----

const FLOATING_ERROR_MESSAGES: Record<string, string> = {
  unknown_floating_mode: `El servidor no reconoce ese modo de análisis. ${NOTHING_CHANGED}`,
  invalid_bridge: `El servidor rechazó un bridge (necesita una pieza o un punto sobre su borde). ${NOTHING_CHANGED}`,
  invalid_bridge_width: `El servidor rechazó el ancho de un bridge. ${NOTHING_CHANGED}`,
  too_many_bridges: `Hay demasiados bridges. ${NOTHING_CHANGED} Quitá algunos.`,
  timeout: `El cálculo tardó demasiado y se canceló. ${NOTHING_CHANGED} Probá con menos objetos.`,
  too_many_subjects: `Hay demasiados objetos para analizarlos juntos. ${NOTHING_CHANGED} Seleccioná menos objetos.`,
  too_many_vertices: `La geometría a analizar es demasiado grande para calcularla. ${NOTHING_CHANGED} Probá con menos objetos.`,
  payload_too_large: `La geometría a analizar es demasiado grande para calcularla. ${NOTHING_CHANGED} Probá con menos objetos.`,
};

/** Mensaje para el usuario ante un fallo del servicio de geometría durante el análisis o los bridges: siempre dice que NO se modificó nada y, si se puede, qué hacer. */
export function floatingErrorMessage(error: unknown): string {
  const candidate = (typeof error === "object" && error !== null ? error : {}) as { isAborted?: boolean; isNetworkError?: boolean; status?: number; body?: unknown };
  const code = (candidate.body as { code?: unknown } | undefined)?.code;
  if (!candidate.isAborted && !candidate.isNetworkError && typeof code === "string" && code in FLOATING_ERROR_MESSAGES) return FLOATING_ERROR_MESSAGES[code];
  if (!candidate.isAborted && !candidate.isNetworkError && !code) {
    if (candidate.status === 413) return FLOATING_ERROR_MESSAGES.payload_too_large;
    if (candidate.status === 504) return FLOATING_ERROR_MESSAGES.timeout;
  }
  return geometryErrorMessage(error);
}
