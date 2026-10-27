namespace Vectorify.Api.Contracts;

/// <summary>
/// Cuerpo JSON de POST .../color-palette/detect. Si <see cref="PaletteId"/>
/// es null, arranca una sesión de paleta nueva (primera detección sobre esta
/// imagen); si se informa, debe referenciar una sesión YA existente y NO
/// confirmada para esta imagen -- re-detecta con los parámetros dados bajo
/// el MISMO PaletteId (descartando cualquier merge/rename previo: vuelve a
/// los grupos crudos que detecta Python), mismo criterio de "un ID de
/// recurso de origen en el body" que el resto del pipeline.
/// Tolerance/MaxColors/TinyAreaRatio son opcionales: si se omiten, se usan
/// los defaults configurados (Vectorify.Api.Options.ColorPaletteOptions).
/// TinyAreaRatio (M2.1-S02) es el umbral de "grupo diminuto" que ataca la
/// explosión de colores por antialiasing (ver ColorPaletteParameters) -- la
/// mayoría de los usuarios nunca necesita tocarlo, el default ya lo resuelve.
///
/// Agrupación por familias: <see cref="GroupingStyle"/> ("detailed" -- valor por defecto si se omite --
/// o "base_colors"), <see cref="TargetFamilies"/> (tope de familias, solo base_colors; null =
/// automático) y <see cref="GroupingStrength"/> (0-1, solo base_colors). En "detailed" los dos
/// últimos se ignoran; en "base_colors" se ignora <see cref="MaxColors"/>.
/// </summary>
public sealed record ColorPaletteDetectRequest(
    Guid? PaletteId,
    double? Tolerance,
    int? MaxColors,
    double? TinyAreaRatio = null,
    string? GroupingStyle = null,
    int? TargetFamilies = null,
    double? GroupingStrength = null);
