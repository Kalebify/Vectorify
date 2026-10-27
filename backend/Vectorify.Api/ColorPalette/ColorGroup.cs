namespace Vectorify.Api.ColorPalette;

/// <summary>
/// Un color/grupo dentro de una <see cref="ColorPaletteVersion"/>: color
/// representativo, área aproximada, y una máscara persistida (PNG 0/255,
/// mismas dimensiones que la imagen de origen) recuperable vía
/// <see cref="MaskStorageKey"/>. <see cref="RawGroupIds"/> son los índices
/// 0-based que Python asignó a los clusters detectados originalmente (ver
/// app.core.color_palette_pipeline) que integran este grupo -- estables
/// durante toda la sesión de detección, se usan para recomponer la máscara
/// combinada tras un merge sin volver a llamar a Python.
///
/// <see cref="MergedFrom"/> es la snapshot de los grupos EXACTOS (tal cual
/// estaban, con su propio MergedFrom anidado si correspondía) que se
/// fusionaron para crear este grupo -- null/vacío si es un grupo tal cual lo
/// detectó Python, nunca fusionado. Permite deshacer un merge (unmerge)
/// restaurando esos grupos sin tener que recalcular nada, y encadenar varios
/// niveles de unmerge si hubo merges sucesivos (ver
/// Vectorify.Api.ColorPalette.ColorPaletteService.UnmergeAsync).
///
/// <see cref="IsExcluded"/> (M2.1-S02, NUEVO): estado incluido/excluido del
/// grupo, INDEPENDIENTE de un merge -- un color puede excluirse sin
/// fusionarlo a otro grupo. En la primera detección, se PRE-marca en true
/// para el grupo de mayor área que además toque la mayoría del perímetro de
/// la imagen (heurística de "fondo dominante", ver
/// Vectorify.Api.ColorPalette.ColorPaletteService.DetectAsync y
/// app.core.color_palette_pipeline.ColorGroup.touches_border) -- pero es
/// solo una sugerencia inicial: el usuario puede cambiarlo en cualquier
/// momento vía <see cref="Vectorify.Api.ColorPalette.ColorPaletteService.SetExclusionAsync"/>,
/// y esa elección se preserva versión a versión (rename/exclude no generan
/// un GroupId nuevo). Para ESTA tarjeta alcanza con persistir y exponer el
/// flag correctamente -- la exclusión EFECTIVA aguas abajo (que M2-S03 no
/// tenga en cuenta un grupo excluido al generar capas) es responsabilidad de
/// esa tarjeta, no de esta.
///
/// Agrupación por familias (estilo <c>base_colors</c>): <see cref="IsBackground"/> marca el grupo
/// técnico de fondo (máscara independiente del color: no cuenta como familia del dibujo y se
/// pre-excluye; el usuario puede incluirlo), <see cref="PieceCount"/> las piezas (componentes
/// conexos) de la máscara -- una capa puede tener varias sin ser una capa duplicada -- y
/// <see cref="SourceGroupCount"/> cuántos tonos detallados se reunieron en el grupo. Los tres
/// tienen un valor por defecto para que los sidecars anteriores se rehidraten sin cambios.
/// </summary>
public sealed record ColorGroup(
    Guid GroupId,
    string Name,
    string ColorHex,
    long PixelCount,
    double AreaPercent,
    bool HasPartialAlpha,
    bool IsExcluded,
    IReadOnlyList<int> RawGroupIds,
    string MaskStorageKey,
    IReadOnlyList<ColorGroup>? MergedFrom,
    bool IsBackground = false,
    int PieceCount = 0,
    int SourceGroupCount = 1);
