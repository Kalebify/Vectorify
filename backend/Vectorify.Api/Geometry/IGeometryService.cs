using Vectorify.Api.Contracts;

namespace Vectorify.Api.Geometry;

/// <summary>
/// Orquesta el servicio de geometría del editor (M3-S04, ADR D4): valida la petición y delega la operación
/// (booleana M3-S04/S08, offset M3-S09) en el motor Python (Shapely). Sin estado, sin acceso a datos y sin <c>IUserContext</c>: recibe
/// coordenadas y devuelve coordenadas, no hay nada del usuario que proteger ni versionar.
/// </summary>
public interface IGeometryService
{
    Task<GeometryBooleanResult> BooleanAsync(GeometryBooleanRequest? request, CancellationToken cancellationToken);

    Task<GeometryOffsetResult> OffsetAsync(GeometryOffsetRequest? request, CancellationToken cancellationToken);
}
