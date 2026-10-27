namespace Vectorify.Api.ColorPalette;

/// <summary>
/// Una versión guardada de una sesión de paleta de colores para una imagen
/// (M2-S01): historial inmutable, igual patrón que VectorVersion/
/// SimplificationVersion/DimensionVersion -- ninguna operación (detectar,
/// fusionar, deshacer fusión, renombrar, confirmar) muta una versión
/// existente, cada una crea la SIGUIENTE (Version+1) bajo el mismo
/// <see cref="PaletteId"/> (identidad estable de la sesión de edición
/// completa, desde la primera detección hasta la confirmación).
///
/// A diferencia de Simplification/Threshold/Vectorization (donde el "cache"
/// memoiza el resultado de una llamada costosa a Python contra una clave de
/// parámetros), acá el cache+lock+versionado se aplica LITERALMENTE igual
/// que los precedentes solo a <see cref="Vectorify.Api.ColorPalette.ColorPaletteService.DetectAsync"/>
/// (la única operación que llama a Python): misma imagen + mismos
/// <see cref="DetectionParameters"/> -> cache-hit reutiliza los grupos
/// crudos ya detectados pero siempre avanza <see cref="Version"/> (nunca
/// retrocede). Merge/Unmerge/Rename/Confirm son ediciones de metadata puras
/// sobre la ÚLTIMA versión del <see cref="PaletteId"/> dado (sin una
/// "llamada costosa" que memoizar): igual preservan el principio de
/// versionado inmutable (cada una crea una fila nueva), pero se serializan
/// con un lock por <see cref="PaletteId"/> en vez de una clave de caché --
/// ver Vectorify.Api.ColorPalette.ColorPaletteService para el detalle,
/// documentado también en el reporte del sprint.
/// </summary>
public sealed record ColorPaletteVersion(
    Guid ProjectId,
    Guid ImageId,
    int Version,
    Guid PaletteId,
    ColorPaletteParameters DetectionParameters,
    IReadOnlyList<ColorGroup> Groups,
    double TransparentPercent,
    int SourceWidthPx,
    int SourceHeightPx,
    string QuantizedPreviewStorageKey,
    bool IsConfirmed,
    DateTimeOffset CreatedAt,
    BackgroundInfo? Background = null);
