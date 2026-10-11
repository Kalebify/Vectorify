using Vectorify.Api.Geometry;

namespace Vectorify.Api.Clients;

/// <summary>
/// Cliente tipado hacia el servicio de geometría (POST /api/v1/geometry/boolean, /offset y /split) del motor Python/FastAPI (M3-S04, M3-S09, M3-S10).
/// Mismo patrón que IPythonCheckClient: cada etapa tiene su propio cliente con su propio timeout.
/// </summary>
public interface IPythonGeometryClient
{
    /// <summary>
    /// Envía los parámetros YA validados. Nunca lanza excepciones: cualquier falla (offline, timeout, petición rechazada,
    /// respuesta inválida, error HTTP) se traduce a un <see cref="PythonGeometryResult"/> con el estado correspondiente.
    /// </summary>
    Task<PythonGeometryResult> BooleanAsync(GeometryBooleanParameters parameters, CancellationToken cancellationToken = default);

    /// <summary>Igual que <see cref="BooleanAsync"/> para el offset (M3-S09): nunca lanza y revalida la respuesta contra LA petición.</summary>
    Task<PythonGeometryOffsetResult> OffsetAsync(GeometryOffsetParameters parameters, CancellationToken cancellationToken = default);

    /// <summary>Igual que <see cref="BooleanAsync"/> para el corte (M3-S10): nunca lanza y revalida la respuesta contra LA petición.</summary>
    Task<PythonGeometrySplitResult> SplitAsync(GeometrySplitParameters parameters, CancellationToken cancellationToken = default);
}
