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
}
