namespace Vectorify.Api.ColorPalette;

/// <summary>
/// Qué se considera fondo en una paleta de estilo <c>base_colors</c> y qué quedó en duda
/// (espejo de BackgroundPayload del motor Python). <see cref="NeedsReview"/> es evidencia para
/// revisión humana -- hay claros/blancos pegados al fondo que el color por sí solo no distingue
/// --, nunca una aprobación: el usuario puede incluir o excluir el grupo técnico de fondo.
/// </summary>
public sealed record BackgroundInfo(double AreaPercent, double AmbiguousPercent, double ContactPercent, bool NeedsReview);
