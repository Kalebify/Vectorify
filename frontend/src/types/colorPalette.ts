/**
 * Contratos tipados que expone ASP.NET Core para la detección/reducción de
 * paleta de colores (M2-S01): POST .../color-palette/detect, .../merge,
 * .../unmerge, .../rename, .../confirm, GET .../color-palette/{paletteId}.
 * Deben reflejar exactamente Vectorify.Api.Contracts.ColorPaletteResponse/
 * ColorGroupPayload/*Request del backend.
 */

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface ColorGroupPayload {
  groupId: string;
  name: string;
  colorHex: string;
  /** M2.1-S02: mismo color que colorHex, ya descompuesto en componentes RGB (aditivo). */
  rgb: RgbColor;
  pixelCount: number;
  areaPercent: number;
  hasPartialAlpha: boolean;
  /**
   * M2.1-S02 (NUEVO): incluido (false)/excluido (true), independiente de un merge. El fondo
   * dominante detectado automáticamente viene pre-marcado en true en la primera detección, pero
   * es solo una sugerencia -- el usuario puede cambiarlo en cualquier momento (ver
   * ColorSwatchList, toggle "Incluir en el corte"/"Excluir del corte").
   */
  isExcluded: boolean;
  maskUrl: string;
  /** true si este grupo proviene de un merge (habilita "deshacer fusión" en el panel). */
  isMerged: boolean;
  /**
   * Estilo "Colores base": grupo técnico de fondo (máscara independiente del color). No cuenta como
   * familia del dibujo y viene excluido por defecto. Opcional: una API anterior no lo envía (= false).
   */
  isBackground?: boolean;
  /** Piezas (componentes conexos) de la máscara: una capa puede tener varias sin ser una capa duplicada. */
  pieceCount?: number;
  /** Cuántos tonos detallados se reunieron en este grupo (1 en el estilo detallado). */
  sourceGroupCount?: number;
}

/**
 * Estilo de agrupación de la paleta: `base_colors` reúne luces y sombras de una misma familia en una
 * capa por familia; `detailed` ("Conservar tonos y sombras") mantiene cada tono detectado.
 */
export type GroupingStyle = "base_colors" | "detailed";

/**
 * Qué se considera fondo (estilo `base_colors`) y qué quedó en duda. `needsReview` pide revisión
 * humana (claros pegados al fondo que el color no distingue): nunca es una aprobación.
 */
export interface PaletteBackground {
  areaPercent: number;
  ambiguousPercent: number;
  contactPercent: number;
  needsReview: boolean;
}

/** Respuesta de todas las operaciones de paleta: siempre la última versión vigente de la sesión. */
export interface ColorPaletteResponse {
  projectId: string;
  imageId: string;
  paletteId: string;
  version: number;
  tolerance: number;
  maxColors: number | null;
  /** M2.1-S02: umbral de "grupo diminuto" que atacó la explosión de colores por antialiasing. */
  tinyAreaRatio: number;
  sourceWidthPx: number;
  sourceHeightPx: number;
  transparentPercent: number;
  groups: ColorGroupPayload[];
  previewUrl: string;
  isConfirmed: boolean;
  cached: boolean;
  /** Ausente en respuestas anteriores a la agrupación por familias: se interpreta como `detailed`. */
  groupingStyle?: GroupingStyle;
  /** Tope de familias solicitado (solo `base_colors`); null = automático. */
  targetFamilies?: number | null;
  groupingStrength?: number;
  /** Versión del algoritmo con el que se generó la paleta (0/ausente = anterior a la versión). */
  algorithmVersion?: number;
  familyCount?: number;
  pieceCount?: number;
  background?: PaletteBackground | null;
}

/**
 * Code es estable y se mapea a copy en React sin parsear message. Valores que
 * pueden devolver los endpoints de paleta de colores.
 */
export type ColorPaletteErrorCode =
  | "invalid_parameters"
  | "not_found"
  | "group_not_found"
  | "palette_confirmed"
  | "not_merged"
  | "empty_palette"
  | "corrupt_image"
  | "dimensions_exceeded"
  | "timeout"
  | "engine_unavailable"
  | "invalid_response"
  | "processing_error"
  | "storage_failure"
  | "internal_error"
  | "network_error";
