using Vectorify.Api.Geometry;

namespace Vectorify.Api.Clients;

/// <summary>
/// Cliente tipado hacia el servicio de geometría (POST /api/v1/geometry/boolean y /offset) del motor Python/FastAPI (M3-S04, M3-S09).
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
}
