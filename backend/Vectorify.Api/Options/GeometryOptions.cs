namespace Vectorify.Api.Options;

/// <summary>
/// Configuración del servicio de geometría del editor (M3-S04, ADR D4 de docs/ADR_EDITOR_MVP3.md):
/// timeout HTTP hacia el motor Python y los límites de entrada de POST /api/v2/geometry/boolean. Los
/// topes de subjects (500) y vértices (500 000) los fija spec.md; el resto son supuestos documentados
/// en el IMPL del sprint. Se espejan 1:1 en app.core.config.Settings del motor Python (que vuelve a
/// validarlos: Vectorify.Api nunca es la única barrera). Se enlaza desde la sección "Geometry".
/// </summary>
public sealed class GeometryOptions
{
    public const string SectionName = "Geometry";

    /// <summary>
    /// Mayor que el presupuesto interno de Python (geometry_timeout_seconds = 15) para que el error tipado de Python llegue
    /// antes que el corte del cliente HTTP -- mismo criterio que Vectorize/PhysicalUnion.
    /// </summary>
    public int TimeoutSeconds { get; set; } = 20;

    public int MaxSubjects { get; set; } = 500;
    public int MaxOperands { get; set; } = 500;

    /// <summary>Vértices en total entre subjects y operands (un bufferedLine cuenta sus puntos).</summary>
    public int MaxVertices { get; set; } = 500_000;

    /// <summary>Tolerancia máxima aceptada (unidades de documento): una tolerancia absurda descartaría toda la geometría.</summary>
    public double MaxTolerance { get; set; } = 1_000_000;

    /// <summary>Valor absoluto máximo de una coordenada o de un radio (unidades de documento): evita desbordes al operar.</summary>
    public double MaxCoordinateMagnitude { get; set; } = 1_000_000_000;

    /// <summary>Tamaño máximo del cuerpo de la petición; mayor ⇒ 413 sin parsearlo.</summary>
    public long MaxRequestBodyBytes { get; set; } = 32_000_000;

    /// <summary>
    /// Offset (M3-S09): valor absoluto máximo de la distancia (unidades de documento; el editor aplica además su propio tope en mm).
    /// Una distancia 0 o por encima de este tope ⇒ 400 <c>invalid_distance</c>. Espejo de <c>max_geometry_offset_distance</c> del motor.
    /// </summary>
    public double MaxOffsetDistance { get; set; } = 1_000_000;

    /// <summary>Offset (M3-S09): límite de inglete máximo (razón largo del inglete / distancia); ≤ 0 o mayor ⇒ 400 <c>invalid_mitre_limit</c>.</summary>
    public double MaxMitreLimit { get; set; } = 100;

    /// <summary>
    /// Corte (M3-S10): máximo de puntos de la línea de corte (cuentan además en <see cref="MaxVertices"/>); mayor ⇒ 400 <c>too_many_cutter_points</c>.
    /// Espejo de <c>max_geometry_cutter_points</c> del motor. El ancho de la ranura se acota con <see cref="MaxOffsetDistance"/>.
    /// </summary>
    public int MaxCutterPoints { get; set; } = 10_000;

    /// <summary>
    /// Bridges (M3-S11): máximo de bridges por petición (cada uno re-analiza la geometría para validarse); mayor ⇒ 400 <c>too_many_bridges</c>.
    /// Espejo de <c>max_geometry_bridges</c> del motor. El ancho y el largo de un bridge se acotan con <see cref="MaxOffsetDistance"/>.
    /// </summary>
    public int MaxBridges { get; set; } = 200;
}
